import express from "express";
import { readFileSync } from "fs";
import { randomUUID, timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools, WRITE_TOOLS } from "../tools/index.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokensPure,
  refreshTokensPure,
  isBrokerMode,
  getBrokerUrl,
  pollBrokerOnce,
  refreshTokensViaBroker,
} from "../auth/oauth.js";
import { fetchClioWhoAmI } from "../auth/clioOAuth.js";
import type { ClioTokens } from "../auth/oauth.js";
import { sessionStorage, SessionContext, PendingBrokerSession } from "../utils/sessionContext.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { createApiKeyMiddleware, resolveHttpAuthConfig, PUBLIC_PATHS } from "./httpAuth.js";
import type { HttpAuthConfig } from "./httpAuth.js";
import { resolveMcpBaseUrl } from "../config/mcpBaseUrl.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthConfig } from "./oauth/config.js";
import type { ClioProxyOAuthProvider } from "./oauth/provider.js";
import { ClioSignInRequiredError } from "./oauth/clio.js";
import type { ClioTokenVault } from "./oauth/clio.js";
import type { OAuthStore } from "./oauth/store.js";
import { mountOAuthRoutes, resourceMetadataUrl } from "./oauth/routes.js";
import { escapeHtml } from "./oauth/pages.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

export interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer | null;
  /** OAuth mode: the attorney whose bearer token opened the session. Nobody else may use it. */
  ownerClioUserId?: string;
  tokens: ClioTokens | null;
  pendingOAuthNonce: string | null;
  /** Broker mode: the PKCE verifier parked between authorize and callback. */
  pendingBroker: PendingBrokerSession | null;
  /** Shared by concurrent tool calls so an expiring token is refreshed once per session. */
  refreshInFlight: Promise<ClioTokens> | null;
  createdAt: number;
}

const sessions = new Map<string, SessionRecord>();

export interface OAuthRuntime {
  config: OAuthConfig;
  provider: ClioProxyOAuthProvider;
  vault: ClioTokenVault;
  store: OAuthStore;
}

export interface HttpServerOptions {
  /** Leave the write tools unregistered for every session (READ_ONLY=true). */
  readOnly?: boolean;
  /** AUTH_MODE=oauth: Claude signs each attorney in; replaces the shared API key. */
  oauth?: OAuthRuntime;
}

function createMcpServer(opts: HttpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "clio-mcp", version: pkg.version });
  // In OAuth mode sign-in happens in Claude's connector UI, so only auth_status makes sense.
  registerAllTools(server, { readOnly: opts.readOnly, auth: opts.oauth ? "status" : "full" });
  return server;
}

/** OAuth mode: each tool call acts as the signed-in attorney, using their own Clio tokens. */
export function buildOAuthSessionContext(sessionId: string, clioUserId: string, vault: ClioTokenVault): SessionContext {
  const unsupported = async () => {
    throw new Error("Sign-in is managed by Claude. Disconnect and reconnect the Clio connector to sign in again.");
  };
  return {
    sessionId,
    userId: clioUserId,
    clioUserId,
    getAccessToken: async () => (await vault.getFreshTokens(clioUserId)).access_token,
    getTokens: async () => {
      try {
        return await vault.getFreshTokens(clioUserId);
      } catch (err) {
        if (err instanceof ClioSignInRequiredError) return null;
        throw err;
      }
    },
    storeTokens: unsupported,
    clearTokens: unsupported,
  };
}

/**
 * Advances a broker login that has not finished yet.
 *
 * A dead session (expired, forged, or already consumed) is cleared rather than
 * retried, so the caller gets a clean "authenticate again" path instead of
 * polling something that can never succeed.
 */
