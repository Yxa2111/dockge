import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import express, { Express } from "express";
import { Router } from "../router";
import type { DockgeServer } from "../dockge-server";

const require = createRequire(import.meta.url);
const distribution = path.dirname(require.resolve("swagger-ui-dist/package.json"));
const version: string = JSON.parse(readFileSync(path.join(distribution, "package.json"), "utf8")).version;
const definition = fileURLToPath(new URL("../../docs/openapi.yaml", import.meta.url));

const initializer = `window.ui = SwaggerUIBundle({
    url: "../openapi.yaml",
    dom_id: "#swagger-ui",
    presets: [SwaggerUIBundle.presets.apis],
    layout: "BaseLayout",
    deepLinking: true,
    filter: true,
    displayRequestDuration: true,
    validatorUrl: null,
    persistAuthorization: false,
    queryConfigEnabled: false,
    tryItOutEnabled: false,
    requestInterceptor: function (request) {
        if (new URL(request.url, window.location.href).origin !== window.location.origin) {
            throw new Error("Requests must stay on this Dockge instance.");
        }
        return request;
    }
});`;

const stylesheet = `body { margin: 0; background: #fafafa; }
.docs-header { background: #161b22; color: #f1f4f8; padding: 24px max(24px, calc((100% - 1460px) / 2)); font-family: system-ui, sans-serif; }
.docs-header nav { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
.docs-header a { color: #8ddbe2; text-decoration: none; }
.docs-header a:hover { text-decoration: underline; }
.docs-header .brand { font-size: 20px; font-weight: 700; margin-right: auto; color: #f1f4f8; display: flex; gap: 10px; align-items: center; }
.docs-header img { width: 30px; height: 30px; }
.docs-header h1 { font-size: 28px; margin: 24px 0 12px; }
.docs-header p { color: #cad1da; line-height: 1.65; margin: 4px 0; max-width: 920px; }
.docs-header code { color: #b0e9ce; }
.swagger-ui .info { margin: 28px 0; }
.swagger-ui .scheme-container { box-shadow: none; border-block: 1px solid #d9dfe5; }
@media (max-width: 600px) { .docs-header { padding: 20px; } .docs-header .brand { flex-basis: 100%; } }
`;

const html = `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>API Documentation · Dockge</title>
    <link rel="icon" href="/icon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="./swagger-ui.css?v=${version}">
    <link rel="stylesheet" href="./docs.css">
</head>
<body>
    <header class="docs-header">
        <nav aria-label="Documentation navigation">
            <a class="brand" href="/"><img src="/icon.svg" alt="">Dockge</a>
            <a href="/settings/api-keys">Manage API keys · 管理密钥</a>
            <a href="../openapi.yaml" download="dockge-openapi.yaml">Download OpenAPI</a>
        </nav>
        <h1>API Documentation · API 文档</h1>
        <p>Browse the local Stack API. Select <strong>Authorize</strong> and enter an API key to try a request. Your key is kept only in this page’s memory.</p>
        <p>点击 <strong>Authorize</strong> 填写密钥后可在线试调；请求作用于当前 Dockge，权限与该密钥一致，刷新页面后需重新填写。</p>
        <p>For streaming logs, use <code>curl -N</code>. Keep <code>follow=false</code> when trying log endpoints here.</p>
    </header>
    <main id="swagger-ui"></main>
    <noscript>Enable JavaScript to view interactive API documentation.</noscript>
    <script src="./swagger-ui-bundle.js?v=${version}"></script>
    <script src="./swagger-init.js"></script>
</body>
</html>`;

/** Public API reference only. All actual API requests retain Bearer authentication. */
export class ApiDocsRouter extends Router {
    create(app: Express, server: DockgeServer) {
        const router = express.Router({ strict: true });
        router.get("/api/docs", (req, res) => res.redirect(302, "/api/docs/"));
        router.get("/api/docs/", (req, res) => {
            res.set({
                "Cache-Control": "no-store",
                "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
            });
            res.type("html").send(html);
        });
        router.get("/api/docs/swagger-init.js", (req, res) => res.set("Cache-Control", "no-store").type("js").send(initializer));
        router.get("/api/docs/docs.css", (req, res) => res.set("Cache-Control", "no-store").type("css").send(stylesheet));
        for (const asset of [ "swagger-ui.css", "swagger-ui-bundle.js" ]) {
            router.get(`/api/docs/${asset}`, (req, res) => res.sendFile(path.join(distribution, asset), { maxAge: "1d" }));
        }
        router.get("/api/openapi.yaml", (req, res) => res.sendFile(definition, { cacheControl: false,
            headers: { "Content-Type": "application/yaml; charset=utf-8",
                "Cache-Control": "no-store" } }));
        router.use("/api/docs", (req, res) => res.status(404).json({ error: { code: "not_found",
            message: "Documentation asset not found." } }));
        return router;
    }
}
