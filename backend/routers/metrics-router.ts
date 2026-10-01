import express, { Express } from "express";
import { Router } from "../router";
import type { DockgeServer } from "../dockge-server";
import { ApiKeys } from "../api/keys";
import { ApiError, requirePermission } from "../api/errors";
import { prometheusMetrics } from "../resources/prometheus";

export class MetricsRouter extends Router {
    create(app: Express, server: DockgeServer) {
        const router = express.Router();
        router.get("/metrics", (req, res) => {
            res.set("Cache-Control", "no-store");
            void ApiKeys.authenticate(req.get("authorization")).then(key => {
                requirePermission(key.permission, "read");
                res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(prometheusMetrics(server.resources.current()));
            }).catch(error => {
                const status = error instanceof ApiError ? error.status : 500;
                if (status === 401) {
                    res.set("WWW-Authenticate", "Bearer");
                }
                res.status(status).json({ error: { code: error instanceof ApiError ? error.code : "internal_error",
                    message: error instanceof ApiError ? error.message : "Metrics request failed." } });
            });
        });
        return router;
    }
}
