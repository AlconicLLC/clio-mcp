/**
 * Mounts the OAuth endpoints Claude discovers and uses:
 *
 *   /.well-known/oauth-protected-resource[/mcp]  which authorization server protects /mcp
 *   /.well-known/oauth-authorization-server      endpoints and capabilities (incl. CIMD)
 *   /authorize, /token, /revoke                  the SDK's spec-checked handlers
 *   /oauth/consent, /oauth/callback              our consent page and the Clio return leg
 */
import express from "express";
import type { Express } from "express";
import { rateLimit } from "express-rate-limit";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthConfig } from "./config.js";
import type { ClioProxyOAuthProvider } from "./provider.js";

/** Claude's token calls all come from Anthropic's shared egress range, so per-IP limits apply to the whole firm at once. */
const TOKEN_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 600 };
const BROWSER_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 60 };

/**
 * Tool calls are much more frequent than token refreshes, and they share that
 * same egress range, so this ceiling is per IP for the whole firm. A busy
 * Claude session stays under it. A loop opening sessions does not.
 */
export const MCP_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
} as const;

export function buildAuthorizationServerMetadata(config: OAuthConfig): OAuthMetadata {
  const issuer = new URL(config.baseUrl).href;
  const at = (path: string) => new URL(path, issuer).href;
  return {
    issuer,
    authorization_endpoint: at("/authorize"),
    token_endpoint: at("/token"),
    revocation_endpoint: at("/revoke"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
  };
}

export function resourceMetadataUrl(config: OAuthConfig): string {
  return getOAuthProtectedResourceMetadataUrl(config.resourceUrl);
}

export function mountOAuthRoutes(app: Express, config: OAuthConfig, provider: ClioProxyOAuthProvider): void {
  const oauthMetadata = buildAuthorizationServerMetadata(config);

  app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: config.resourceUrl, resourceName: "Clio" }));
  // Some clients probe the origin-level document before the path-specific one.
  app.use("/.well-known/oauth-protected-resource", metadataHandler({
    resource: config.resourceUrl.href,
    authorization_servers: [oauthMetadata.issuer],
    resource_name: "Clio",
  }));

  app.use("/authorize", authorizationHandler({ provider }));
  app.use("/token", tokenHandler({ provider, rateLimit: TOKEN_RATE_LIMIT }));
  app.use("/revoke", revocationHandler({ provider, rateLimit: TOKEN_RATE_LIMIT }));

  const browserLimit = rateLimit({ ...BROWSER_RATE_LIMIT, standardHeaders: true, legacyHeaders: false });
  app.post(
    "/oauth/consent",
    browserLimit,
    express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 10 }),
    (req, res, next) => { provider.handleConsent(req, res).catch(next); }
  );
  app.get("/oauth/callback", browserLimit, (req, res, next) => {
    provider.handleClioCallback(req, res).catch(next);
  });
}
