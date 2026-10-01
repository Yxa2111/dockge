import type { ContainerResourceValues } from "../../common/container-resources";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const nested = (value: unknown, field: string) => object(value)[field];

export interface RawSample {
    sampledAt: number;
    cpuTotal: number | null;
    systemCpu: number | null;
    values: ContainerResourceValues;
}

function rate(current: number | null, previous: number | null | undefined, elapsed: number): number | null {
    return current !== null && previous != null && current >= previous && elapsed > 0 && elapsed <= 10 ? (current - previous) / elapsed : null;
}

/** Raw byte/nanosecond counters, with Docker CLI's Linux working-set convention. */
export function normalizeStats(raw: unknown, now: number, previous?: RawSample): RawSample {
    const stats = object(raw);
    const cpu = object(stats.cpu_stats);
    const total = number(nested(cpu.cpu_usage, "total_usage"));
    const system = number(cpu.system_cpu_usage);
    const cores = number(cpu.online_cpus) ?? (Array.isArray(nested(cpu.cpu_usage, "percpu_usage")) ? (nested(cpu.cpu_usage, "percpu_usage") as unknown[]).length : null);
    const prevCpu = object(stats.precpu_stats);
    const previousTotal = previous?.cpuTotal ?? number(nested(prevCpu.cpu_usage, "total_usage"));
    const previousSystem = previous?.systemCpu ?? number(prevCpu.system_cpu_usage);
    let cpuPercent: number | null = null;
    if (total !== null && system !== null && previousTotal !== null && previousSystem !== null && total >= previousTotal && system > previousSystem && cores !== null && cores > 0) {
        cpuPercent = (total - previousTotal) / (system - previousSystem) * cores * 100;
    }
    const memory = object(stats.memory_stats);
    const usage = number(memory.usage);
    const limit = number(memory.limit);
    const memoryStats = object(memory.stats);
    const cache = number(memoryStats.total_inactive_file) ?? number(memoryStats.inactive_file) ?? number(memoryStats.cache) ?? 0;
    const workingSet = usage === null ? null : Math.max(0, usage - cache);
    const networks = stats.networks;
    let rx: number | null = null;
    let tx: number | null = null;
    if (networks && typeof networks === "object" && Object.keys(networks).length > 0) {
        const interfaces = Object.values(object(networks));
        const receive = interfaces.map(network => number(nested(network, "rx_bytes")));
        const transmit = interfaces.map(network => number(nested(network, "tx_bytes")));
        if (receive.every(value => value !== null)) {
            rx = receive.reduce<number>((sum, value) => sum + value!, 0);
        }
        if (transmit.every(value => value !== null)) {
            tx = transmit.reduce<number>((sum, value) => sum + value!, 0);
        }
    }
    const entries = nested(stats.blkio_stats, "io_service_bytes_recursive");
    let read: number | null = null;
    let write: number | null = null;
    if (Array.isArray(entries)) {
        read = 0;
        write = 0;
        for (const entry of entries) {
            const item = object(entry);
            const value = number(item.value);
            const op = String(item.op).toLowerCase();
            if (op === "read") {
                read = value === null || read === null ? null : read + value;
            }
            if (op === "write") {
                write = value === null || write === null ? null : write + value;
            }
        }
    }
    const elapsed = previous ? (now - previous.sampledAt) / 1000 : 0;
    const reset = total !== null && previous?.cpuTotal != null && total < previous.cpuTotal;
    if (previous && (elapsed <= 0 || elapsed > 10)) {
        cpuPercent = null;
    }
    const values: ContainerResourceValues = {
        cpu_percent: cpuPercent,
        cpu_seconds_total: total === null ? null : total / 1e9,
        memory_usage_bytes: usage,
        memory_working_set_bytes: workingSet,
        memory_limit_bytes: limit,
        memory_percent: workingSet !== null && limit !== null && limit > 0 ? workingSet / limit * 100 : null,
        network_receive_bytes_total: rx,
        network_transmit_bytes_total: tx,
        network_receive_bytes_per_second: reset ? null : rate(rx, previous?.values.network_receive_bytes_total, elapsed),
        network_transmit_bytes_per_second: reset ? null : rate(tx, previous?.values.network_transmit_bytes_total, elapsed),
        block_read_bytes_total: read,
        block_write_bytes_total: write,
        block_read_bytes_per_second: reset ? null : rate(read, previous?.values.block_read_bytes_total, elapsed),
        block_write_bytes_per_second: reset ? null : rate(write, previous?.values.block_write_bytes_total, elapsed),
        pids: number(nested(stats.pids_stats, "current")),
    };
    return { sampledAt: now,
        cpuTotal: total,
        systemCpu: system,
        values };
}
