#!/usr/bin/env node
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getClioRegion, CLIO_REGION_BASE_URLS } from './utils/clioRegion.js';
import { resolveHttpAuthConfig } from './server/httpAuth.js';
import { validateAuthEnv } from './config/startupValidation.js';
import { resolveMcpBaseUrl } from './config/mcpBaseUrl.js';
import { resolveAuthMode, resolveOAuthConfig } from './server/oauth/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function fatal(message: string): never {
    console.error(`[startup] Fatal: ${message}`);
    process.exit(1);
}

/** AUTH_MODE=oauth: validate config, connect to the token store and check its tables before listening. */
async function buildOAuthRuntime() {
    const config = resolveOAuthConfig(process.env);
    const { MemoryOAuthStore, PostgresOAuthStore } = await import('./server/oauth/store.js');
    const { ClioTokenVault, createEnvClioAdapter } = await import('./server/oauth/clio.js');
    const { ClioProxyOAuthProvider } = await import('./server/oauth/provider.js');
    const { createClaudeClientsStore } = await import('./server/oauth/claudeClients.js');

    const store = config.store.kind === "postgres"
        ? PostgresOAuthStore.fromUrl(config.store.databaseUrl)
        : new MemoryOAuthStore();
    await store.checkSchema();
    if (config.store.kind === "memory") {
        console.error("[startup] OAUTH_STORE=memory: sign-ins are lost on every restart. Use Postgres in production.");
    }

    const clio = createEnvClioAdapter(process.env);
    const vault = new ClioTokenVault(store, config.encryptionKey, clio);
    const provider = new ClioProxyOAuthProvider({
        config, store, clio, vault, clients: createClaudeClientsStore(),
    });
    console.error(
        `[startup] AUTH_MODE=oauth: Claude sign-in via Clio, allowed email domains: ${config.allowedEmailDomains.join(", ")}` +
        (config.allowedAccountId ? `, Clio account ${config.allowedAccountId} only` : "")
    );
    return { config, provider, vault, store };
}

async function main() {
    const authEnv = validateAuthEnv(process.env);
    if (!authEnv.ok) {
        fatal(authEnv.message.replace(/^\[startup\] Fatal: /, ""));
    }

    // Fail fast on an unknown CLIO_REGION (both transports). No silent fallback to the US endpoint.
    const region = (() => {
        try { return getClioRegion(); }
        catch (err: any) { return fatal(err.message); }
    })();
    console.error(`[startup] Clio region: ${region} (${CLIO_REGION_BASE_URLS[region]})`);

    const mode = (process.env.TRANSPORT ?? "http").toLowerCase();

    // READ_ONLY=true leaves the 9 write tools unregistered on either transport.
    const { registerAllTools, isReadOnlyEnv, WRITE_TOOLS } = await import("./tools/index.js");
    const readOnly = isReadOnlyEnv();
    if (readOnly) {
        console.error(`[startup] READ_ONLY=true: ${WRITE_TOOLS.size} write tools are not registered (${[...WRITE_TOOLS].join(", ")})`);
    }

    if (mode === "stdio") {
        const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
        const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

        const server = new McpServer({ name: "clio-mcp", version: pkg.version });
        registerAllTools(server, { readOnly });

        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("Clio MCP server running on stdio");
    } else {
        if (!resolveMcpBaseUrl()) {
            fatal("MCP_BASE_URL is required in HTTP mode (e.g. https://mcp.example.com). Set TRANSPORT=stdio for local single-user mode.");
        }
        const authMode = (() => {
            try { return resolveAuthMode(process.env); }
            catch (err: any) { return fatal(err.message); }
        })();
        const { startHttpServer } = await import("./server/http.js");

        if (authMode === "oauth") {
            const oauth = await buildOAuthRuntime().catch((err: any) => fatal(err.message));
            startHttpServer({ apiKey: null }, { readOnly, oauth });
            return;
        }

        // MCP_API_KEY is mandatory in HTTP mode (min 24 chars). Only MCP_ALLOW_UNAUTHENTICATED=true
        // (local development) lets the server start without it, with a loud warning.
        const auth = (() => {
            try { return resolveHttpAuthConfig(); }
            catch (err: any) { return fatal(err.message); }
        })();
        startHttpServer(auth, { readOnly });
    }
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
