import type { ContainerResourceValues, ResourceSnapshot } from "../../common/container-resources";

const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n|\r/g, "\\n").replace(/"/g, "\\\"");
const definitions: [string, "gauge" | "counter", string, keyof ContainerResourceValues, number?][] = [
    [ "cpu_usage_ratio", "gauge", "CPU cores in use; may exceed 1 on multi-core hosts.", "cpu_percent", 0.01 ],
    [ "cpu_usage_seconds_total", "counter", "Cumulative container CPU time in seconds.", "cpu_seconds_total" ],
    [ "memory_usage_bytes", "gauge", "Total charged memory including cache.", "memory_usage_bytes" ],
    [ "memory_working_set_bytes", "gauge", "Memory excluding inactive file cache, matching Docker CLI on Linux.", "memory_working_set_bytes" ],
    [ "memory_limit_bytes", "gauge", "Memory limit reported by Docker; defaults to host memory when unlimited.", "memory_limit_bytes" ],
    [ "network_receive_bytes_total", "counter", "Cumulative received bytes across container interfaces.", "network_receive_bytes_total" ],
    [ "network_transmit_bytes_total", "counter", "Cumulative transmitted bytes across container interfaces.", "network_transmit_bytes_total" ],
    [ "block_read_bytes_total", "counter", "Cumulative bytes read from host block devices.", "block_read_bytes_total" ],
    [ "block_write_bytes_total", "counter", "Cumulative bytes written to host block devices.", "block_write_bytes_total" ],
    [ "pids", "gauge", "Processes and kernel threads in the container.", "pids" ],
];

/** Prometheus text 0.0.4, with raw counters for rate() and no explicit sample timestamps. */
export function prometheusMetrics(snapshot: ResourceSnapshot): string {
    const lines: string[] = [];
    const help = (name: string, type: string, description: string) => {
        lines.push(`# HELP ${name} ${description}`, `# TYPE ${name} ${type}`);
    };
    help("dockge_stats_collection_success", "gauge", "1 when the last complete collection succeeded and is fresh.");
    lines.push(`dockge_stats_collection_success ${snapshot.status === "ready" && !snapshot.stale ? 1 : 0}`);
    help("dockge_stats_last_success_timestamp_seconds", "gauge", "Unix timestamp of the last fully successful collection.");
    lines.push(`dockge_stats_last_success_timestamp_seconds ${(snapshot.last_success_at ?? 0) / 1000}`);
    const inventoryAvailable = (snapshot.status === "ready" || snapshot.status === "degraded") && !snapshot.stale;
    const rows = snapshot.containers.map(item => ({ item,
        labels: `{container_id="${escape(item.id)}",container_name="${escape(item.name)}",stack="${escape(item.stack)}",service="${escape(item.service)}"}` }));
    help("dockge_container_running", "gauge", "1 when the container is running, otherwise 0.");
    if (inventoryAvailable) {
        for (const { item, labels } of rows) {
            lines.push(`dockge_container_running${labels} ${item.state === "running" ? 1 : 0}`);
        }
    }
    help("dockge_container_stats_available", "gauge", "1 when current container statistics are fresh and available.");
    for (const { item, labels } of rows) {
        lines.push(`dockge_container_stats_available${labels} ${inventoryAvailable && item.available ? 1 : 0}`);
    }
    const available = rows.filter(({ item }) => inventoryAvailable && item.available && item.values);
    help("dockge_container_stats_timestamp_seconds", "gauge", "Unix timestamp of this container sample.");
    for (const { item, labels } of available) {
        lines.push(`dockge_container_stats_timestamp_seconds${labels} ${item.sampled_at! / 1000}`);
    }
    for (const [ suffix, type, description, field, scale = 1 ] of definitions) {
        const name = "dockge_container_" + suffix;
        help(name, type, description);
        for (const { item, labels } of available) {
            const value = item.values![field];
            if (value !== null && Number.isFinite(value)) {
                lines.push(`${name}${labels} ${value * scale}`);
            }
        }
    }
    return lines.join("\n") + "\n";
}
