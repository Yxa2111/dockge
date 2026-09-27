import fs from "node:fs/promises";
import path from "node:path";
import type { DockgeServer } from "../dockge-server";
import type { DockgeSocket } from "../util-server";
import { Stack } from "../stack";
import { ApiError } from "./errors";
import { acceptedComposeFileNames } from "../../common/util-common";

export interface ExecutionContext {
    socket?: DockgeSocket;
    onData?: (data: string) => void;
    onExit?: (exitCode: number) => void;
}

export const actions = [ "start", "stop", "restart", "pull", "update", "deploy", "down", "delete" ] as const;
export type Action = typeof actions[number];

/** Shared by local HTTP and Socket.IO writes, including save-and-deploy. */
export class StackService {
    private static locks = new Set<string>();

    static validateName(name: unknown): asserts name is string {
        if (typeof name !== "string" || !/^[a-z0-9_-]{1,200}$/.test(name)) {
            throw new ApiError(400, "invalid_name", "Stack name must contain 1–200 lowercase letters, digits, underscores or hyphens.");
        }
    }

    static acquire(server: DockgeServer, name: unknown): () => void {
        this.validateName(name);
        const key = path.resolve(server.stacksDir, name);
        if (this.locks.has(key)) {
            throw new ApiError(409, "stack_busy", "Another operation is running for this Stack.");
        }
        this.locks.add(key);
        return () => this.locks.delete(key);
    }

    static async withLock<T>(server: DockgeServer, name: unknown, work: () => Promise<T>): Promise<T> {
        const release = this.acquire(server, name);
        try {
            await this.checkPath(server, name as string, true);
            return await work();
        } finally {
            release();
        }
    }

    static async checkPath(server: DockgeServer, name: string, allowMissing = false) {
        this.validateName(name);
        const root = await fs.realpath(server.stacksDir);
        const dir = path.join(root, name);
        const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
                return undefined;
            }
            throw error;
        });
        if (!stat) {
            if (allowMissing) {
                return;
            }
            throw new ApiError(404, "stack_not_found", "Managed Stack not found.");
        }
        if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(dir) !== dir) {
            throw new ApiError(400, "unsafe_path", "Stack must be a directory directly inside the stacks directory.");
        }
        for (const file of [ ...acceptedComposeFileNames, ".env" ]) {
            const item = await fs.lstat(path.join(dir, file)).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") {
                    return undefined;
                }
                throw error;
            });
            if (item && (!item.isFile() || item.isSymbolicLink() || item.nlink > 1)) {
                throw new ApiError(400, "unsafe_path", "Stack configuration must be regular, unlinked files.");
            }
        }
    }

    static async managed(server: DockgeServer, name: string) {
        await this.checkPath(server, name);
        if (!await Stack.composeFileExists(server.stacksDir, name)) {
            throw new ApiError(404, "stack_not_found", "No Compose file found in this Stack directory.");
        }
        return Stack.getStack(server, name);
    }

    static async save(server: DockgeServer, name: string, composeYAML: unknown, composeENV: unknown, create: boolean) {
        await this.checkPath(server, name, create);
        if (typeof composeYAML !== "string" || typeof composeENV !== "string") {
            throw new ApiError(400, "invalid_config", "composeYAML and composeENV must both be strings.");
        }
        const stack = new Stack(server, name, composeYAML, composeENV);
        try {
            stack.validate();
        } catch (error) {
            throw new ApiError(400, "invalid_config", error instanceof Error ? error.message : "Invalid configuration.");
        }
        if (create && stack.isManagedByDockge) {
            throw new ApiError(409, "stack_exists", "Stack already exists.");
        }
        await stack.save(create);
        return stack;
    }

    static async execute(server: DockgeServer, name: string, action: Action, context: ExecutionContext) {
        const stack = await this.managed(server, name);
        return stack[action](context);
    }
}
