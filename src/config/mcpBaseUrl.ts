/**
 * Public base URL of the HTTP server. Used as the prefix for the Clio OAuth
 * redirect (`{base}/oauth/callback`) and for the MCP endpoint printed at
 * startup (`{base}/mcp`).
 *
 * Trailing slashes are stripped so a Railway/custom-domain value of
 * `https://example.up.railway.app/` does not produce `//oauth/callback`,
 * which Clio rejects as an unregistered redirect URI.
 *
 * When MCP_BASE_URL is unset, Railway's RAILWAY_PUBLIC_DOMAIN is accepted
 * so the first deploy does not have to wait for a human to paste the
 * generated hostname back into the env panel.
 */
export function resolveMcpBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = (env.MCP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  const railway = (env.RAILWAY_PUBLIC_DOMAIN ?? "").trim().replace(/\/+$/, "");
  if (railway) {
    if (/^https?:\/\//i.test(railway)) return railway;
    return `https://${railway}`;
  }

  return undefined;
}
