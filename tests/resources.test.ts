import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeStats } from "../backend/resources/normalize";
import { ResourceCollector } from "../backend/resources/collector";
import { DockerStatsClient, StatsSource } from "../backend/resources/docker-client";
import { prometheusMetrics } from "../backend/resources/prometheus";
import type { ContainerIdentity } from "../common/container-resources";
import { fixture, config } from "./helpers";
import { ApiKeys } from "../backend/api/keys";
import { ResourceSocketHandler } from "../backend/socket-handlers/resource-socket-handler";
import type { DockgeSocket } from "../backend/util-server";

const id = "a".repeat(64);
const identity: ContainerIdentity = { id,
    name: "custom-name",
    image: "alpine",
    stack: "sample",
    project: "sample",
    service: "web",
    state: "running",
    health: null };
const raw = (cpu = 1e9, system = 10e9, received = 1024, written = 2048) => ({
    cpu_stats: { cpu_usage: { total_usage: cpu },
        system_cpu_usage: system,
        online_cpus: 4 },
    memory_stats: { usage: 10240,
        limit: 20480,
        stats: { inactive_file: 2048 } },
    networks: { eth0: { rx_bytes: received,
        tx_bytes: 1024 },
    eth1: { rx_bytes: received,
        tx_bytes: 2048 } },
    blkio_stats: { io_service_bytes_recursive: [{ op: "Read",
        value: 1024 }, { op: "Write",
        value: written }, { op: "read",
        value: 2048 }] },
    pids_stats: { current: 5 },
});
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class FakeSource implements StatsSource {
    rows = [ identity ];
    output: unknown = raw();
    failure = false;
    inventoryFailure = false;
    calls = 0;
    async list() {
        if (this.inventoryFailure) {
            throw new Error("daemon disconnected");
        }
        return this.rows;
    }

    async stats() {
        this.calls++;
        if (this.failure) {
            throw new Error("container disappeared");
        }
        return this.output;
    }

    close() {}
}

test("raw counters, multi-core CPU, cache correction, network sums and I/O rates", () => {
    const first = normalizeStats(raw(), 1000);
    assert.equal(first.values.cpu_percent, null);
    assert.equal(first.values.cpu_seconds_total, 1);
    assert.equal(first.values.memory_working_set_bytes, 8192);
    assert.equal(first.values.memory_percent, 40);
    assert.equal(first.values.network_receive_bytes_total, 2048);
    assert.equal(first.values.block_read_bytes_total, 3072);
    assert.equal(first.values.network_receive_bytes_per_second, null);
    const second = normalizeStats(raw(3e9, 12e9, 3072, 6144), 3000, first);
    assert.equal(second.values.cpu_percent, 400);
    assert.equal(second.values.network_receive_bytes_per_second, 2048);
    assert.equal(second.values.block_write_bytes_per_second, 2048);
    const reset = normalizeStats(raw(5e8, 13e9, 4000, 8192), 5000, second);
    assert.equal(reset.values.cpu_percent, null);
    assert.equal(reset.values.network_receive_bytes_per_second, null);
    assert.equal(normalizeStats(raw(3e9, 12e9), 15000, first).values.cpu_percent, null);
    const v1 = raw();
    Object.assign(v1.memory_stats.stats, { total_inactive_file: 1024 });
    assert.equal(normalizeStats(v1, 1000).values.memory_working_set_bytes, 9216);
    const absent = raw() as Record<string, unknown>;
    delete absent.networks;
    delete absent.blkio_stats;
    assert.equal(normalizeStats(absent, 1000).values.network_receive_bytes_total, null);
    assert.equal(normalizeStats(absent, 1000).values.block_read_bytes_total, null);
    Object.assign(v1.memory_stats.stats, { total_inactive_file: 20000 });
    assert.equal(normalizeStats(v1, 1000).values.memory_working_set_bytes, 0);
});