async function pollPendingBrokerSession(record: SessionRecord): Promise<void> {
  const pending = record.pendingBroker;
  if (!pending) return;

  let result;
  try {
    result = await pollBrokerOnce(getBrokerUrl(), pending.brokerSessionId, pending.codeVerifier);
  } catch (err: any) {
    record.pendingBroker = null;
    throw err;
  }

  if (result.status === "pending") {
    throw new Error("Login is still in progress. Finish the Clio login in your browser, then try again.");
  }

  record.pendingBroker = null;
  record.tokens = result.tokens;
  try {
    const me = await fetchClioWhoAmI(record.tokens.access_token);
    if (me?.id) record.tokens.clio_user_id = String(me.id);
  } catch { /* identity is a convenience here, not a gate */ }

  await appendAuditLog({
    tool: "oauth_callback",
    args: {},
    outcome: "success",
    clio_user_id: record.tokens.clio_user_id,
  });
}

/**
 * Resolves a usable access token for this session, completing a broker login or
 * refreshing an expiring token as needed. Wrapped in a single-flight guard by
 * the caller, so concurrent tool calls share one refresh rather than racing:
 * Clio may rotate the refresh token on use, and the loser of a race would
 * otherwise persist a token that is already dead.
 */
async function doGetAccessToken(record: SessionRecord): Promise<ClioTokens> {
  if (!record.tokens) {
    if (isBrokerMode() && record.pendingBroker) {
      await pollPendingBrokerSession(record);
    } else {
      throw new Error(
        "Not authenticated. Call the 'authenticate' tool to get a login URL, " +
        "complete OAuth in your browser, then try again."
      );
    }
  }
  const current = record.tokens!;
  if (Date.now() > current.expires_at - 5 * 60 * 1000) {
    const refreshed = isBrokerMode()
      ? await refreshTokensViaBroker(current.refresh_token)
      : await refreshTokensPure(current.refresh_token);
    record.tokens = { ...refreshed, clio_user_id: current.clio_user_id };
  }
  return record.tokens!;
}

/** Exported for tests. */
export function buildSessionContext(record: SessionRecord, sessionId: string): SessionContext {
  return {
    sessionId,
    get clioUserId() { return record.tokens?.clio_user_id; },
    getAccessToken: async () => {
      if (record.refreshInFlight) return (await record.refreshInFlight).access_token;
      record.refreshInFlight = doGetAccessToken(record);
      try {
        return (await record.refreshInFlight).access_token;
      } finally {
        record.refreshInFlight = null;
      }
    },
    storeTokens: async (tokens: ClioTokens) => { record.tokens = tokens; },
    getTokens: async () => record.tokens,
    clearTokens: async () => { record.tokens = null; },
    setPendingNonce: (nonce: string) => { record.pendingOAuthNonce = nonce; },
    setPendingBrokerSession: (session: PendingBrokerSession | null) => { record.pendingBroker = session; },
    getPendingBrokerSession: () => record.pendingBroker,
  };
}

