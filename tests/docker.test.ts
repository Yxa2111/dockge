import { DockerStatsClient } from "../backend/resources/docker-client";
import { ResourceCollector } from "../backend/resources/collector";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers";
import { Terminal } from "../backend/terminal";

test("real Docker lifecycle through HTTP", { skip: process.env.DOCKGE_TEST_DOCKER !== "1",
    timeout: 180000 }, async () => {
    // Use a preloaded immutable image so testing does not retag shared images.
    const image = process.env.DOCKGE_TEST_IMAGE || JSON.parse(execFileSync("docker", [ "image", "inspect", "alpine:latest", "--format", "{{json .RepoDigests}}" ], { encoding: "utf8" }))[0];
    assert.ok(image, "Preload alpine:latest or set DOCKGE_TEST_IMAGE to an immutable image reference.");
    const f = await fixture();
    f.server.resources.close();
    f.server.resources = new ResourceCollector(new DockerStatsClient(undefined, undefined, f.server.stacksDir));
    const name = "dockge-api-test-" + process.pid + "-" + Date.now();
    const dir = path.join(f.server.stacksDir, name);
    const config = { composeYAML: `# API integration fixture\nservices:\n  web:\n    image: ${image}\n    command: [sh, -c, 'echo dockge-api-smoke; sleep 300']\n`,
        composeENV: "TEST=ok\n" };
    const action = async (operation: string) => {
        const result = await f.request("POST", `/stacks/${name}/actions/${operation}`);
        assert.equal(result.status, 202, JSON.stringify(result.body));
        await f.server.operations.idle();
        const completed = await f.server.operations.get(result.body.operation_id);
        assert.equal(completed.state, "succeeded", JSON.stringify(completed));
        assert.equal(completed.exit_code, 0);
        return completed;
    };
    try {
        assert.equal((await f.request("POST", "/stacks", "manage", { name,
            ...config })).status, 201);
        const deployed = await action("deploy");
        assert.ok((await f.request("GET", `/operations/${deployed.id}/logs`)).body.text.length);
        assert.equal((await f.request("GET", `/stacks/${name}`, "read")).body.services.web, "running");
        const logs = await f.request("GET", `/stacks/${name}/logs?tail=50&service=web`, "read");
        assert.equal(logs.status, 200);
        assert.match(logs.body.text, /dockge-api-smoke/);
        // Abandon a live SSE connection; the container remains running.
        const abort = new AbortController();
        const stream = await fetch(f.url + `/stacks/${name}/logs?follow=true`, { headers: { Authorization: `Bearer ${f.keys.read.secret}` },
            signal: abort.signal });
        const reader = stream.body!.getReader();
        const chunk = await reader.read();
        assert.match(new TextDecoder().decode(chunk.value), /event: log/);
        abort.abort();
        await f.server.resources.refresh();
        const snapshot = (await f.request("GET", `/stacks/${name}/stats`, "read")).body;
        assert.equal(snapshot.status, "ready");
        assert.equal(snapshot.containers.length, 1);
        assert.equal(snapshot.containers[0].available, true);
        assert.ok(snapshot.containers[0].values.memory_working_set_bytes > 0);
        const scraped = await fetch(new URL(f.url).origin + "/metrics", { headers: { Authorization: "Bearer " + f.keys.read.secret } });
        assert.ok((await scraped.text()).split("\n").some(line => line.startsWith("dockge_container_memory_working_set_bytes{") && line.includes(`stack="${name}"`)));
        await action("update");
        assert.equal((await f.request("GET", `/stacks/${name}`, "read")).body.services.web, "running");
        await action("restart");
        await action("stop");
        await f.server.resources.refresh();
        const stoppedSnapshot = f.server.resources.current(name);
        assert.equal(stoppedSnapshot.containers[0].state, "exited");
        assert.equal(stoppedSnapshot.containers[0].available, false);
        assert.equal(stoppedSnapshot.containers[0].values, null);
        await action("update");
        assert.notEqual((await f.request("GET", `/stacks/${name}`, "read")).body.services.web, "running");
        await action("start");
        await action("down");
        assert.equal(await fs.readFile(path.join(dir, "compose.yaml"), "utf8"), config.composeYAML);
        // Pull failure must be recorded rather than acknowledged as success.
        await f.request("PUT", `/stacks/${name}/config`, "manage", { ...config,
            composeYAML: "services:\n  web:\n    image: 127.0.0.1:1/dockge-api-unavailable:never\n" });
        const failed = await f.request("POST", `/stacks/${name}/actions/pull`, "operate");
        await f.server.operations.idle();
        assert.equal((await f.server.operations.get(failed.body.operation_id)).state, "failed");
        await f.request("PUT", `/stacks/${name}/config`, "manage", config);
        await fs.mkdir(path.join(dir, "application-data"));
        await fs.writeFile(path.join(dir, "application-data", "test"), "delete fixture");
        const deleted = await f.request("DELETE", `/stacks/${name}`);
        await f.server.operations.idle();
        assert.equal((await f.server.operations.get(deleted.body.operation_id)).state, "succeeded");
        await assert.rejects(fs.stat(dir));
        await f.server.resources.refresh();
        assert.equal(f.server.resources.current(name).containers.length, 0);
        // Exercise actual PTY spawn failure and timer cleanup.
        const code = await Terminal.exec(f.server, undefined, name + "-missing", "/nonexistent-dockge-api-test", [], f.directory);
        assert.notEqual(code, 0);
        assert.equal(Terminal.getTerminalCount(), 0);
    } finally {
        try {
            await fs.access(dir);
            execFileSync("docker", [ "compose", "-p", name, "down", "--remove-orphans" ], { cwd: dir,
                stdio: "pipe" });
        } catch {
            // Normal success removes the directory already.
        }
        await f.close();
    }
});

