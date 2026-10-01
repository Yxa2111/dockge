import { EventEmitter } from "node:events";
import type { ContainerResources, ResourceSnapshot } from "../../common/container-resources";
import { DockerStatsClient, StatsSource } from "./docker-client";
import { normalizeStats, RawSample } from "./normalize";

export const STATS_INTERVAL_MS = 2000;
export const STATS_STALE_MS = 10000;

/** One shared sampler for UI, JSON API and scrapes. Only current/previous samples exist in RAM. */
export class ResourceCollector extends EventEmitter {
    private previous = new Map<string, RawSample>();
    private snapshot: ResourceSnapshot = { sampled_at: null,
        last_success_at: null,
        status: "starting",
        stale: false,
        error: null,
        containers: [] };

    private pending?: Promise<void>;
    private timer?: NodeJS.Timeout;
    private stopped = false;
    private started = false;

    constructor(private source: StatsSource = new DockerStatsClient(), private interval = STATS_INTERVAL_MS) {
        super();
        this.setMaxListeners(0);
    }

    start() {
        if (this.started || this.stopped) {
            return;
        }
        this.started = true;
        const tick = async () => {
            const started = Date.now();
            await this.refresh();
            if (!this.stopped) {
                this.timer = setTimeout(() => {
                    void tick();
                }, Math.max(50, this.interval - (Date.now() - started)));
                this.timer.unref();
            }
        };
        void tick();
    }

    current(stack?: string): ResourceSnapshot {
        const now = Date.now();
        const stale = this.snapshot.sampled_at !== null && now - this.snapshot.sampled_at > STATS_STALE_MS;
        const containers = this.snapshot.containers.filter(container => stack === undefined || container.stack === stack).map(container => {
            const expired = container.sampled_at !== null && now - container.sampled_at > STATS_STALE_MS;
            return { ...container,
                available: container.available && !stale && !expired };
        });
        const expired = containers.some(container => container.state === "running" && !container.available);
        return {
            ...this.snapshot,
            stack,
            stale,
            status: stale ? "unavailable" : expired && this.snapshot.status === "ready" ? "degraded" : this.snapshot.status,
            containers,
        };
    }

    refresh(): Promise<void> {
        if (this.stopped) {
            return Promise.resolve();
        }
        if (!this.pending) {
            this.pending = this.collect().finally(() => {
                this.pending = undefined;
            });
        }
        return this.pending;
    }

    private async collect() {
        try {
            const inventory = await this.source.list();
            const results = new Array<ContainerResources>(inventory.length);
            const next = new Map<string, RawSample>();
            let cursor = 0;
            const workers = Array.from({ length: Math.min(8, inventory.length) }, async () => {
                while (cursor < inventory.length && !this.stopped) {
                    const index = cursor++;
                    const identity = inventory[index];
                    const item: ContainerResources = { ...identity,
                        sampled_at: null,
                        available: false,
                        error: null,
                        values: null };
                    results[index] = item;
                    if (identity.state !== "running") {
                        continue;
                    }
                    try {
                        const raw = await this.source.stats(identity.id);
                        if (!raw || typeof raw !== "object" || !("cpu_stats" in raw) || !("memory_stats" in raw)) {
                            throw new Error("Docker returned incomplete container statistics.");
                        }
                        const sample = normalizeStats(raw, Date.now(), this.previous.get(identity.id));
                        next.set(identity.id, sample);
                        item.sampled_at = sample.sampledAt;
                        item.available = true;
                        item.values = sample.values;
                    } catch (error) {
                        item.error = error instanceof Error ? error.message : "Statistics unavailable.";
                        // A failed sample breaks the rate baseline; never bridge a missing interval.
                    }
                }
            });
            await Promise.all(workers);
            if (this.stopped) {
                return;
            }
            this.previous = next;
            const failed = results.some(item => item.error !== null);
            const now = Date.now();
            this.snapshot = {
                sampled_at: now,
                last_success_at: failed ? this.snapshot.last_success_at : now,
                status: failed ? "degraded" : "ready",
                stale: false,
                error: failed ? "Some container statistics could not be collected." : null,
                containers: results,
            };
        } catch (error) {
            this.previous.clear();
            this.snapshot = { ...this.snapshot,
                status: "unavailable",
                error: error instanceof Error ? error.message : "Docker statistics unavailable.",
                containers: this.snapshot.containers.map(item => ({ ...item,
                    available: false,
                    values: null })) };
        }
        this.emit("snapshot");
    }

    close() {
        this.stopped = true;
        clearTimeout(this.timer);
        this.source.close();
        this.removeAllListeners();
    }
}
