import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import yaml from "yaml";
import { fixture } from "./helpers";
import { MetricsRouter } from "../backend/routers/metrics-router";
import { ApiRouter } from "../backend/routers/api-router";

test("bundled Swagger UI, single-source definition and API authentication", async () => {
    const f = await fixture();
    const origin = new URL(f.url).origin;
    try {
        const redirect = await fetch(origin + "/api/docs", { redirect: "manual" });
        assert.equal(redirect.status, 302);
        assert.equal(redirect.headers.get("location"), "/api/docs/");
        const response = await fetch(origin + "/api/docs/");
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-security-policy")!, /connect-src 'self'/);
        const html = await response.text();
        assert.match(html, /Swagger|swagger/);
        assert.match(html, /\/settings\/api-keys/);
        assert.doesNotMatch(html, /https?:\/\//);
        for (const asset of [ "swagger-ui.css", "swagger-ui-bundle.js", "docs.css", "swagger-init.js" ]) {
            const file = await fetch(origin + "/api/docs/" + asset);
            assert.equal(file.status, 200, asset);
            assert.ok((await file.text()).length > 100);
        }
        const initializer = await (await fetch(origin + "/api/docs/swagger-init.js")).text();
        assert.match(initializer, /persistAuthorization: false/);
        assert.match(initializer, /validatorUrl: null/);
        assert.match(initializer, /queryConfigEnabled: false/);
        assert.equal((await fetch(origin + "/api/docs/missing.js")).status, 404);
        const definition = await fetch(origin + "/api/openapi.yaml");
        assert.equal(definition.status, 200);
        assert.match(definition.headers.get("content-type")!, /application\/yaml/);
        const raw = await definition.text();
        assert.equal(raw, readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
        const spec = yaml.parse(raw);
        assert.deepEqual(spec.servers, [{ url: "/api/v1" }]);
        assert.equal(spec.components.securitySchemes.ApiKey.scheme, "bearer");
        // Every documented business operation must correspond to a real route.
        const router = new ApiRouter().create(express(), f.server);
        const actual: string[] = [];
        for (const layer of router.stack[0].handle.stack) {
            if (layer.route) {
                for (const method of Object.keys(layer.route.methods)) {
                    actual.push(method + " " + layer.route.path.replace(/:([a-z]+)/g, "{$1}"));
                }
            }
        }
        for (const layer of new MetricsRouter().create(express(), f.server).stack) {
            if (layer.route) {
                for (const method of Object.keys(layer.route.methods)) {
                    actual.push(method + " " + layer.route.path);
                }
            }
        }
        const documented = Object.entries(spec.paths).flatMap(([ route, operations ]) => Object.keys(operations as object).map(method => method + " " + route));
        assert.deepEqual(actual.sort(), documented.sort());
        assert.equal((await f.request("GET", "/stacks", null)).status, 401);
        assert.equal((await f.request("POST", "/stacks", "read", {})).status, 403);
    } finally {
        await f.close();
    }
});
