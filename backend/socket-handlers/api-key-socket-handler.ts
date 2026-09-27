import { SocketHandler } from "../socket-handler";
import { DockgeServer } from "../dockge-server";
import { DockgeSocket, checkLogin, doubleCheckPassword, callbackError, callbackResult } from "../util-server";
import { Settings } from "../settings";
import { ApiKeys } from "../api/keys";
import { loginRateLimiter } from "../rate-limiter";

export class ApiKeySocketHandler extends SocketHandler {
    create(socket: DockgeSocket, server: DockgeServer) {
        for (const event of [ "listApiKeys", "createApiKey", "revokeApiKey" ]) {
            socket.on(event, async (request: unknown, callback: unknown) => {
                try {
                    checkLogin(socket);
                    if (!request || typeof request !== "object" || Array.isArray(request)) {
                        throw new Error("Invalid request.");
                    }
                    const data = request as Record<string, unknown>;
                    if (!socket.authenticated || await Settings.get("disableAuth")) {
                        if (!await loginRateLimiter.pass(() => {})) {
                            throw new Error("Too many attempts. Try again later.");
                        }
                        await doubleCheckPassword(socket, data.password);
                    }
                    if (event === "listApiKeys") {
                        callbackResult({ ok: true,
                            keys: await ApiKeys.list() }, callback);
                    } else if (event === "createApiKey") {
                        callbackResult({ ok: true,
                            ...await ApiKeys.create(data.name, data.permission, data.expires_at) }, callback);
                    } else {
                        await ApiKeys.revoke(data.id);
                        callbackResult({ ok: true }, callback);
                    }
                } catch (error) {
                    callbackError(error, callback);
                }
            });
        }
    }
}
