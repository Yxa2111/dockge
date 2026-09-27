import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fixture, config } from "./helpers";
import { ApiKeys } from "../backend/api/keys";
import { Terminal } from "../backend/terminal";
import { Stack } from "../backend/stack";
import { StackService } from "../backend/api/stack-service";
import { Operations, LOG_LIMIT, RETENTION_MS } from "../backend/api/operations";
import { DockerSocketHandler } from "../backend/agent-socket-handlers/docker-socket-handler";
import { AgentSocket } from "../common/agent-socket";
import type { DockgeSocket } from "../backend/util-server";
import { RUNNING } from "../common/util-common";

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise,
        resolve };
};

test("HTTP API and shared execution integration", async t => {
    const f = await fixture();
    const originalExec = Terminal.exec;
    const originalStatus = Stack.prototype.updateStatus;
    const originalList = Stack.getStackList;
    const originalJoin = Stack.prototype.joinCombinedTerminal;
    const originalServices = Stack.prototype.getServiceStatusList;
    Stack.prototype.joinCombinedTerminal = async () => {};
    const calls: string[][] = [];
    let gate: ReturnType<typeof deferred> | undefined;
    let entered: ReturnType<typeof deferred> | undefined;
    let exitCode = 0;
    let output = "command output\n";
    Terminal.exec = async (server, socket, name, file, args, cwd, onData) => {
        calls.push(args as string[]);
        onData?.(output);
        entered?.resolve();
        await gate?.promise;
        return exitCode;
    };
    Stack.prototype.updateStatus = async function () {
        Object.assign(this, { _status: RUNNING });
    };
    Stack.getStackList = async server => new Map([[ "sample", new Stack(server, "sample") ]]);
    Stack.prototype.getServiceStatusList = async () => new Map([[ "web", "running" ]]) as never;
    try {
        await t.test("authentication and three permission tiers", async () => {
            assert.equal((await f.request("GET", "/stacks", null)).status, 401);
            assert.equal((await f.request("POST", "/stacks", "read", { name: "sample",
                ...config })).status, 403);
            assert.equal((await f.request("POST", "/stacks", "operate", { name: "sample",
                ...config })).status, 403);
            assert.equal((await f.request("POST", "/stacks", "manage", { name: "sample",
                ...config })).status, 201);
            assert.equal((await f.request("POST", "/stacks", "manage", { name: "sample",
                ...config })).status, 409);
            for (const role of [ "read", "operate" ] as const) {
                assert.equal((await f.request("GET", "/stacks/sample/config", role)).status, 403);
                assert.equal((await f.request("DELETE", "/stacks/sample", role)).status, 403);
                assert.equal((await f.request("POST", "/stacks/sample/actions/deploy", role)).status, 403);
                assert.equal((await f.request("POST", "/stacks/sample/actions/down", role)).status, 403);
            }
            assert.equal((await f.request("POST", "/stacks/sample/actions/start", "read")).status, 403);
            const detail = await f.request("GET", "/stacks/sample", "read");
            assert.equal(detail.status, 200);
            assert.equal(detail.body.composeYAML, undefined);
            assert.equal(detail.body.composeENV, undefined);
            assert.equal(detail.body.services.web, "running");
            assert.equal((await f.request("GET", "/unknown")).status, 404);
        });
        await t.test("configuration is exact, explicit, validated and path confined", async () => {
            assert.deepEqual((await f.request("GET", "/stacks/sample/config")).body, config);
            assert.equal((await f.request("PUT", "/stacks/sample/config", "manage", { composeYAML: "services: {}" })).status, 400);
            assert.equal((await f.request("PUT", "/stacks/sample/config", "manage", { ...config,
                composeYAML: "[broken" })).status, 400);
            assert.equal((await f.request("PUT", "/stacks/sample/config", "manage", { ...config,
                composeENV: "" })).status, 200);
            assert.equal(await fs.readFile(path.join(f.server.stacksDir, "sample", ".env"), "utf8"), "");
            assert.equal(calls.length, 0, "saving must not deploy");
            for (const name of [ "../escape", "../sample", "a/b", "", ".", "UPPER" ]) {
                assert.equal((await f.request("POST", "/stacks", "manage", { name,
                    ...config })).status, 400);
            }
            await fs.symlink(f.directory, path.join(f.server.stacksDir, "linked"), "dir");
            assert.equal((await f.request("GET", "/stacks/linked/config")).status, 400);
            await fs.writeFile(path.join(f.directory, "secret"), "private");
            await fs.symlink(path.join(f.directory, "secret"), path.join(f.server.stacksDir, "sample", "compose.yml"));
            assert.equal((await f.request("POST", "/stacks/sample/actions/start", "operate")).status, 400);
            await fs.unlink(path.join(f.server.stacksDir, "sample", "compose.yml"));
            assert.equal((await f.request("PUT", "/stacks/missing/config", "manage", config)).status, 404);
            const malformed = await fetch(f.url + "/stacks", { method: "POST",
                headers: { Authorization: `Bearer ${f.keys.manage.secret}`,
                    "Content-Type": "application/json" },
                body: "{" });
            assert.equal(malformed.status, 400);
        });
        await t.test("one operation per Stack, whole update lock and idempotent concurrent submissions", async () => {
            gate = deferred();
            entered = deferred();
            calls.length = 0;
            const submit = () => f.request("POST", "/stacks/sample/actions/update", "operate", undefined, { "Idempotency-Key": "update-1" });
            const [ a, b ] = await Promise.all([ submit(), submit() ]);
            assert.equal(a.status, 202);
            assert.equal(b.body.operation_id, a.body.operation_id);
            await entered.promise;
            assert.equal((await f.request("POST", "/stacks/sample/actions/start", "operate")).status, 409);
            assert.equal((await f.request("PUT", "/stacks/sample/config", "manage", config)).status, 409);
            assert.equal((await f.request("POST", "/stacks/sample/actions/start", "operate", undefined, { "Idempotency-Key": "update-1" })).status, 409);
            // Exercise the real WebSocket event wrapper, not just the lock helper.
            const agent = new AgentSocket();
            const socket = { userID: 1,
                endpoint: "" } as DockgeSocket;
            new DockerSocketHandler().create(socket, f.server, agent);
            const result = await new Promise<{ ok: boolean; msg: string }>(resolve => agent.call("saveStack", "sample", config.composeYAML, config.composeENV, false, resolve));
            assert.equal(result.ok, false);
            assert.match(result.msg, /Another operation/);
            // Specifically try to write in the gap between pull and up.
            let gapConflict = false;
            Stack.prototype.updateStatus = async function () {
                await assert.rejects(StackService.withLock(f.server, "sample", async () => {}), /Another operation/);
                gapConflict = true;
                Object.assign(this, { _status: RUNNING });
            };
            gate.resolve();
            gate = undefined;
            await f.server.operations.idle();
            assert.equal(gapConflict, true);
            assert.deepEqual(calls.map(args => args[1]), [ "pull", "up" ]);
            const op = (await f.request("GET", "/operations/" + a.body.operation_id, "read")).body;
            assert.equal(op.state, "succeeded");
            assert.equal(op.exit_code, 0);
            assert.equal((await submit()).body.operation_id, op.id);
            const logs = await f.request("GET", `/operations/${op.id}/logs`, "read");
            assert.match(logs.body.text, /command output/);
            const stream = await fetch(f.url + `/operations/${op.id}/logs?follow=true`, { headers: { Authorization: `Bearer ${f.keys.read.secret}` } });
            assert.match(await stream.text(), /event: end/);
        });
        await t.test("reverse conflict: web save-and-deploy blocks API and does not release early", async () => {
            const agent = new AgentSocket();
            const socket = { userID: 1,
                endpoint: "",
                emitAgent: () => {} } as unknown as DockgeSocket;
            new DockerSocketHandler().create(socket, f.server, agent);
            gate = deferred();
            entered = deferred();
            const resultPromise = new Promise<{ ok: boolean }>(resolve => agent.call("deployStack", "sample", config.composeYAML, config.composeENV, false, resolve));
            await entered.promise;
            assert.equal((await f.request("POST", "/stacks/sample/actions/restart", "operate")).status, 409);
            assert.equal((await f.request("PUT", "/stacks/sample/config", "manage", config)).status, 409);
            gate.resolve();
            gate = undefined;
            const result = await resultPromise;
            assert.equal(result.ok, true);
            await new Promise(resolve => setImmediate(resolve));
        });
        await t.test("failed commands, stopped update, disconnect independence, log bounds", async () => {
            exitCode = 17;
            const fail = await f.request("POST", "/stacks/sample/actions/pull", "operate");
            await f.server.operations.idle();
            const failed = (await f.request("GET", "/operations/" + fail.body.operation_id)).body;
            assert.equal(failed.state, "failed");
            assert.equal(failed.exit_code, 17);
            exitCode = 0;
            calls.length = 0;
            Stack.prototype.updateStatus = async () => {};
            const stopped = await f.request("POST", "/stacks/sample/actions/update", "operate");
            await f.server.operations.idle();
            assert.equal((await f.server.operations.get(stopped.body.operation_id)).state, "succeeded");
            assert.deepEqual(calls.map(args => args[1]), [ "pull" ]);
            output = "x".repeat(LOG_LIMIT + 50);
            const large = await f.request("POST", "/stacks/sample/actions/start", "operate");
            await f.server.operations.idle();
            assert.equal(Boolean((await f.server.operations.get(large.body.operation_id)).truncated), true);
            assert.equal((await fs.stat(f.server.operations.logPath(large.body.operation_id))).size, LOG_LIMIT);
            output = "done\n";
            const listing = (await f.request("GET", "/operations?limit=1&stack=sample")).body;
            assert.equal(listing.operations.length, 1);
            assert.equal(listing.next_offset, 1);
        });
        await t.test("SSE revocation, UTF-8 pagination and parameter errors", async () => {
            const key = await ApiKeys.create("stream-reader", "read", null);
            gate = deferred();
            entered = deferred();
            const accepted = await f.request("POST", "/stacks/sample/actions/start", "operate");
            await entered.promise;
            const stream = await fetch(f.url + `/operations/${accepted.body.operation_id}/logs?follow=true`, { headers: { Authorization: "Bearer " + key.secret } });
            await ApiKeys.revoke(key.key.id);
            assert.match(await stream.text(), /event: error/);
            // Reader disconnection/revocation does not own the task.
            assert.equal((await f.server.operations.get(accepted.body.operation_id)).state, "running");
            gate.resolve();
            gate = undefined;
            await f.server.operations.idle();
            assert.equal((await f.server.operations.get(accepted.body.operation_id)).state, "succeeded");
            const text = "你好世界🌍";
            await fs.writeFile(f.server.operations.logPath(accepted.body.operation_id), text);
            let offset = 0;
            let combined = "";
            while (offset < Buffer.byteLength(text)) {
                const page = f.server.operations.readLog(accepted.body.operation_id, offset, 4);
                assert.ok(page.next_offset > offset);
                combined += page.text;
                offset = page.next_offset;
            }
            assert.equal(combined, text);
            assert.equal((await f.request("GET", "/operations?limit=0")).status, 400);
            assert.equal((await f.request("GET", "/operations?limit=201")).status, 400);
            assert.equal((await f.request("GET", `/operations/${accepted.body.operation_id}/logs?follow=invalid`)).status, 400);
            assert.equal((await f.request("GET", `/operations/${accepted.body.operation_id}/logs?limit=1`)).status, 400);
        });
        await t.test("Key storage, expiry, revocation and validation", async () => {
            const key = await ApiKeys.create("temporary", "read", Date.now() + 60000);
            const row = await f.db("api_key").where({ id: key.key.id }).first();
            assert.equal(row.digest.length, 64);
            assert.equal(JSON.stringify(row).includes(key.secret), false);
            assert.equal(JSON.stringify(await ApiKeys.list()).includes(row.digest), false);
            assert.equal((await ApiKeys.authenticate("Bearer " + key.secret)).id, key.key.id);
            await f.db("api_key").where({ id: key.key.id }).update({ expires_at: Date.now() - 1 });
            await assert.rejects(ApiKeys.authenticate("Bearer " + key.secret), /expired/);
            await ApiKeys.revoke(f.keys.read.key.id);
            assert.equal((await f.request("GET", "/stacks", "read")).status, 401);
            await assert.rejects(ApiKeys.create("bad", "toString", null), /permission/);
            await assert.rejects(ApiKeys.create("bad", "read", -1), /Expiry/);
        });
        await t.test("restart recovery and bounded retention", async () => {
            const row = await f.db("api_operation").first();
            await f.db("api_operation").where({ id: row.id }).update({ state: "running",
                finished_at: null });
            f.server.operations.close();
            f.server.operations = new Operations(f.server);
            await f.server.operations.init();
            assert.equal((await f.server.operations.get(row.id)).state, "interrupted");
            await f.db("api_operation").where({ id: row.id }).update({ finished_at: Date.now() - RETENTION_MS - 1 });
            await f.server.operations.cleanup();
            await assert.rejects(f.server.operations.get(row.id), /not found/);
            await assert.rejects(fs.stat(f.server.operations.logPath(row.id)));
        });
        await t.test("delete follows original down then recursive directory removal", async () => {
            await fs.mkdir(path.join(f.server.stacksDir, "sample", "application-data"));
            await fs.writeFile(path.join(f.server.stacksDir, "sample", "application-data", "value"), "data");
            const result = await f.request("DELETE", "/stacks/sample");
            assert.equal(result.status, 202);
            await f.server.operations.idle();
            assert.equal((await f.server.operations.get(result.body.operation_id)).state, "succeeded");
            await assert.rejects(fs.stat(path.join(f.server.stacksDir, "sample")));
        });
    } finally {
        Terminal.exec = originalExec;
        Stack.prototype.joinCombinedTerminal = originalJoin;
        Stack.prototype.updateStatus = originalStatus;
        Stack.getStackList = originalList;
        Stack.prototype.getServiceStatusList = originalServices;
        gate?.resolve();
        await f.close();
    }
});
