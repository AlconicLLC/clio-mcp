#!/usr/bin/env node
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getClioRegion, CLIO_REGION_BASE_URLS } from './utils/clioRegion.js';
import { resolveHttpAuthConfig } from './server/httpAuth.js';
import { validateAuthEnv } from './config/startupValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function fatal(message: string): never {
    console.error(`[startup] Fatal: ${message}`);
    process.exit(1);
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

    // READ_ONLY=true leaves the write tools unregistered on either transport.
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
        if (!process.env.MCP_BASE_URL) {
            fatal("MCP_BASE_URL is required in HTTP mode (e.g. https://mcp.example.com). Set TRANSPORT=stdio for local single-user mode.");
        }
        // MCP_API_KEY is mandatory in HTTP mode (min 24 chars). Only MCP_ALLOW_UNAUTHENTICATED=true
        // (local development) lets the server start without it, with a loud warning.
        const auth = (() => {
            try { return resolveHttpAuthConfig(); }
            catch (err: any) { return fatal(err.message); }
        })();
        const { startHttpServer } = await import("./server/http.js");
        startHttpServer(auth, { readOnly });
    }
}

const subcommand = process.argv[2];
if (subcommand === "auth" || subcommand === "export") {
    import("./cli/index.js")
        .then(({ runCli }) => runCli(process.argv.slice(2)))
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error(`Fatal error: ${error instanceof Error ? error.message : "unknown error"}`);
            process.exit(5);
        });
} else {
    main().catch((error) => {
        console.error("Fatal error in main():", error);
        process.exit(1);
    });
}
