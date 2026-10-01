# HTTP API (v1)

This fork adds a local, single-machine API to Dockge 1.5.0. The existing web UI
and Socket.IO/Agent protocol remain available. Remote Agent addressing, arbitrary
commands, interactive terminals and per-service actions are
not part of this API.

The machine-readable contract is [openapi.yaml](openapi.yaml). API routes are on
Dockge's existing port under `/api/v1`; no additional listener is needed.

## Interactive documentation

Open **Settings → API Keys → API documentation**, or visit `/api/docs/`. Swagger UI
renders the same OpenAPI definition shipped in this repository. Download it from
`/api/openapi.yaml`. The reference is public; it contains no instance data.

Use **Authorize** to enter a key (without the `Bearer ` prefix) before trying a
request. Calls target the current Dockge instance and use the key’s normal
permissions. The key is kept in memory only, not browser storage. JavaScript and
CSS are bundled locally; the page does not use a CDN or an external validator.
For streaming logs, use `curl -N`; use `follow=false` in Swagger UI.

The UI is generated from OpenAPI, not inferred from Express implementation. Keep
the definition synchronized with interface changes; tests check that documented
operations cover the implemented API routes.

## API Keys

Open **Settings → API Keys**. Create a named key, choose its permission and optional
expiry, then copy it immediately. The full secret is displayed only once and is
not recoverable; the database stores a SHA-256 digest. Multiple keys can be
created and independently revoked. Revocation does not cancel accepted tasks.

| Permission | Access |
| --- | --- |
| `read` | Stack/service status, resource statistics, metrics, application logs, all operation results/logs |
| `operate` | Read plus start, stop, restart, pull and update |
| `manage` | Operate plus configuration read/write, create, deploy, down and delete |

Configuration includes `.env` and requires `manage`. Application and execution
logs can contain sensitive application output; `read` does not mean logs are
redacted. Keys apply to all local managed Stacks. They cannot manage other keys.

Every request requires `Authorization: Bearer dg_...`, including when web
authentication is disabled. In that mode the key-management page requires the
administrator password. Keys are not accepted in URLs, cookies or query strings.
Use HTTPS when connecting over an untrusted network.

## Live container resources

Managed local Stack pages show CPU, memory, network, block I/O and PIDs in each
container's existing row. Values refresh approximately every two seconds. Editing
and remote Agent views retain their existing controls.

`GET /api/v1/containers/stats` returns the latest snapshot for all local Docker
containers, including containers outside managed Stacks. `GET
/api/v1/stacks/{name}/stats` filters by managed Stack. Both require `read` or higher
permission. Containers are identified by Docker ID and Compose labels, including
replicas and custom container/project names. Unsupported values, stopped
containers and failed or stale samples have `null` values or `available: false`.
The first sample has no network/block I/O rate until a second sample arrives.

The collector keeps only the current snapshot and the previous counters needed
to calculate rates in memory. There is no history, chart or statistics database.
UI, JSON requests and exporter scrapes share the same collector; opening more
browsers does not create more Docker sampling loops. Samples older than ten
seconds are unavailable. Docker Engine API 1.41 or newer is required; an optional
`DOCKGE_DOCKER_SOCKET` overrides the default `/var/run/docker.sock` path.

See [metrics and VictoriaMetrics integration](metrics.md) for the authenticated
`GET /metrics` exporter endpoint, metric names and scrape examples.

## Update an existing Stack

Set `DOCKGE_URL` to your Dockge address (for example `http://localhost:5001`) and
`DOCKGE_API_KEY` to a key with `operate` or `manage` permission.

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $DOCKGE_API_KEY" \
  -H 'Idempotency-Key: nginx-update-2026-09-27' \
  "$DOCKGE_URL/api/v1/stacks/nginx/actions/update"
```

Example response (`202 Accepted`, with `Location` pointing to the operation):

```json
{"operation_id":"d7d438be-033e-41ec-86c6-2b58fe71bf79","url":"/api/v1/operations/d7d438be-033e-41ec-86c6-2b58fe71bf79","state":"running"}
```

Query that operation until its state is `succeeded`, `failed` or `interrupted`:

```sh
curl --fail-with-body -H "Authorization: Bearer $DOCKGE_API_KEY" \
  "$DOCKGE_URL/api/v1/operations/$OPERATION_ID"
curl --fail-with-body -N -H "Authorization: Bearer $DOCKGE_API_KEY" \
  "$DOCKGE_URL/api/v1/operations/$OPERATION_ID/logs?follow=true"
```

`update` runs `docker compose pull`, then `up -d --remove-orphans` only when the
Stack is running. A stopped Stack stays stopped. It uses image tags already in
your Compose file; it does not choose a new tag or rewrite configuration. To
change a pinned tag, replace the configuration and then call `deploy`.
`restart` alone does not pull images or recreate containers with new images.

## Create, configure and deploy

Both `composeYAML` and `composeENV` are required text fields. Empty `composeENV`
clears `.env`. YAML comments and literal text are preserved. Each JSON request
is limited to 1 MiB. Names use 1–200 lowercase letters, digits, `_` or `-` and
must also be acceptable to Docker Compose.

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $DOCKGE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"name":"nginx","composeYAML":"services:\n  web:\n    image: nginx:stable\n","composeENV":""}' \
  "$DOCKGE_URL/api/v1/stacks"
```