// Stale session GC: remove sessions older than 24 hours
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, rec] of sessions) {
    if (rec.createdAt < cutoff) {
      rec.transport.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60 * 60 * 1000).unref();

/**
 * Build the Express app. The API-key gate is installed before every route, so
 * all methods on /mcp (POST, GET/SSE stream, DELETE) and any unknown path
 * return 401 without a valid key. Only PUBLIC_PATHS (/health and the OAuth
 * redirect target) are reachable without it. Exported for tests.
 */
export function createApp(auth: HttpAuthConfig, opts: HttpServerOptions = {}): express.Express {
  if (opts.oauth) return createOAuthApp(opts.oauth, opts);
  const app = express();

  app.use(createApiKeyMiddleware(auth));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, sessions: sessions.size });
  });

  app.all("/mcp", express.json(), async (req, res) => {
    try {
      const incomingSessionId = req.headers["mcp-session-id"] as string | undefined;

      if (!incomingSessionId) {
        // New connection: allocate record and create transport
        const record: SessionRecord = {
          transport: null!,
          mcpServer: null,
          tokens: null,
          pendingOAuthNonce: null,
        pendingBroker: null,
          refreshInFlight: null,
          createdAt: Date.now(),
        };

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: async (sessionId) => {
            record.mcpServer = createMcpServer(opts);
            sessions.set(sessionId, record);
            await record.mcpServer.connect(transport);
          },
          onsessionclosed: (sessionId) => {
            sessions.delete(sessionId);
          },
        });
        record.transport = transport;

        // Use a temporary placeholder context for the initialize request.
        // No tools run during initialization, so getAccessToken is never called.
        const tempCtx: SessionContext = {
          sessionId: "",
          getAccessToken: async () => { throw new Error("Not authenticated"); },
          storeTokens: async () => {},
          getTokens: async () => null,
          clearTokens: async () => {},
          setPendingNonce: () => {},
          setPendingBrokerSession: () => {},
          getPendingBrokerSession: () => null,
        };

        await sessionStorage.run(tempCtx, () =>
          transport.handleRequest(req, res, req.body)
        );
      } else {
        // Existing session: route to correct transport
        const record = sessions.get(incomingSessionId);
        if (!record) {
          res.status(404).json({ error: "Session not found" });
          return;
        }
        const ctx = buildSessionContext(record, incomingSessionId);
        await sessionStorage.run(ctx, () =>
          record.transport.handleRequest(req, res, req.body)
        );
      }
    } catch (err: any) {
      console.error("[http] /mcp error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  app.get("/oauth/callback", async (req, res) => {
    const { code, state, error: oauthError } = req.query as Record<string, string>;

    if (oauthError) {
      res.status(400).send(
        `<h1>Authentication Error</h1><p>${escapeHtml(String(oauthError))}</p><p>You can close this tab.</p>`
      );
      return;
    }

    if (!code || !state) {
      res.status(400).send("<h1>Bad Request</h1><p>Missing code or state parameter.</p>");
      return;
    }

    let sessionId: string;
    let nonce: string;
    try {
      const payload = Buffer.from(state, "base64url").toString("utf8");
      const colonIdx = payload.indexOf(":");
      sessionId = payload.slice(0, colonIdx);
      nonce = payload.slice(colonIdx + 1);
    } catch {
      res.status(400).send("<h1>Bad Request</h1><p>Invalid state parameter.</p>");
      return;
    }

    const record = sessions.get(sessionId);
    if (!record || !record.pendingOAuthNonce) {
      res.status(400).send("<h1>Session Not Found</h1><p>Unknown or expired session. Please try again.</p>");
      return;
    }

    // Constant-time comparison to prevent timing attacks
    const expectedBuf = Buffer.from(record.pendingOAuthNonce, "utf8");
    const actualBuf = Buffer.from(nonce, "utf8");
    const nonceValid =
      expectedBuf.length === actualBuf.length &&
      timingSafeEqual(expectedBuf, actualBuf);

    if (!nonceValid) {
      res.status(400).send("<h1>Invalid State</h1><p>State mismatch: possible CSRF attack.</p>");
      return;
    }

    record.pendingOAuthNonce = null;

    try {
      const redirectUri = `${resolveMcpBaseUrl() ?? ""}/oauth/callback`;
      const tokens = await exchangeCodeForTokensPure(code, redirectUri);

      // Attempt to resolve clio_user_id from who_am_i (non-fatal)
      try {
        tokens.clio_user_id = (await fetchClioWhoAmI(tokens.access_token)).id;
      } catch { /* non-fatal */ }

      record.tokens = tokens;

      await appendAuditLog({
        tool: "oauth_callback",
        args: {},
        outcome: "success",
        clio_user_id: tokens.clio_user_id,
      });

      res.send(
        `<!DOCTYPE html><html><head><title>Authentication Successful</title></head>` +
        `<body><h1>✅ Authentication Successful</h1>` +
        `<p>You are now connected to Clio. You can close this tab and return to Claude.</p>` +
        `</body></html>`
      );
    } catch (err: any) {
      console.error("[http] OAuth callback error:", err.message);
      res.status(500).send(
        `<h1>Authentication Failed</h1><p>${escapeHtml(String(err.message))}</p><p>Please try authenticating again.</p>`
      );
    }
  });

  return app;
}

/**
 * AUTH_MODE=oauth. Every /mcp request needs a bearer token this server issued
 * through Claude's sign-in; the token names the attorney, and their session and
 * Clio tokens are theirs alone. There is no API key and no shared Clio login.
 */
