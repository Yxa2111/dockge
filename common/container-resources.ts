export interface ContainerIdentity {
    id: string;
    name: string;
    image: string;
    stack: string;
    project: string;
    service: string;
    state: string;
    health: "healthy" | "unhealthy" | "starting" | null;
}

export interface ContainerResourceValues {
    cpu_percent: number | null;
    cpu_seconds_total: number | null;
    memory_usage_bytes: number | null;
    memory_working_set_bytes: number | null;
    memory_limit_bytes: number | null;
    memory_percent: number | null;
    network_receive_bytes_total: number | null;
    network_transmit_bytes_total: number | null;
    network_receive_bytes_per_second: number | null;
    network_transmit_bytes_per_second: number | null;
    block_read_bytes_total: number | null;
    block_write_bytes_total: number | null;
    block_read_bytes_per_second: number | null;
    block_write_bytes_per_second: number | null;
    pids: number | null;
}

export interface ContainerResources extends ContainerIdentity {
    sampled_at: number | null;
    available: boolean;
    error: string | null;
    values: ContainerResourceValues | null;
}

export interface ResourceSnapshot {
    stack?: string;
    sampled_at: number | null;
    last_success_at: number | null;
    status: "starting" | "ready" | "degraded" | "unavailable";
    stale: boolean;
    error: string | null;
    containers: ContainerResources[];
}
