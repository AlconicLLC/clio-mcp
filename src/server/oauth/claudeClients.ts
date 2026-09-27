/**
 * The only OAuth clients this server accepts: Claude's hosted apps (web,
 * desktop, mobile, Cowork), identified by a Client ID Metadata Document
 * (CIMD). With CIMD the client_id is an HTTPS URL that serves the client's
 * registration; there is no /register endpoint, so nothing else can become a
 * client.
 *
 * Only allowlisted URLs are ever fetched, which rules out using client_id to
 * make this server request arbitrary URLs.
 */
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/** Anthropic has served the same document at both paths. */
export const CLAUDE_CLIENT_ID_URLS: readonly string[] = [
  "https://claude.ai/oauth/mcp-oauth-client-metadata",
  "https://claude.ai/api/oauth/mcp-oauth-client-metadata",
];

/** Redirect URIs must be on this host; a document pointing elsewhere is rejected. */
const CLAUDE_HOST = "claude.ai";

/**
 * Claude's documented callback for its hosted apps. Used only when the live
 * document cannot be fetched (claude.ai sits behind a bot challenge that can
 * block server-side fetches); authorization codes can still only go to claude.ai.
 */
const CLAUDE_HOSTED_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

function pinnedClient(clientId: string): OAuthClientInformationFull {
  return validateClaudeClientDocument(clientId, {
    client_id: clientId,
    client_name: "Claude",
    redirect_uris: [CLAUDE_HOSTED_CALLBACK],
    token_endpoint_auth_method: "none",
  });
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface ClaudeClientsStoreOptions {
  allowedClientIds?: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new Error("Client metadata document is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** Returns the client, or throws describing why the document is unacceptable. */
export function validateClaudeClientDocument(clientId: string, doc: any): OAuthClientInformationFull {
  if (!doc || typeof doc !== "object") throw new Error("Client metadata is not a JSON object.");
  if (doc.client_id !== clientId) throw new Error("Client metadata client_id does not match its URL.");

  const redirectUris: unknown = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new Error("Client metadata has no redirect_uris.");
  }
  for (const uri of redirectUris) {
    let parsed: URL;
    try { parsed = new URL(String(uri)); } catch { throw new Error("Client metadata has an invalid redirect URI."); }
    if (parsed.protocol !== "https:" || parsed.hostname !== CLAUDE_HOST || parsed.username || parsed.password) {
      throw new Error(`Client metadata redirect URI is not on https://${CLAUDE_HOST}.`);
    }
  }

  const authMethod = doc.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none") throw new Error("Client metadata must declare a public client (token_endpoint_auth_method none).");

  return {
    client_id: clientId,
    redirect_uris: redirectUris.map(String),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...(typeof doc.client_name === "string" && { client_name: doc.client_name.slice(0, 100) }),
  };
}

export function createClaudeClientsStore(opts: ClaudeClientsStoreOptions = {}): OAuthRegisteredClientsStore {
  const allowed = new Set(opts.allowedClientIds ?? CLAUDE_CLIENT_ID_URLS);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { client: OAuthClientInformationFull; fetchedAt: number }>();

  async function load(clientId: string): Promise<OAuthClientInformationFull> {
    const res = await fetchImpl(clientId, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Client metadata fetch failed: HTTP ${res.status}`);
    }
    return validateClaudeClientDocument(clientId, JSON.parse(await readLimited(res)));
  }

  return {
    async getClient(clientId: string) {
      if (!allowed.has(clientId)) return undefined;

      const cached = cache.get(clientId);
      if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return cached.client;

      try {
        const client = await load(clientId);
        cache.set(clientId, { client, fetchedAt: now() });
        return client;
      } catch (err: any) {
        console.error(`[oauth] Could not load Claude client metadata (${clientId}): ${err.message}`);
        if (cached) return cached.client;
        return opts.allowedClientIds ? undefined : pinnedClient(clientId);
      }
    },
  };
}
