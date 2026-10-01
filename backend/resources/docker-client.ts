import path from "node:path";
import http from "node:http";
import type { ContainerIdentity } from "../../common/container-resources";

export interface StatsSource {
    list(): Promise<ContainerIdentity[]>;
    stats(id: string): Promise<unknown>;
    close(): void;
}

/** Read-only Engine requests over the existing Docker socket, with bounded time/body size. */
export class DockerStatsClient implements StatsSource {
    private agent = new http.Agent({ keepAlive: true,
        maxSockets: 8 });

    private version?: Promise<string>;

    constructor(private socketPath = process.env.DOCKGE_DOCKER_SOCKET || "/var/run/docker.sock", private timeout = 4000, private stacksDir?: string) {}

    request(url: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const request = http.request({ socketPath: this.socketPath,
                path: url,
                method: "GET",
                agent: this.agent }, response => {
                const chunks: Buffer[] = [];
                let bytes = 0;
                response.on("data", (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > 8 * 1024 * 1024) {
                        request.destroy(new Error("Docker statistics response exceeded 8 MiB."));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on("error", reject);
                response.on("aborted", () => reject(new Error("Docker statistics response was interrupted.")));
                response.on("end", () => {
                    if (response.statusCode !== 200) {
                        reject(new Error(`Docker statistics request returned HTTP ${response.statusCode}.`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                    } catch {
                        reject(new Error("Docker returned invalid statistics JSON."));
                    }
                });
            });
            const timer = setTimeout(() => request.destroy(new Error("Docker statistics request timed out.")), this.timeout);
            request.on("error", reject);
            request.on("close", () => clearTimeout(timer));
            request.end();
        });
    }

    private apiVersion(): Promise<string> {
        if (!this.version) {
            this.version = this.request("/version").then(response => {
                const version = (response as { ApiVersion?: unknown }).ApiVersion;
                if (typeof version !== "string" || !/^1\.\d+$/.test(version) || Number(version.split(".")[1]) < 41) {
                    throw new Error("Container statistics require Docker Engine API 1.41 or newer.");
                }
                return "v" + version;
            }).catch(error => {
                this.version = undefined;
                throw error;
            });
        }
        return this.version;
    }

    async list(): Promise<ContainerIdentity[]> {
        const version = await this.apiVersion();
        const result = await this.request(`/${version}/containers/json?all=true`);
        if (!Array.isArray(result)) {
            throw new Error("Docker returned an invalid container inventory.");
        }
        return result.map(item => {
            if (!item || typeof item.Id !== "string" || !/^[a-f0-9]{64}$/.test(item.Id)) {
                throw new Error("Docker returned an invalid container ID.");
            }
            const labels = item.Labels ?? {};
            const project = String(labels["com.docker.compose.project"] ?? "");
            const workingDir = labels["com.docker.compose.project.working_dir"];
            const stack = this.stacksDir && typeof workingDir === "string" && path.dirname(path.resolve(workingDir)) === path.resolve(this.stacksDir) ? path.basename(workingDir) : project;
            const health = String(item.Status ?? "").match(/\((healthy|unhealthy|health: starting)\)$/)?.[1];
            return {
                id: item.Id,
                name: String(item.Names?.[0] ?? item.Id).replace(/^\//, ""),
                image: String(item.Image ?? ""),
                stack,
                project,
                service: String(labels["com.docker.compose.service"] ?? ""),
                state: String(item.State ?? "unknown"),
                health: health === "health: starting" ? "starting" : health === "healthy" || health === "unhealthy" ? health : null,
            };
        });
    }

    async stats(id: string): Promise<unknown> {
        if (!/^[a-f0-9]{64}$/.test(id)) {
            throw new Error("Invalid container ID.");
        }
        return this.request(`/${await this.apiVersion()}/containers/${id}/stats?stream=false&one-shot=true`);
    }

    close() {
        this.agent.destroy();
    }
}