test("single-flight collection, bounded concurrency, replicas, errors, removal and recovery", async () => {
    const source = new FakeSource();
    let inflight = 0;
    let maximum = 0;
    source.rows = Array.from({ length: 17 }, (_, index) => ({ ...identity,
        id: index.toString(16).padStart(64, "0"),
        name: "replica-" + index }));
    source.stats = async () => {
        source.calls++;
        maximum = Math.max(maximum, ++inflight);
        await wait(5);
        inflight--;
        return raw();
    };
    const collector = new ResourceCollector(source);
    try {
        await Promise.all([ collector.refresh(), collector.refresh(), collector.refresh() ]);
        assert.equal(source.calls, 17);
        assert.equal(maximum, 8);
        assert.equal(collector.current("sample").containers.length, 17);
        assert.equal(collector.current("other").containers.length, 0);
        source.rows = [ identity, { ...identity,
            id: "b".repeat(64),
            name: "stopped",
            state: "exited" }];
        source.stats = async () => {
            throw new Error("container disappeared");
        };
        await collector.refresh();
        const partial = collector.current();
        assert.equal(partial.status, "degraded");
        assert.equal(partial.containers[0].available, false);
        assert.equal(partial.containers[0].values, null);
        assert.equal(partial.containers[1].error, null);
        source.stats = async () => raw();
        await collector.refresh();
        assert.equal(collector.current().containers[0].values?.network_receive_bytes_per_second, null, "failure resets the rate baseline");
        source.inventoryFailure = true;
        await collector.refresh();
        assert.equal(collector.current().status, "unavailable");
        assert.equal(collector.current().containers[0].available, false);
        const failedMetrics = prometheusMetrics(collector.current());
        assert.match(failedMetrics, /dockge_stats_collection_success 0/);
        assert.doesNotMatch(failedMetrics, /dockge_container_cpu_usage_seconds_total\{/);
        source.inventoryFailure = false;
        source.rows = [];
        await collector.refresh();
        assert.equal(collector.current().status, "ready");
        assert.equal(collector.current().containers.length, 0);
    } finally {
        collector.close();
    }
});

test("Prometheus labels, raw counters, freshness and no invented metrics", async (t) => {
    const source = new FakeSource();
    source.rows = [{ ...identity,
        name: "quote\"back\\line\n",
        state: "running" }];
    const collector = new ResourceCollector(source);
    try {
        await collector.refresh();
        const snapshot = collector.current();
        const metrics = prometheusMetrics(snapshot);
        assert.match(metrics, /# TYPE dockge_container_cpu_usage_seconds_total counter/);
        assert.match(metrics, /# TYPE dockge_container_memory_working_set_bytes gauge/);
        assert.match(metrics, /container_name="quote\\"back\\\\line\\n"/);
        assert.ok(metrics.endsWith("\n"));
        assert.doesNotMatch(metrics, /NaN|undefined/);
        const names = metrics.split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(/[ {]/)[0]);
        const transitions = names.filter((name, index) => index === 0 || name !== names[index - 1]);
        assert.equal(new Set(transitions).size, transitions.length, "metric families stay grouped");
        t.mock.method(Date, "now", () => snapshot.sampled_at! + 10001);
        const staleSnapshot = collector.current();
        assert.equal(staleSnapshot.stale, true);
        assert.equal(staleSnapshot.status, "unavailable");
        assert.equal(staleSnapshot.containers[0].available, false);
        const expired = prometheusMetrics(staleSnapshot);
        assert.match(expired, /dockge_stats_collection_success 0/);
        assert.doesNotMatch(expired, /dockge_container_network_receive_bytes_total\{/);
        t.mock.restoreAll();
        // Expose no host-network traffic counter when the Engine omits it.
        source.output = { ...raw(),
            networks: undefined };
        await collector.refresh();
        assert.doesNotMatch(prometheusMetrics(collector.current()), /dockge_container_network_receive_bytes_total\{/);
    } finally {
        t.mock.restoreAll();
        collector.close();
    }
});

test("Docker Unix socket API negotiation, custom Compose project mapping and timeouts", { skip: process.platform === "win32" }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-stats-"));
    const socketPath = path.join(directory, "docker.sock");
    const paths: string[] = [];
    let failure = "";
    const server = http.createServer((req, res) => {
        paths.push(req.url!);
        if (failure === "timeout") {
            return;
        }
        if (failure === "http") {
            res.writeHead(503).end();
            return;
        }
        if (failure === "json") {
            res.end("not-json");
            return;
        }
        const result = req.url === "/version" ? { ApiVersion: "1.47" } : req.url?.includes("containers/json") ? [{ Id: id,
            Names: [ "/custom-name" ],
            Image: "alpine",
            State: "running",
            Status: "Up 2 hours (unhealthy)",
            Labels: { "com.docker.compose.project": "custom-project",
                "com.docker.compose.project.working_dir": "/opt/stacks/sample",
                "com.docker.compose.service": "web" } }] : raw();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const client = new DockerStatsClient(socketPath, 100, "/opt/stacks");
    try {
        const rows = await client.list();
        assert.equal(rows[0].stack, "sample");
        assert.equal(rows[0].project, "custom-project");
        assert.equal(rows[0].name, "custom-name");
        assert.equal(rows[0].health, "unhealthy");
        await client.stats(id);
        assert.equal(paths[0], "/version");
        assert.match(paths[2], /stream=false&one-shot=true/);
        await assert.rejects(client.stats("../escape"), /Invalid container/);
        failure = "json";
        await assert.rejects(client.stats(id), /invalid statistics JSON/);
        failure = "http";
        await assert.rejects(client.stats(id), /HTTP 503/);
        failure = "timeout";
        await assert.rejects(client.stats(id), /timed out/);
    } finally {
        client.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await fs.rm(directory, { recursive: true,
            force: true });
    }
});

test("read-only API and metrics scrape use a shared cache and revocable Bearer key", async () => {
    const f = await fixture();
    f.server.resources.close();
    const source = new FakeSource();
    f.server.resources = new ResourceCollector(source);
    try {
        await f.server.resources.refresh();
        const origin = new URL(f.url).origin;
        assert.equal((await fetch(origin + "/metrics")).status, 401);
        const scrape = await fetch(origin + "/metrics", { headers: { Authorization: "Bearer " + f.keys.read.secret } });
        assert.equal(scrape.status, 200);
        assert.match(scrape.headers.get("content-type")!, /text\/plain/);
        assert.match(scrape.headers.get("content-type")!, /version=0.0.4/);
        assert.match(await scrape.text(), /dockge_container_memory_working_set_bytes\{.*\} 8192/);
        assert.equal((await f.request("GET", "/containers/stats", "read")).body.containers[0].name, "custom-name");
        assert.equal((await f.request("POST", "/stacks", "manage", { name: "sample",
            ...config })).status, 201);
        assert.equal((await f.request("GET", "/stacks/sample/stats", "read")).body.containers.length, 1);
        assert.equal((await f.request("GET", "/stacks/missing/stats", "read")).status, 404);
        assert.equal(source.calls, 1, "reads and scrapes must not start new collectors");
        await ApiKeys.revoke(f.keys.read.key.id);
        assert.equal((await fetch(origin + "/metrics", { headers: { Authorization: "Bearer " + f.keys.read.secret } })).status, 401);
    } finally {
        await f.close();
    }
});

test("Socket.IO subscription checks login, replaces old scope and removes listeners", async () => {
    const source = new FakeSource();
    const collector = new ResourceCollector(source);
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const events: unknown[][] = [];
    const socket = { userID: 0,
        volatile: { emit: (...args: unknown[]) => events.push(args) },
        on: (name: string, callback: (...args: unknown[]) => void) => handlers.set(name, callback) } as unknown as DockgeSocket;
    const handler = new ResourceSocketHandler();
    handler.create(socket, { resources: collector } as never);
    const subscribe = (stack: string) => new Promise<{ ok: boolean }>(resolve => handlers.get("subscribeContainerResources")!({ stack }, resolve));
    try {
        assert.equal((await subscribe("sample")).ok, false);
        socket.userID = 1;
        assert.equal((await subscribe("sample")).ok, true);
        assert.equal(collector.listenerCount("snapshot"), 1);
        await collector.refresh();
        assert.equal(events.length, 1);
        assert.equal((events[0][1] as { stack: string }).stack, "sample");
        await subscribe("different");
        assert.equal(collector.listenerCount("snapshot"), 1);
        handlers.get("disconnect")!();
        assert.equal(collector.listenerCount("snapshot"), 0);
    } finally {
        collector.close();
    }
});
