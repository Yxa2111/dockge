import express, { Express, Request, Response, NextFunction } from "express";
import { spawn } from "node:child_process";
import type { DockgeServer } from "../dockge-server";
import { Router } from "../router";
import { ApiError, Permission, requirePermission, integer } from "../api/errors";
import type { Operation } from "../api/operations";
import { ApiKeys } from "../api/keys";
import { StackService, actions, Action } from "../api/stack-service";
import { Stack } from "../stack";
import { R } from "redbean-node";
import { log } from "../log";

const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
};

function startEvents(res: Response) {
    res.status(200).set({ "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no" });
    res.flushHeaders();
}

function event(res: Response, name: string, data: unknown) {
    if (!res.destroyed && !res.writableEnded) {
        return res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    return false;
}

function follow(req: Request) {
    if (req.query.follow !== undefined && req.query.follow !== "true" && req.query.follow !== "false") {
        throw new ApiError(400, "invalid_parameter", "follow must be true or false.");
    }
    return req.query.follow === "true";
}

export class ApiRouter extends Router {
    create(app: Express, server: DockgeServer) {
        const root = express.Router();
        const router = express.Router();
        root.use("/api/v1", router);
        router.use((req, res, next) => {
            res.set("Cache-Control", "no-store");
            void ApiKeys.authenticate(req.get("authorization")).then(key => {
                res.locals.apiKey = key;
                next();
            }).catch(next);
        });
        router.use(express.json({ limit: "1mb",
            strict: true }));
        const route = (method: "get" | "post" | "put" | "delete", url: string, permission: Permission, handler: (req: Request, res: Response) => Promise<unknown>) => {
            router[method](url, asyncRoute(async (req, res) => {
                requirePermission(res.locals.apiKey.permission, permission);
                return handler(req, res);
            }));
        };
        const config = (req: Request) => {
            if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
                throw new ApiError(400, "invalid_config", "A JSON object is required.");
            }
            return req.body;
        };
        route("get", "/containers/stats", "read", async (req, res) => {
            res.json(server.resources.current());
        });
        route("get", "/stacks/:name/stats", "read", async (req, res) => {
            await StackService.managed(server, req.params.name);
            res.json(server.resources.current(req.params.name));
        });
        route("get", "/stacks", "read", async (req, res) => {
            const stacks = await Stack.getStackList(server);
            res.json({ stacks: Array.from(stacks.values(), stack => stack.toSimpleJSON("")) });
        });
        route("get", "/stacks/:name", "read", async (req, res) => {
            StackService.validateName(req.params.name);
            await StackService.checkPath(server, req.params.name, true);
            const stacks = await Stack.getStackList(server);
            const stack = stacks.get(req.params.name);
            if (!stack) {
                throw new ApiError(404, "stack_not_found", "Stack not found.");
            }
            res.json({ ...stack.toSimpleJSON(""),
                services: Object.fromEntries(await stack.getServiceStatusList()) });
        });
        route("post", "/stacks", "manage", async (req, res) => {
            const body = config(req);
            await StackService.withLock(server, body.name, async () => {
                const stack = await StackService.save(server, body.name, body.composeYAML, body.composeENV, true);
                res.status(201).json(stack.toSimpleJSON(""));
            });
            await server.sendStackList();
        });
        route("get", "/stacks/:name/config", "manage", async (req, res) => {
            const stack = await StackService.managed(server, req.params.name);
            res.json({ composeYAML: stack.composeYAML,
                composeENV: stack.composeENV });
        });
        route("put", "/stacks/:name/config", "manage", async (req, res) => {
            const body = config(req);
            await StackService.withLock(server, req.params.name, async () => {
                await StackService.save(server, req.params.name, body.composeYAML, body.composeENV, false);
                res.json({ saved: true });
            });
            await server.sendStackList();
        });
        const submit = async (req: Request, res: Response, action: Action) => {
            const operation = await server.operations.submit(res.locals.apiKey, req.params.name, action, req.get("Idempotency-Key"));
            const url = `/api/v1/operations/${operation.id}`;
            res.status(202).location(url).json({ operation_id: operation.id,
                url,
                state: operation.state });
        };
        route("post", "/stacks/:name/actions/:action", "operate", async (req, res) => {
            const action = req.params.action as Action;
            if (!actions.includes(action) || action === "delete") {
                throw new ApiError(400, "invalid_action", "Unknown Stack action.");
            }
            if (action === "deploy" || action === "down") {
                requirePermission(res.locals.apiKey.permission, "manage");
            }
            return submit(req, res, action);
        });
        route("delete", "/stacks/:name", "manage", (req, res) => submit(req, res, "delete"));
        route("get", "/operations", "read", async (req, res) => {
            const limit = integer(req.query.limit, 50, 200, 1);
            const offset = integer(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
            const query = R.knex("api_operation").orderBy("created_at", "desc").orderBy("id").limit(limit + 1).offset(offset);
            if (req.query.stack !== undefined) {
                StackService.validateName(req.query.stack);
                query.where({ stack: req.query.stack });
            }
            const rows: Operation[] = await query;
            res.json({ operations: rows.slice(0, limit).map(row => ({ ...row,
                truncated: Boolean(row.truncated) })),
            next_offset: rows.length > limit ? offset + limit : null });
        });
        route("get", "/operations/:id", "read", async (req, res) => res.json(await server.operations.get(req.params.id)));
        route("get", "/operations/:id/logs", "read", async (req, res) => {
            let offset = integer(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
            const limit = integer(req.query.limit, 65536, 1048576, 4);
            const operation = await server.operations.get(req.params.id);
            if (!follow(req)) {
                res.json({ ...server.operations.readLog(operation.id, offset, limit),
                    truncated: Boolean(operation.truncated) });
                return;
            }
            startEvents(res);
            let busy = false;
            let blocked = false;
            res.on("drain", () => {
                blocked = false;
            });
            const tick = async () => {
                if (busy || blocked || res.destroyed) {
                    return;
                }
                busy = true;
                try {
                    await ApiKeys.authenticate(req.get("authorization"));
                    const current = await server.operations.get(operation.id);
                    const chunk = server.operations.readLog(operation.id, offset, limit);
                    offset = chunk.next_offset;
                    if (chunk.text) {
                        blocked = !event(res, "log", chunk);
                    } else if (current.state !== "running") {
                        event(res, "end", current);
                        res.end();
                    } else {
                        blocked = !event(res, "heartbeat", { offset });
                    }
                } catch (error) {
                    event(res, "error", { message: error instanceof Error ? error.message : "Stream failed." });
                    res.end();
                } finally {
                    busy = false;
                }
            };
            const timer = setInterval(() => {
                void tick();
            }, 1000);
            res.on("close", () => clearInterval(timer));
            void tick();
        });
        route("get", "/stacks/:name/logs", "read", async (req, res) => {
            const stack = await StackService.managed(server, req.params.name);
            const tail = integer(req.query.tail, 100, 5000);
            const streaming = follow(req);
            const args = [ "compose", "logs", "--no-color", "--timestamps", "--tail", String(tail) ];
            if (streaming) {
                args.push("--follow");
            }
            if (req.query.service !== undefined) {
                if (typeof req.query.service !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(req.query.service)) {
                    throw new ApiError(400, "invalid_service", "Invalid service name.");
                }
                args.push("--", req.query.service);
            }
            const child = spawn("docker", args, { cwd: stack.path,
                stdio: [ "ignore", "pipe", "pipe" ] });
            let output = "";
            let bytes = 0;
            let truncated = false;
            let finished = false;
            if (streaming) {
                startEvents(res);
            }
            const stop = () => {
                child.kill();
            };
            res.on("close", stop);
            res.on("drain", () => {
                child.stdout.resume();
                child.stderr.resume();
            });
            const write = (data: string) => {
                if (streaming) {
                    if (!event(res, "log", { text: data })) {
                        child.stdout.pause();
                        child.stderr.pause();
                    }
                } else {
                    const chunk = Buffer.from(data);
                    const remaining = 1048576 - bytes;
                    output += chunk.subarray(0, remaining).toString("utf8");
                    bytes += Math.min(chunk.length, remaining);
                    if (chunk.length > remaining) {
                        truncated = true;
                        stop();
                    }
                }
            };
            child.stdout.setEncoding("utf8").on("data", write);
            child.stderr.setEncoding("utf8").on("data", write);
            const finish = (code: number | null, error?: string) => {
                if (finished) {
                    return;
                }
                finished = true;
                clearInterval(authTimer);
                clearTimeout(timeout);
                if (res.destroyed) {
                    return;
                }
                if (streaming) {
                    event(res, error || code !== 0 ? "error" : "end", { exit_code: code,
                        message: error });
                    res.end();
                } else if (code !== 0 && !truncated) {
                    res.status(502).json({ error: { code: "docker_error",
                        message: error ?? "Unable to read Docker logs.",
                        details: output } });
                } else {
                    res.json({ text: output,
                        truncated });
                }
            };
            const authTimer = setInterval(() => {
                void ApiKeys.authenticate(req.get("authorization")).catch(() => {
                    finish(null, "API Key expired or was revoked.");
                    stop();
                });
            }, 10000);
            const timeout = streaming ? undefined : setTimeout(() => {
                finish(null, "Timed out reading logs.");
                stop();
            }, 30000);
            res.on("close", () => {
                clearInterval(authTimer);
                clearTimeout(timeout);
            });
            child.on("error", error => finish(null, error.message));
            child.on("close", code => finish(code));
        });
        router.use((req, res) => res.status(404).json({ error: { code: "not_found",
            message: "API route not found." } }));
        router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
            if (res.headersSent) {
                next(error);
                return;
            }
            if (error instanceof ApiError) {
                if (error.status === 401) {
                    res.set("WWW-Authenticate", "Bearer");
                }
                res.status(error.status).json({ error: { code: error.code,
                    message: error.message } });
            } else if (error instanceof SyntaxError || (error as { type?: string })?.type === "entity.too.large") {
                const large = (error as { type?: string }).type === "entity.too.large";
                res.status(large ? 413 : 400).json({ error: { code: "invalid_json",
                    message: large ? "Request exceeds 1 MiB." : "Invalid JSON body." } });
            } else {
                log.error("api", String(error));
                res.status(500).json({ error: { code: "internal_error",
                    message: "Request failed. See the Dockge server log." } });
            }
        });
        return root;
    }
}
