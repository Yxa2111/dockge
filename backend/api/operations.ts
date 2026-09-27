import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { R } from "redbean-node";
import type { DockgeServer } from "../dockge-server";
import type { ApiKey } from "./keys";
import { Action, StackService } from "./stack-service";
import { ApiError } from "./errors";
import { log } from "../log";

export interface Operation {
    id: string;
    stack: string;
    action: Action;
    key_id: string;
    state: "running" | "succeeded" | "failed" | "interrupted";
    created_at: number;
    finished_at: number | null;
    exit_code: number | null;
    error: string | null;
    truncated: boolean;
    idempotency_key: string | null;
}

export const LOG_LIMIT = 10 * 1024 * 1024;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class Operations {
    private submissions = new Map<string, Promise<Operation>>();
    private cleanupTimer?: NodeJS.Timeout;
    private active = new Set<Promise<void>>();
    private closing = false;
    readonly directory: string;

    constructor(private server: DockgeServer) {
        this.directory = path.join(server.config.dataDir, "operation-logs");
    }

    async init() {
        fs.mkdirSync(this.directory, { recursive: true,
            mode: 0o700 });
        await R.knex("api_operation").where({ state: "running" }).update({
            state: "interrupted",
            finished_at: Date.now(),
            error: "Dockge restarted before the result was recorded. Inspect the Stack before retrying.",
        });
        await this.cleanup();
        this.cleanupTimer = setInterval(() => this.cleanup().catch(error => log.error("api", String(error))), 60 * 60 * 1000);
        this.cleanupTimer.unref();
    }

    async cleanup() {
        const rows: Operation[] = await R.knex("api_operation").whereNot("state", "running").where("finished_at", "<", Date.now() - RETENTION_MS);
        for (const row of rows) {
            fs.rmSync(this.logPath(row.id), { force: true });
            await R.knex("api_operation").where({ id: row.id }).delete();
        }
    }

    close() {
        this.closing = true;
        clearInterval(this.cleanupTimer);
    }

    async idle() {
        await Promise.all(this.active);
    }

    logPath(id: string) {
        if (!/^[a-f0-9-]{36}$/.test(id)) {
            throw new ApiError(404, "operation_not_found", "Operation not found.");
        }
        return path.join(this.directory, id + ".log");
    }

    async get(id: string): Promise<Operation> {
        this.logPath(id);
        const operation = await R.knex("api_operation").where({ id }).first();
        if (!operation) {
            throw new ApiError(404, "operation_not_found", "Operation not found.");
        }
        return { ...operation,
            truncated: Boolean(operation.truncated) };
    }

    readLog(id: string, offset: number, limit: number) {
        const filename = this.logPath(id);
        if (!fs.existsSync(filename)) {
            return { text: "",
                next_offset: offset };
        }
        const fd = fs.openSync(filename, "r");
        try {
            const buffer = Buffer.alloc(limit);
            const size = fs.readSync(fd, buffer, 0, limit, offset);
            // Avoid splitting a UTF-8 character across pages. Offsets are bytes.
            let end = size;
            if (size === limit && size > 0) {
                let start = size - 1;
                while (start > 0 && (buffer[start] & 0xc0) === 0x80) {
                    start--;
                }
                const lead = buffer[start];
                const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
                if (size - start < expected) {
                    end = start;
                }
            }
            return { text: buffer.subarray(0, end).toString("utf8"),
                next_offset: offset + end };
        } finally {
            fs.closeSync(fd);
        }
    }

    async submit(key: ApiKey, stack: string, action: Action, idempotencyKey?: string): Promise<Operation> {
        if (this.closing) {
            throw new ApiError(503, "shutting_down", "Dockge is shutting down.");
        }
        StackService.validateName(stack);
        if (idempotencyKey !== undefined && !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) {
            throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1–200 printable non-space ASCII characters.");
        }
        const admission = key.id + ":" + (idempotencyKey ?? randomUUID());
        const pending = this.submissions.get(admission);
        if (pending) {
            return this.match(await pending, stack, action);
        }
        const promise = this.admit(key, stack, action, idempotencyKey);
        this.submissions.set(admission, promise);
        try {
            return await promise;
        } finally {
            this.submissions.delete(admission);
        }
    }

    private match(operation: Operation, stack: string, action: Action) {
        if (operation.stack !== stack || operation.action !== action) {
            throw new ApiError(409, "idempotency_conflict", "Idempotency-Key was already used for a different request.");
        }
        return operation;
    }

    private async admit(key: ApiKey, stack: string, action: Action, idempotencyKey?: string) {
        if (idempotencyKey) {
            const previous = await R.knex("api_operation").where({ key_id: key.id,
                idempotency_key: idempotencyKey }).first();
            if (previous) {
                return this.match(previous, stack, action);
            }
        }
        const release = StackService.acquire(this.server, stack);
        const operation: Operation = {
            id: randomUUID(),
            stack,
            action,
            key_id: key.id,
            state: "running",
            created_at: Date.now(),
            finished_at: null,
            exit_code: null,
            error: null,
            truncated: false,
            idempotency_key: idempotencyKey ?? null,
        };
        try {
            await StackService.managed(this.server, stack);
            fs.writeFileSync(this.logPath(operation.id), "", { mode: 0o600,
                flag: "wx" });
            await R.knex("api_operation").insert(operation);
        } catch (error) {
            release();
            fs.rmSync(this.logPath(operation.id), { force: true });
            throw error;
        }
        const work = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.run(operation, release));
        this.active.add(work);
        void work.finally(() => this.active.delete(work));
        return { ...operation };
    }

    private async run(operation: Operation, release: () => void) {
        let bytes = 0;
        let logError: Error | undefined;
        const append = (data: string) => {
            try {
                const buffer = Buffer.from(data);
                const remaining = LOG_LIMIT - bytes;
                if (buffer.length > remaining) {
                    operation.truncated = true;
                }
                if (remaining > 0) {
                    const chunk = buffer.subarray(0, remaining);
                    fs.appendFileSync(this.logPath(operation.id), chunk);
                    bytes += chunk.length;
                }
            } catch (error) {
                logError = error instanceof Error ? error : new Error(String(error));
            }
        };
        try {
            append(`Starting ${operation.action} for ${operation.stack}\n`);
            await StackService.execute(this.server, operation.stack, operation.action, {
                onData: append,
                onExit: code => {
                    operation.exit_code = code;
                },
            });
            if (logError) {
                throw new Error("Command completed, but writing its execution log failed: " + logError.message);
            }
            operation.state = "succeeded";
        } catch (error) {
            operation.state = "failed";
            operation.error = error instanceof Error ? error.message : String(error);
            append("\n" + operation.error + "\n");
        } finally {
            operation.finished_at = Date.now();
            try {
                await R.knex("api_operation").where({ id: operation.id }).update(operation);
            } catch (error) {
                log.error("api", `Unable to persist operation ${operation.id}: ${String(error)}`);
            }
            release();
            try {
                await this.server.sendStackList();
            } catch (error) {
                log.error("api", String(error));
            }
        }
    }
}
