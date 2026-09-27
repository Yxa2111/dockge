import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers";
import { ApiKeySocketHandler } from "../backend/socket-handlers/api-key-socket-handler";
import { Settings } from "../backend/settings";
import { generatePasswordHash } from "../backend/password-hash";
import type { DockgeSocket } from "../backend/util-server";

test("Key management requires a genuinely authenticated web session or password", async () => {
    const f = await fixture();
    const originalGet = Settings.get;
    let disabled = false;
    Settings.get = async () => disabled;
    await f.db.schema.createTable("user", table => {
        table.increments("id");
        table.string("password");
        table.boolean("active");
    });
    await f.db("user").insert({ id: 1,
        password: generatePasswordHash("test-password"),
        active: true });
    const handlers = new Map<string, (request: unknown, callback: unknown) => Promise<void>>();
    const socket = {
        userID: 1,
        authenticated: true,
        on: (event: string, handler: (request: unknown, callback: unknown) => Promise<void>) => handlers.set(event, handler),
    } as unknown as DockgeSocket;
    new ApiKeySocketHandler().create(socket, f.server);
    const call = (event: string, request: unknown = {}): Promise<Record<string, unknown>> => new Promise(resolve => {
        void handlers.get(event)!(request, resolve);
    });
    try {
        socket.userID = 0;
        assert.equal((await call("listApiKeys")).ok, false);
        socket.userID = 1;
        assert.equal((await call("listApiKeys")).ok, true);
        disabled = true;
        assert.equal((await call("listApiKeys")).ok, false);
        assert.equal((await call("listApiKeys", { password: "wrong" })).ok, false);
        assert.equal((await call("listApiKeys", { password: "test-password" })).ok, true);
        // Turning the global setting back on cannot promote an auto-login socket.
        disabled = false;
        socket.authenticated = false;
        assert.equal((await call("createApiKey", { name: "blocked",
            permission: "manage" })).ok, false);
        const created = await call("createApiKey", { name: "valid",
            permission: "operate",
            password: "test-password" });
        assert.equal(created.ok, true);
        assert.equal(typeof created.secret, "string");
        const id = (created.key as { id: string }).id;
        assert.equal((await call("revokeApiKey", { id })).ok, false);
        assert.equal((await call("revokeApiKey", { id,
            password: "test-password" })).ok, true);
        assert.equal((await call("listApiKeys", null)).ok, false);
    } finally {
        Settings.get = originalGet;
        await f.close();
    }
});
