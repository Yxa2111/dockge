import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import knex from "knex";
import Dialect from "knex/lib/dialects/sqlite3/index.js";
import sqlite from "@louislam/sqlite3";
import { R } from "redbean-node";
import { up } from "../backend/migrations/2026-09-27-0000-http-api";
import { ApiDocsRouter } from "../backend/routers/api-docs-router";
import { ApiRouter } from "../backend/routers/api-router";
import { ApiKeys } from "../backend/api/keys";
import { Operations } from "../backend/api/operations";
import type { DockgeServer } from "../backend/dockge-server";
import type { Permission } from "../backend/api/errors";

export async function fixture() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-api-test-"));
    const stacksDir = path.join(directory, "stacks");
    await fs.mkdir(stacksDir);
    Dialect.prototype._driver = () => sqlite;
    const db = knex({ client: Dialect,
        connection: { filename: path.join(directory, "test.db") },
        useNullAsDefault: true,
        pool: { min: 1,
            max: 1 } });
    R.setup(db);
    await up(db);
    const server = { stacksDir,
        config: { dataDir: directory },
        sendStackList: async () => {} } as unknown as DockgeServer;
    server.operations = new Operations(server);
    await server.operations.init();
    const app = express();
    app.use(new ApiRouter().create(app, server));
    app.use(new ApiDocsRouter().create(app, server));
    const http = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => http.on("listening", resolve));
    const address = http.address();
    if (!address || typeof address === "string") {
        throw new Error("No listener");
    }
    const url = `http://127.0.0.1:${address.port}/api/v1`;
    const keys = {} as Record<Permission, Awaited<ReturnType<typeof ApiKeys.create>>>;
    for (const role of [ "read", "operate", "manage" ] as Permission[]) {
        keys[role] = await ApiKeys.create(role, role, null);
    }
    const request = async (method: string, endpoint: string, role: Permission | null = "manage", body?: unknown, extra: Record<string, string> = {}) => {
        const response = await fetch(url + endpoint, {
            method,
            headers: { ...(role ? { Authorization: `Bearer ${keys[role].secret}` } : {}),
                "Content-Type": "application/json",
                ...extra },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status,
            body: await response.json() };
    };
    return {
        directory,
        server,
        db,
        url,
        keys,
        request,
        async close() {
            server.operations.close();
            await server.operations.idle();
            http.closeAllConnections();
            await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
            await db.destroy();
            await fs.rm(directory, { recursive: true,
                force: true });
        },
    };
}

export const config = {
    composeYAML: "# preserve this comment\nservices:\n  web:\n    image: alpine:latest\n    command: [sh, -c, 'echo dockge-api-smoke; sleep 300']\n",
    composeENV: "HELLO=world\n",
};
