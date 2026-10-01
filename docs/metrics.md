# Container metrics

`GET /metrics` serves Prometheus text format 0.0.4 on Dockge's existing port. It
uses the shared live container collector and requires a web-managed API key with
`read`, `operate` or `manage` permission. A dedicated `read` key is sufficient.
This endpoint is also documented in the built-in Swagger UI at `/api/docs/`.

```sh
curl --fail-with-body -H "Authorization: Bearer $DOCKGE_API_KEY" \
  "$DOCKGE_URL/metrics"
```

## Scraping with VictoriaMetrics

Use the following configuration with vmagent's `-promscrape.config` option, or
with the same option on single-node VictoriaMetrics. Set the target to the
address reachable from your collector. Put the API key in the indicated file
inside the vmagent/VictoriaMetrics runtime, then restrict its file permissions.

```yaml
scrape_configs:
  - job_name: dockge
    scrape_interval: 15s
    metrics_path: /metrics
    static_configs:
      - targets: ['192.168.2.211:5001']
    authorization:
      type: Bearer
      credentials_file: /etc/vmagent/dockge-api-key
```

The same scrape configuration works in Prometheus. When TLS is configured, add
`scheme: https`. Dockge returns 401 for a missing, expired or revoked key and 403
for insufficient permission. Docker collection errors still return HTTP 200,
with `dockge_stats_collection_success 0`; monitor this in addition to `up`.

## Metrics

Container series have stable label keys `container_id`, `container_name`, `stack`
and `service`. Unmanaged containers can have empty `stack`/`service` labels.
Recreating a container changes its ID and therefore starts a new series.

| Metric | Type | Meaning |
| --- | --- | --- |
| `dockge_stats_collection_success` | gauge | 1 if the complete collection is fresh and successful |
| `dockge_stats_last_success_timestamp_seconds` | gauge | Time of the last fully successful collection |
| `dockge_container_running` | gauge | 1 for running containers, 0 for other states; omitted when inventory is unavailable |
| `dockge_container_stats_available` | gauge | 1 if the container has a fresh, usable sample |
| `dockge_container_stats_timestamp_seconds` | gauge | Time of this container's sample |
| `dockge_container_cpu_usage_ratio` | gauge | CPU cores in use: 1 equals 100%, and values can exceed 1 |
| `dockge_container_cpu_usage_seconds_total` | counter | Cumulative CPU time in seconds |
| `dockge_container_memory_usage_bytes` | gauge | Charged memory including cache |
| `dockge_container_memory_working_set_bytes` | gauge | Memory excluding inactive file cache, matching Docker CLI on Linux |
| `dockge_container_memory_limit_bytes` | gauge | Reported limit; usually host memory when no container limit is set |
| `dockge_container_network_receive_bytes_total` | counter | Bytes received across container interfaces |
| `dockge_container_network_transmit_bytes_total` | counter | Bytes transmitted across container interfaces |
| `dockge_container_block_read_bytes_total` | counter | Bytes read from host block devices |
| `dockge_container_block_write_bytes_total` | counter | Bytes written to host block devices |
| `dockge_container_pids` | gauge | Processes and kernel threads |

Usage series are omitted when unavailable, unsupported or older than ten seconds.
They are never replaced by invented zeros. In particular, Docker may not report
per-container network counters for host networking. Block I/O counts device
traffic, not container filesystem size; an empty supported block I/O counter is
a legitimate zero. Stopped containers remain in the inventory until removed,
with `running` and `stats_available` equal to zero and no usage samples.

Use counters to compute rates in your monitoring system:

```promql
# CPU percentage, where one fully occupied core equals 100%
100 * rate(dockge_container_cpu_usage_seconds_total[5m])

# Network receive throughput in bytes per second
rate(dockge_container_network_receive_bytes_total[5m])

# Block write throughput in bytes per second
rate(dockge_container_block_write_bytes_total[5m])
```

Dockge samples approximately every two seconds using bounded concurrent read-only
Docker socket requests. Scrapes read the shared cache and do not trigger extra
collections. Only the current sample and previous counters exist in RAM; any
history or persistence belongs to VictoriaMetrics/Prometheus.

References: [Docker stats semantics](https://docs.docker.com/reference/cli/docker/container/stats/),
[Prometheus exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/),
[VictoriaMetrics scraping configuration](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#how-to-scrape-prometheus-exporters).
