/**
 * Configuration for AUTH_MODE=oauth, where this server is the OAuth
 * authorization server Claude signs in to and each attorney is sent through
 * Clio's own login. Everything is validated at startup so a misconfigured
 * server refuses to listen instead of half-working.
 */
import { resolveMcpBaseUrl } from "../../config/mcpBaseUrl.js";

export type AuthMode = "api_key" | "oauth";

export interface OAuthConfig {
  /** Public origin, e.g. https://clio-mcp.up.railway.app (no trailing slash). */
  baseUrl: string;
  /** The MCP endpoint as users enter it in Claude: `${baseUrl}/mcp`. Tokens are bound to it. */
  resourceUrl: URL;
  /** Lowercased email domains allowed to sign in. Exact match only; subdomains are not implied. */
  allowedEmailDomains: string[];
  /** When set, the Clio account id every user must belong to. */
  allowedAccountId?: string;
  /** 32-byte AES-256-GCM key for Clio tokens at rest. */
  encryptionKey: Buffer;
  store: { kind: "postgres"; databaseUrl: string } | { kind: "memory" };
  /** Send PKCE on the Clio leg. Needs "Use PKCE" enabled on the Clio developer app. */
  clioUsePkce: boolean;
  /** Reverse-proxy hops to trust for client IPs (rate limiting). Railway is one hop. */
  trustProxy: number;
}

export function resolveAuthMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const raw = (env.AUTH_MODE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "api_key" || raw === "apikey") return "api_key";
  if (raw === "oauth") return "oauth";
  throw new Error(`Invalid AUTH_MODE "${env.AUTH_MODE}". Use "oauth" or leave it unset for API-key mode.`);
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function parseEmailDomains(raw: string | undefined): string[] {
  const domains = (raw ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => d !== "");
  for (const d of domains) {
    if (!DOMAIN_PATTERN.test(d)) throw new Error(`ALLOWED_EMAIL_DOMAINS contains an invalid domain: "${d}".`);
  }
  return [...new Set(domains)];
}

/** Exact, case-insensitive domain match on a single-@ address. */
export function isEmailAllowed(email: string | undefined, allowedDomains: readonly string[]): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  const parts = normalized.split("@");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return false;
  return allowedDomains.includes(parts[1]);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function resolveOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const problems: string[] = [];

  const baseUrl = resolveMcpBaseUrl(env);
  let resourceUrl: URL | undefined;
  if (!baseUrl) {
    problems.push("MCP_BASE_URL is required (e.g. https://clio-mcp.up.railway.app).");
  } else {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) {
        problems.push("MCP_BASE_URL must use https:// outside local development.");
      } else if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
        problems.push("MCP_BASE_URL must be an origin only, with no path, query or fragment.");
      } else {
        resourceUrl = new URL(`${baseUrl}/mcp`);
      }
    } catch {
      problems.push(`MCP_BASE_URL is not a valid URL: "${baseUrl}".`);
    }
  }

  let allowedEmailDomains: string[] = [];
  try {
    allowedEmailDomains = parseEmailDomains(env.ALLOWED_EMAIL_DOMAINS);
    if (allowedEmailDomains.length === 0) {
      problems.push("ALLOWED_EMAIL_DOMAINS is required (comma-separated, e.g. yourfirm.com).");
    }
  } catch (err: any) {
    problems.push(err.message);
  }

  const keyHex = (env.ENCRYPTION_KEY ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    problems.push("ENCRYPTION_KEY must be 64 hex characters. Generate one with: openssl rand -hex 32");
  }

  const storeKind = (env.OAUTH_STORE ?? "postgres").trim().toLowerCase();
  const databaseUrl = (env.DATABASE_URL ?? "").trim();
  let store: OAuthConfig["store"] | undefined;
  if (storeKind === "memory") {
    store = { kind: "memory" };
  } else if (storeKind === "postgres") {
    if (!databaseUrl) problems.push("DATABASE_URL is required to store sign-ins (or OAUTH_STORE=memory for local development).");
    else store = { kind: "postgres", databaseUrl };
  } else {
    problems.push(`OAUTH_STORE must be "postgres" or "memory", got "${env.OAUTH_STORE}".`);
  }

  if (!(env.CLIO_CLIENT_ID ?? "").trim() || !(env.CLIO_CLIENT_SECRET ?? "").trim()) {
    problems.push("CLIO_CLIENT_ID and CLIO_CLIENT_SECRET are required.");
  }
  if ((env.TOKEN_BROKER_URL ?? "").trim()) {
    problems.push("TOKEN_BROKER_URL (broker mode) cannot be combined with AUTH_MODE=oauth.");
  }

  const trustRaw = (env.TRUST_PROXY_HOPS ?? "1").trim();
  const trustProxy = Number(trustRaw);
  if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 5) {
    problems.push(`TRUST_PROXY_HOPS must be an integer from 0 to 5, got "${trustRaw}".`);
  }

  const accountId = (env.CLIO_ALLOWED_ACCOUNT_ID ?? "").trim();

  if (problems.length > 0 || !resourceUrl || !store) {
    throw new Error(`AUTH_MODE=oauth is misconfigured:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    baseUrl: baseUrl!,
    resourceUrl,
    allowedEmailDomains,
    ...(accountId && { allowedAccountId: accountId }),
    encryptionKey: Buffer.from(keyHex, "hex"),
    store,
    clioUsePkce: ["true", "1", "yes"].includes((env.CLIO_USE_PKCE ?? "").trim().toLowerCase()),
    trustProxy,
  };
}
