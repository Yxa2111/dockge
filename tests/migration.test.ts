import { test } from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import Dialect from "knex/lib/dialects/sqlite3/index.js";
import sqlite from "@louislam/sqlite3";
import { up as users } from "../backend/migrations/2023-10-20-0829-user-table";
import { up as settings } from "../backend/migrations/2023-10-20-0829-setting-table";
import { up as agents } from "../backend/migrations/2023-12-20-2117-agent-table";
import { up, down } from "../backend/migrations/2026-09-27-0000-http-api";

test("1.5.0 database upgrade preserves existing users, settings and agents", async () => {
    Dialect.prototype._driver = () => sqlite;
    const db = knex({ client: Dialect,
        connection: { filename: ":memory:" },
        useNullAsDefault: true });
    try {
        await users(db);
        await settings(db);
        await agents(db);
        await db("user").insert({ username: "existing",
            password: "existing-hash" });
        await db("setting").insert({ key: "jwtSecret",
            value: "existing-secret",
            type: "general" });
        await db("agent").insert({ url: "http://example.invalid",
            username: "existing",
            password: "existing-password" });
        const before = await Promise.all([ db("user"), db("setting"), db("agent") ]);
        await up(db);
        assert.equal(await db.schema.hasTable("api_key"), true);
        assert.equal(await db.schema.hasTable("api_operation"), true);
        assert.deepEqual(await Promise.all([ db("user"), db("setting"), db("agent") ]), before);
        await down(db);
        assert.deepEqual(await Promise.all([ db("user"), db("setting"), db("agent") ]), before);
    } finally {
        await db.destroy();
    }
});