test("real Docker resource snapshots, replicas, lifecycle and exporter without registry access", {
    skip: process.env.DOCKGE_TEST_DOCKER !== "1",
    timeout: 60000,
}, async () => {
    const image = process.env.DOCKGE_TEST_IMAGE || JSON.parse(execFileSync("docker", [ "image", "inspect", "alpine:latest", "--format", "{{json .RepoDigests}}" ], { encoding: "utf8" }))[0];
    assert.ok(image, "Preload alpine:latest or set DOCKGE_TEST_IMAGE.");
    const f = await fixture();
    f.server.resources.close();
    f.server.resources = new ResourceCollector(new DockerStatsClient(undefined, undefined, f.server.stacksDir));
    const name = "dockge-stats-test-" + process.pid + "-" + Date.now();
    const project = name + "-custom-project";
    const containerName = name + "-custom-container";
    const dir = path.join(f.server.stacksDir, name);
    const compose = (...args: string[]) => execFileSync("docker", [ "compose", ...args ], { cwd: dir,
        stdio: "pipe" });
    try {
        assert.equal((await f.request("POST", "/stacks", "manage", { name,
            composeYAML: `name: ${project}\nservices:\n  web:\n    image: ${image}\n    container_name: ${containerName}\n    command: [sleep, '300']\n    mem_limit: 64m\n  worker:\n    image: ${image}\n    command: [sleep, '300']\n    mem_limit: 64m\n`,
            composeENV: "" })).status, 201);
        compose("up", "-d", "--pull", "never", "--scale", "worker=2");
        await f.server.resources.refresh();
        const first = (await f.request("GET", `/stacks/${name}/stats`, "read")).body;
        assert.equal(first.containers.length, 3);
        assert.equal(first.containers.filter((row: { service: string }) => row.service === "worker").length, 2);
        for (const row of first.containers) {
            assert.equal(row.stack, name, "map custom Compose project back to the managed directory");
            assert.equal(row.project, project);
            assert.equal(row.available, true);
            assert.equal(row.values.memory_limit_bytes, 64 * 1024 * 1024);
            assert.ok(row.values.memory_working_set_bytes > 0);
        }
        assert.ok(first.containers.some((row: { name: string }) => row.name === containerName));
        await new Promise(resolve => setTimeout(resolve, 1200));
        await f.server.resources.refresh();
        const active = f.server.resources.current(name);
        assert.ok(active.containers.every(row => row.values?.cpu_percent !== null));
        assert.ok(active.containers.every(row => row.values?.network_receive_bytes_per_second !== null));
        const scrape = await fetch(new URL(f.url).origin + "/metrics", { headers: { Authorization: "Bearer " + f.keys.read.secret } });
        assert.equal(scrape.status, 200);
        assert.ok((await scrape.text()).split("\n").some(line => line.startsWith("dockge_container_cpu_usage_seconds_total{") && line.includes(`stack="${name}"`)));
        compose("stop", "-t", "1", "web");
        await f.server.resources.refresh();
        const stopped = f.server.resources.current(name).containers.find(row => row.name === containerName)!;
        assert.equal(stopped.state, "exited");
        assert.equal(stopped.available, false);
        assert.equal(stopped.values, null);
        compose("start", "web");
        await f.server.resources.refresh();
        const restarted = f.server.resources.current(name).containers.find(row => row.name === containerName)!;
        assert.equal(restarted.available, true);
        assert.equal(restarted.values!.network_receive_bytes_per_second, null, "restart must warm a new rate baseline");
        compose("down", "--remove-orphans", "-t", "1");
        await f.server.resources.refresh();
        assert.equal(f.server.resources.current(name).containers.length, 0);
    } finally {
        try {
            compose("down", "--remove-orphans", "-t", "1");
        } finally {
            await f.close();
        }
    }
});
