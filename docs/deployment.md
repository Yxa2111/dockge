# Deployment and upgrades for our fork

The API builds on official Dockge 1.5.0. `docker/Dockerfile.fork` pins that
runtime by digest, installs dependencies from the lockfile, builds the frontend
inside Docker, and labels every image with the source commit. It supports both
BuildKit and the legacy Docker builder; host Node.js, npm and Git are not needed.

## Installed deployment on 192.168.2.211

- URL: `http://192.168.2.211:5001`
- Project/service: `dockge` / `dockge`
- Original configuration: `/opt/dockge/compose.yaml`
- Image override: `/opt/dockge/compose.override.yaml`
- Persistent Dockge data: `/opt/dockge/data`
- Application Stacks: `/opt/stacks` (unchanged by the updater)
- Current commit/image: `/opt/dockge/.dockge-deployment.json`

Upgrade to the latest commit on our `main`:

```sh
sudo /opt/dockge/update.sh
```

Or upgrade to a specific full commit SHA:

```sh
sudo /opt/dockge/update.sh <40-character-commit-sha>
```

The command downloads a commit-pinned source archive from GitHub and builds
`yxa2111/dockge:git-<sha>` locally. This intentionally avoids dependence on private
registry credentials or an image-publishing job. Internet access to GitHub,
npm and Docker Hub is needed on a cold build. Layers and already-built revisions
are reused. An already-running matching revision is checked without restarting.

After a successful build, the updater checks for running API tasks, stops only
Dockge, backs up its consistent data directory and configuration, applies the
image override, and starts Dockge. It waits for Docker health and verifies the
HTTP API's authentication response. The upgrade controller is updated from the
same source revision only after successful validation.

The original ports, environment and volume mounts are preserved. Other Docker
containers are not restarted. Deploying a new Dockge version causes a brief
interruption of the management UI/API, but does not stop managed applications.
API tasks must finish before upgrading.

## Rollback

Every applied upgrade prints an exact rollback command:

```sh
sudo /opt/dockge/rollback.sh <backup-directory-name>
```

Backups live in `/opt/dockge/backups/`. Rollback restores **both the previous image
and its matching Dockge data**, including the pre-migration database. It retains
the displaced newer data inside the backup directory for inspection. Application
Stack files are not restored or modified. Keys/settings created after the backup
will no longer be present after a rollback.

If starting or validating a new image fails, the updater attempts this rollback
automatically and exits nonzero. Build failures leave the running service alone;
backup failures restart the old deployment without switching images. Source
archives, backups and image tags are retained; the updater does not prune Docker
images or remove backups automatically.

## Installing the controller on another standard single-service deployment

Requirements: Linux, Python 3.12+, Docker with Compose, sudo/root, and an existing
`/opt/dockge/compose.yaml` containing only service `dockge`, with
`./data:/app/data` and container port 5001. Copy these repository files into
`/opt/dockge/` and mark them executable:

- `extra/deploy/deploy.py`
- `extra/deploy/update.sh`
- `extra/deploy/rollback.sh`

Then run `sudo /opt/dockge/update.sh`. The controller refuses an existing unmanaged
`compose.override.yaml` rather than overwriting custom configuration.

For manual image builds:

```sh
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" \
  -f docker/Dockerfile.fork -t yxa2111/dockge:local .
```

Do not use the inherited upstream publishing scripts: their tags target
`louislam/dockge`. Our updater uses our own image namespace and immutable commit tags.

Controller regression tests:

```sh
python3 -m unittest discover -s tests -p 'deploy_test.py'
```