Creation only saves files. `GET /stacks/nginx/config` reads them and
`PUT /stacks/nginx/config` replaces both fields without deploying. Submit
`POST /stacks/nginx/actions/deploy` to apply the configuration. If deployment
fails, the configuration stays saved and the operation retains the failure log;
there is no automatic rollback.

| Action | Behavior |
| --- | --- |
| `start` / `deploy` | `compose up -d --remove-orphans` |
| `stop` | Stop containers, keeping them and configuration |
| `restart` | Restart existing containers |
| `pull` | Pull configured images, without starting/recreating containers |
| `update` | Pull, then redeploy if currently running |
| `down` | Remove containers/networks; retain Stack files; no `--volumes` |
| `DELETE /stacks/{name}` | Down with `--remove-orphans`, then recursively delete the Stack directory |

**Delete retains the original Dockge behavior: application data located inside
the Stack directory is deleted too.** Named Docker volumes are not explicitly
removed. If `compose down` fails, file deletion does not proceed.

Only Stacks inside the configured stacks directory can be modified or have
configuration/logs read. Stack directories and configuration files cannot be
symbolic links; configuration hard links are rejected. External Compose projects
may appear in the status list but are not adopted by the API.

## Status, logs and tasks

- `GET /stacks` lists local Stacks. `GET /stacks/{name}` adds service status and
  never includes Compose or `.env` contents. Stack status codes are `0` unknown,
  `1` configuration saved, `2` containers created, `3` running and `4` exited.
- `GET /stacks/{name}/logs?tail=100&service=web` reads application logs; `service`
  is optional. Tail is capped at 5,000 lines per service and JSON output at 1 MiB.
- Add `follow=true` for SSE. `log` events contain JSON `{text}`; `end`/`error`
  close the stream. Disconnecting stops only the log reader.
- Operation logs contain deployment/pull output, not application logs. They use
  byte `offset` and `limit` pagination with `next_offset`, or SSE with
  `log`, `heartbeat`, `end` and `error` events. PTY output can contain ANSI codes.
- `GET /operations?stack=nginx&limit=50&offset=0` returns newest tasks first,
  with a nullable `next_offset`. All readable tasks are visible to every key
  with `read` or higher permission. Timestamps are Unix milliseconds.
- HTTP disconnection does not cancel an accepted operation. The Stack is locked
  for the entire action, including both phases of `update`. Concurrent web/API
  writes return a busy error instead of queueing. Different Stacks can run in parallel.
- Actions and deletion accept `Idempotency-Key`. Retries with the same API Key,
  idempotency key, Stack and action return the original operation. Reusing the
  key for a different action/Stack returns `409`. Retry with a new key only when
  a new execution is intended; no request body is used by action endpoints.
- Completed operations, logs and idempotency records are kept for 7 days and
  cleaned hourly. Each execution log is capped at 10 MiB, with `truncated` set
  when output exceeds the limit. Commands continue after the log limit is reached.
- On restart, unfinished records become `interrupted`; Dockge does not replay
  them. Inspect current container state before retrying. This state does not
  imply that Docker rolled back a partially completed action.
- Active SSE readers recheck expiry/revocation: every second for task logs and
  every 10 seconds for application logs.

Errors use `{"error":{"code":"stack_busy","message":"..."}}`. Important
statuses: `400` invalid input, `401` missing/invalid key, `403` insufficient
permission, `404` not found, `409` conflict, `413` oversized JSON, `500` server
failure, `502` Docker log failure, `503` shutdown. A `202` means accepted,
not successful; check the operation's `state`, `exit_code` and `error`.

## Upgrade and validation

For the installed server and one-command upgrades/rollback, see [deployment.md](deployment.md).

Build this fork with `npm ci && npm run build:frontend`, then use the existing
Dockerfile or `npm start`. Preserve the existing data and stacks mounts.
Startup adds `api_key` and `api_operation` tables through Dockge's normal
migration mechanism; existing Stack files and users are not migrated. Logs live
under `<dataDir>/operation-logs`. Back up the data directory before upgrading;
rolling back across a database migration should restore its matching backup.

```sh
npm test
npm run lint
npm run check-ts
npm run build:frontend
# Opt-in real Docker test; uses a unique test Stack and removes it afterward.
# Requires preloaded alpine:latest, or DOCKGE_TEST_IMAGE set to a compatible image digest.
npm run test:docker
```

The Docker test does not retag existing images or operate on existing Stacks.
This repository's existing release scripts still target upstream image names;
use your own image name when publishing this fork.