function createOAuthApp(oauth: OAuthRuntime, opts: HttpServerOptions): express.Express {
  const app = express();
  // Behind Railway's proxy: needed so rate limits see the caller's IP, not the proxy's.
  app.set("trust proxy", oauth.config.trustProxy);
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  mountOAuthRoutes(app, oauth.config, oauth.provider);

  const bearer = requireBearerAuth({
    verifier: oauth.provider,
    resourceMetadataUrl: resourceMetadataUrl(oauth.config),
  });

  app.all("/mcp", bearer, express.json(), async (req, res) => {
    const clioUserId = req.auth?.extra?.clioUserId;
    if (typeof clioUserId !== "string") {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    try {
      const incomingSessionId = req.headers["mcp-session-id"] as string | undefined;

      if (!incomingSessionId) {
        const record: SessionRecord = {
          transport: null!,
          mcpServer: null,
          ownerClioUserId: clioUserId,
          tokens: null,
          pendingOAuthNonce: null,
          pendingBroker: null,
          refreshInFlight: null,
          createdAt: Date.now(),
        };
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: async (sessionId) => {
            record.mcpServer = createMcpServer(opts);
            sessions.set(sessionId, record);
            await record.mcpServer.connect(transport);
          },
          onsessionclosed: (sessionId) => {
            sessions.delete(sessionId);
          },
        });
        record.transport = transport;

        const ctx = buildOAuthSessionContext("", clioUserId, oauth.vault);
        await sessionStorage.run(ctx, () => transport.handleRequest(req, res, req.body));
        return;
      }

      const record = sessions.get(incomingSessionId);
      // Someone else's session looks exactly like a missing one.
      if (!record || record.ownerClioUserId !== clioUserId) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const ctx = buildOAuthSessionContext(incomingSessionId, clioUserId, oauth.vault);
      await sessionStorage.run(ctx, () => record.transport.handleRequest(req, res, req.body));
    } catch (err: any) {
      console.error("[http] /mcp error:", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  });

  setInterval(() => {
    oauth.provider.sweep();
    oauth.store.purgeExpired(Date.now()).catch((err) => {
      console.error("[oauth] Purging expired tokens failed:", err.message);
    });
  }, 15 * 60 * 1000).unref();

  return app;
}

/**
 * Start the HTTP transport. Auth configuration is resolved first (and throws
 * with a clear message if MCP_API_KEY is missing or too short), so the server
 * never listens in a misconfigured state.
 */
export function startHttpServer(
  auth: HttpAuthConfig = resolveHttpAuthConfig(),
  opts: HttpServerOptions = {}
): void {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const app = createApp(auth, opts);
  app.listen(port, () => {
    const baseUrl = resolveMcpBaseUrl() ?? `http://127.0.0.1:${port}`;
    console.error(`[http] Clio MCP server listening on port ${port}`);
      console.error(`[http] MCP endpoint : ${baseUrl}/mcp`);
      console.error(`[http] Health check : ${baseUrl}/health`);
    if (opts.readOnly) {
      console.error(`[http] Tools        : READ_ONLY=true, ${WRITE_TOOLS.size} write tools not registered`);
    }
    if (opts.oauth) {
      console.error(`[http] Auth         : OAuth (Claude signs each user in with Clio); discovery at ${resourceMetadataUrl(opts.oauth.config)}`);
    } else if (auth.apiKey === null) {
      console.error("[http] ****************************************************************************");
      console.error("[http] WARNING: MCP_ALLOW_UNAUTHENTICATED=true. NO API KEY IS REQUIRED ON ANY ROUTE.");
      console.error("[http] Anyone who can reach this port can drive the connector with your Clio access.");
      console.error("[http] This is for local development only. Never run like this on a public host.");
      console.error("[http] ****************************************************************************");
    } else {
      console.error(
        `[http] Auth         : MCP_API_KEY required (Authorization: Bearer <key>) on every route except ` +
        `${[...PUBLIC_PATHS].join(", ")}`
      );
    }
  });
}
