import { SocketHandler } from "../socket-handler";
import type { DockgeServer } from "../dockge-server";
import { DockgeSocket, callbackError, callbackResult, checkLogin } from "../util-server";
import { StackService } from "../api/stack-service";

export class ResourceSocketHandler extends SocketHandler {
    create(socket: DockgeSocket, server: DockgeServer) {
        let stack: string | undefined;
        const publish = () => {
            if (socket.userID && stack !== undefined) {
                // Volatile messages keep a slow browser from accumulating old snapshots.
                socket.volatile.emit("containerResources", server.resources.current(stack));
            }
        };
        const unsubscribe = () => {
            server.resources.removeListener("snapshot", publish);
            stack = undefined;
        };
        socket.on("subscribeContainerResources", (request: unknown, callback: unknown) => {
            try {
                checkLogin(socket);
                const name = (request as { stack?: unknown })?.stack;
                StackService.validateName(name);
                unsubscribe();
                stack = name;
                server.resources.on("snapshot", publish);
                callbackResult({ ok: true,
                    snapshot: server.resources.current(stack) }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });
        socket.on("unsubscribeContainerResources", (callback: unknown) => {
            unsubscribe();
            callbackResult({ ok: true }, callback);
        });
        socket.on("disconnect", unsubscribe);
    }
}
