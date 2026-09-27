import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../../http.js";
import { resolveOAuthConfig } from "../config.js";
import type { OAuthConfig } from "../config.js";
import { MemoryOAuthStore } from "../store.js";
import { ClioTokenVault, ClioSignInRequiredError } from "../clio.js";
import type { ClioAuthAdapter } from "../clio.js";
import { ClioProxyOAuthProvider, ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from "../provider.js";
import { createClaudeClientsStore, CLAUDE_CLIENT_ID_URLS } from "../claudeClients.js";
import { decryptJson, hashToken } from "../crypto.js";
import { ClioOAuthError } from "../../../auth/clioOAuth.js";
import type { ClioTokens } from "../../../auth/clioOAuth.js";
import { configureAudit, resetAudit } from "../../../utils/auditLog.js";
import type { AuditEntry } from "../../../utils/auditLog.js";

const CLIENT_ID = CLAUDE_CLIENT_ID_URLS[0];
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const KEY_HEX = "11".repeat(32);
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

const CLAUDE_DOC = {
  client_id: CLIENT_ID,
  client_name: "Claude",
  client_uri: "https://claude.ai",
  redirect_uris: [REDIRECT],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const PEOPLE: Record<string, { id: string; email: string; accountId?: string }> = {
  alice: { id: "101", email: "alice@firm.com", accountId: "9" },
  bob: { id: "202", email: "Bob@Firm.com", accountId: "9" },
  mallory: { id: "303", email: "mallory@other.com", accountId: "9" },
  outsider: { id: "404", email: "sam@firm.com", accountId: "77" },
};

class FakeClio implements ClioAuthAdapter {
  lastAuthorize?: URL;
  lastExchange?: { code: string; redirectUri: string; codeVerifier?: string };
  refreshCalls = 0;
  refreshError?: Error;
  private tokenOwner = new Map<string, string>();
  private counter = 0;

  private mint(person: string, now: number): ClioTokens {
    const access = `clio-access-${person}-${++this.counter}`;
    this.tokenOwner.set(access, person);
    return { access_token: access, refresh_token: `clio-refresh-${person}-${this.counter}`, expires_at: now + 3600_000 };
  }

  constructor(private readonly now: () => number) {}

  authorizeUrl(p: { redirectUri: string; state: string; codeChallenge?: string }): string {
    const url = new URL("https://app.clio.test/oauth/authorize");
    url.searchParams.set("redirect_uri", p.redirectUri);
    url.searchParams.set("state", p.state);
    if (p.codeChallenge) url.searchParams.set("code_challenge", p.codeChallenge);
    this.lastAuthorize = url;
    return url.href;
  }
  async exchange(p: { code: string; redirectUri: string; codeVerifier?: string }): Promise<ClioTokens> {
    this.lastExchange = p;
    const person = p.code.replace(/^clio-code-/, "");
    if (!PEOPLE[person]) throw new ClioOAuthError(400, "bad code", "invalid_grant");
    return this.mint(person, this.now());
  }
  async refresh(refreshToken: string): Promise<ClioTokens> {
    this.refreshCalls++;
    if (this.refreshError) throw this.refreshError;
    return this.mint(refreshToken.split("-")[2], this.now());
  }
  async whoAmI(accessToken: string, fields: string) {
    const p = PEOPLE[this.tokenOwner.get(accessToken)!];
    return { id: p.id, email: p.email, ...(fields.includes("account") && { accountId: p.accountId }) };
  }
}

interface Harness {
  base: string;
  config: OAuthConfig;
  store: MemoryOAuthStore;
  clio: FakeClio;
  vault: ClioTokenVault;
  provider: ClioProxyOAuthProvider;
  clock: { t: number };
  audit: AuditEntry[];
  close(): Promise<void>;
}

async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  let handler: http.RequestListener = () => {};
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const config = resolveOAuthConfig({
    MCP_BASE_URL: base,
    AUTH_MODE: "oauth",
    ALLOWED_EMAIL_DOMAINS: "firm.com",
    ENCRYPTION_KEY: KEY_HEX,
    OAUTH_STORE: "memory",
    CLIO_CLIENT_ID: "cid",
    CLIO_CLIENT_SECRET: "secret",
    ...env,
  });
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const store = new MemoryOAuthStore();
  const clio = new FakeClio(now);
  const vault = new ClioTokenVault(store, config.encryptionKey, clio, now);
  const clients = createClaudeClientsStore({
    fetchImpl: async () => new Response(JSON.stringify(CLAUDE_DOC), { headers: { "Content-Type": "application/json" } }),
  });
  const provider = new ClioProxyOAuthProvider({ config, store, clients, clio, vault, now });
  const app = createApp({ apiKey: null }, { oauth: { config, provider, vault, store } });
  handler = app as unknown as http.RequestListener;

  const audit: AuditEntry[] = [];
  configureAudit({ sink: { append: async (e) => { audit.push(e); }, read: async () => ({ entries: [], total_matched: 0 }) } });

  return {
    base, config, store, clio, vault, provider, clock, audit,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(h: Harness, over: Record<string, string | undefined> = {}, challenge = pkce().challenge): string {
  const url = new URL(`${h.base}/authorize`);
  const params: Record<string, string | undefined> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state",
    resource: `${h.base}/mcp`,
    ...over,
  };
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.href;
}

function cookieFrom(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function openConsent(h: Harness, challenge: string) {
  const res = await fetch(authorizeUrl(h, {}, challenge), { redirect: "manual" });
  expect(res.status).toBe(200);
  const html = await res.text();
  return {
    res,
    html,
    cookie: cookieFrom(res),
    requestId: html.match(/name="request_id" value="([^"]+)"/)![1],
    consentToken: html.match(/name="consent_token" value="([^"]+)"/)![1],
  };
}

function postConsent(h: Harness, p: { requestId: string; consentToken: string; cookie?: string; decision?: string; origin?: string }) {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (p.cookie) headers.Cookie = p.cookie;
  if (p.origin) headers.Origin = p.origin;
  return fetch(`${h.base}/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers,
    body: new URLSearchParams({ request_id: p.requestId, consent_token: p.consentToken, decision: p.decision ?? "approve" }),
  });
}

/** Runs the browser half: /authorize, consent, Clio, callback. Returns Claude's redirect. */
async function signIn(h: Harness, person: string, challenge: string): Promise<URL> {
  const consent = await openConsent(h, challenge);
  const toClio = await postConsent(h, { ...consent, cookie: consent.cookie });
  expect(toClio.status).toBe(302);
  const clioState = new URL(toClio.headers.get("location")!).searchParams.get("state")!;
  const back = await fetch(`${h.base}/oauth/callback?code=clio-code-${person}&state=${encodeURIComponent(clioState)}`, {
    redirect: "manual",
    headers: { Cookie: consent.cookie },
  });
  expect(back.status).toBe(302);
  return new URL(back.headers.get("location")!);
}

function token(h: Harness, body: Record<string, string>) {
  return fetch(`${h.base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
}

async function fullSignIn(h: Harness, person: string) {
  const { verifier, challenge } = pkce();
  const redirect = await signIn(h, person, challenge);
  const code = redirect.searchParams.get("code")!;
  const res = await token(h, {
    grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${h.base}/mcp`,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
}

async function mcp(h: Harness, accessToken: string, body: unknown, sessionId?: string) {
  const headers: Record<string, string> = { ...MCP_HEADERS, Authorization: `Bearer ${accessToken}` };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = "2025-06-18";
  }
  const res = await fetch(`${h.base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice(6)) : text ? JSON.parse(text) : undefined;
  return { res, json, sessionId: res.headers.get("mcp-session-id") ?? undefined };
}

async function openSession(h: Harness, accessToken: string): Promise<string> {
  const init = await mcp(h, accessToken, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  expect(init.res.status).toBe(200);
  await mcp(h, accessToken, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  return init.sessionId!;
}

describe("OAuth mode", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); resetAudit(); });

  describe("discovery", () => {
    it("answers /mcp without a token with 401 and a pointer to the resource metadata", async () => {
      const res = await fetch(`${h.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: "{}" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        `resource_metadata="${h.base}/.well-known/oauth-protected-resource/mcp"`
      );
    });

    it("rejects a made-up bearer token", async () => {
      const res = await fetch(`${h.base}/mcp`, {
        method: "POST", headers: { ...MCP_HEADERS, Authorization: "Bearer not-a-token" }, body: "{}",
      });
      expect(res.status).toBe(401);
    });

    it("publishes protected-resource metadata whose resource is exactly /mcp", async () => {
      for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
        const doc = await (await fetch(`${h.base}${path}`)).json();
        expect(doc.resource).toBe(`${h.base}/mcp`);
        expect(doc.authorization_servers).toEqual([`${h.base}/`]);
      }
    });

    it("advertises CIMD, public clients and S256 only, and no registration endpoint", async () => {
      const doc = await (await fetch(`${h.base}/.well-known/oauth-authorization-server`)).json();
      expect(doc.client_id_metadata_document_supported).toBe(true);
      expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
      expect(doc.registration_endpoint).toBeUndefined();
      expect(doc.authorization_endpoint).toBe(`${h.base}/authorize`);
      expect(doc.token_endpoint).toBe(`${h.base}/token`);
    });

    it("has no API key gate and no /register", async () => {
      expect((await fetch(`${h.base}/health`)).status).toBe(200);
      expect((await fetch(`${h.base}/register`, { method: "POST" })).status).toBe(404);
    });
  });

  describe("/authorize", () => {
    it("rejects a client_id that is not Claude", async () => {
      const res = await fetch(authorizeUrl(h, { client_id: "https://evil.example/client.json" }), { redirect: "manual" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_client");
    });

    it("rejects a redirect_uri Claude did not register, without redirecting there", async () => {
      const res = await fetch(authorizeUrl(h, { redirect_uri: "https://evil.example/cb" }), { redirect: "manual" });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    });

    it("requires S256 PKCE", async () => {
      const res = await fetch(authorizeUrl(h, { code_challenge_method: "plain" }), { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
      const missing = await fetch(authorizeUrl(h, { code_challenge: undefined }), { redirect: "manual" });
      expect(new URL(missing.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    });

    it("refuses tokens for any resource other than this server's /mcp", async () => {
      const res = await fetch(authorizeUrl(h, { resource: "https://other.example/mcp" }), { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    });

    it("serves a consent page that cannot be framed, cached or run scripts, with a SameSite browser cookie", async () => {
      const { res } = await openConsent(h, pkce().challenge);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      const setCookie = res.headers.get("set-cookie")!;
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
    });
  });

  describe("consent", () => {
    it("Cancel sends access_denied back to Claude", async () => {
      const c = await openConsent(h, pkce().challenge);
      const res = await postConsent(h, { ...c, decision: "deny" });
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get("error")).toBe("access_denied");
      expect(loc.searchParams.get("state")).toBe("claude-state");
    });

    it("rejects a submission from another browser, another site, a wrong token, or a replay", async () => {
      const c = await openConsent(h, pkce().challenge);
      expect((await postConsent(h, { ...c, cookie: undefined })).status).toBe(400);
      expect((await postConsent(h, { ...c, origin: "https://evil.example" })).status).toBe(400);
      expect((await postConsent(h, { ...c, consentToken: "x".repeat(43) })).status).toBe(400);
      expect((await postConsent(h, c)).status).toBe(302);
      expect((await postConsent(h, c)).status).toBe(400);
    });

    it("rejects an expired sign-in", async () => {
      const c = await openConsent(h, pkce().challenge);
      h.clock.t += 11 * 60 * 1000;
      expect((await postConsent(h, c)).status).toBe(400);
    });

    it("sends the attorney to Clio with our callback and a fresh state", async () => {
      const c = await openConsent(h, pkce().challenge);
      const res = await postConsent(h, c);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("redirect_uri")).toBe(`${h.base}/oauth/callback`);
      expect(loc.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(loc.searchParams.get("code_challenge")).toBeNull();
    });
  });

  describe("Clio callback", () => {
    it("returns a code and Claude's state to Claude, and stores Clio tokens encrypted", async () => {
      const loc = await signIn(h, "alice", pkce().challenge);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get("state")).toBe("claude-state");
      expect(loc.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const user = await h.store.getUser("101");
      expect(user?.email).toBe("alice@firm.com");
      expect(user?.clioTokens).not.toContain("clio-access-alice");
      expect(user?.clioTokens).not.toContain("clio-refresh-alice");
      const plain = decryptJson<ClioTokens>(h.config.encryptionKey, user!.clioTokens, "clio-tokens:101");
      expect(plain.access_token).toMatch(/^clio-access-alice/);
      expect(() => decryptJson(h.config.encryptionKey, user!.clioTokens, "clio-tokens:202")).toThrow();

      expect(h.audit.some((e) =>
        e.tool === "oauth_callback" && e.outcome === "success" && e.clio_user_id === "101" && e.user_id === "101"
      )).toBe(true);
      expect(JSON.stringify(h.audit)).not.toContain("alice@firm.com");
    });

    it("matches allowed domains case-insensitively", async () => {
      const loc = await signIn(h, "bob", pkce().challenge);
      expect(loc.searchParams.get("code")).toBeTruthy();
    });

    it("refuses an email outside the firm's domains and stores nothing", async () => {
      const loc = await signIn(h, "mallory", pkce().challenge);
      expect(loc.searchParams.get("error")).toBe("access_denied");
      expect(loc.searchParams.get("code")).toBeNull();
      expect(await h.store.getUser("303")).toBeNull();
    });

    it("rejects an unknown or replayed Clio state, and a callback in another browser", async () => {
      const bogus = await fetch(`${h.base}/oauth/callback?code=clio-code-alice&state=nope`, { redirect: "manual" });
      expect(bogus.status).toBe(400);

      const c = await openConsent(h, pkce().challenge);
      const toClio = await postConsent(h, c);
      const state = new URL(toClio.headers.get("location")!).searchParams.get("state")!;
      const other = await fetch(`${h.base}/oauth/callback?code=clio-code-alice&state=${state}`, { redirect: "manual" });
      expect(other.status).toBe(400);
      const replay = await fetch(`${h.base}/oauth/callback?code=clio-code-alice&state=${state}`, {
        redirect: "manual", headers: { Cookie: c.cookie },
      });
      expect(replay.status).toBe(400);
    });

    it("never forwards Clio's error parameters", async () => {
      const c = await openConsent(h, pkce().challenge);
      const toClio = await postConsent(h, c);
      const state = new URL(toClio.headers.get("location")!).searchParams.get("state")!;
      const res = await fetch(
        `${h.base}/oauth/callback?error=%3Cscript%3Ealert(1)%3C/script%3E&state=${state}`,
        { redirect: "manual", headers: { Cookie: c.cookie } }
      );
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe("access_denied");
      expect(decodeURIComponent(loc.href)).not.toContain("<script");
    });
  });

  describe("/token", () => {
    it("issues Bearer tokens once per code, and only with the right verifier", async () => {
      const { verifier, challenge } = pkce();
      const code = (await signIn(h, "alice", challenge)).searchParams.get("code")!;

      const ok = await token(h, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT });
      const body = await ok.json();
      expect(ok.status).toBe(200);
      expect(body.token_type).toBe("Bearer");
      expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_MS / 1000);
      expect(body.refresh_token).toBeTruthy();

      const again = await token(h, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT });
      expect(again.status).toBe(400);
      expect((await again.json()).error).toBe("invalid_grant");
    });

    it("burns a code after one wrong verifier", async () => {
      const { verifier, challenge } = pkce();
      const code = (await signIn(h, "alice", challenge)).searchParams.get("code")!;
      const wrong = await token(h, { grant_type: "authorization_code", code, code_verifier: pkce().verifier });
      expect((await wrong.json()).error).toBe("invalid_grant");
      const right = await token(h, { grant_type: "authorization_code", code, code_verifier: verifier });
      expect((await right.json()).error).toBe("invalid_grant");
    });

    it("rejects an expired code, a different redirect_uri, and a foreign resource", async () => {
      const a = pkce();
      const code1 = (await signIn(h, "alice", a.challenge)).searchParams.get("code")!;
      h.clock.t += 61_000;
      expect((await (await token(h, { grant_type: "authorization_code", code: code1, code_verifier: a.verifier })).json()).error)
        .toBe("invalid_grant");

      const b = pkce();
      const code2 = (await signIn(h, "alice", b.challenge)).searchParams.get("code")!;
      const res2 = await token(h, {
        grant_type: "authorization_code", code: code2, code_verifier: b.verifier, redirect_uri: "https://claude.ai/other",
      });
      expect((await res2.json()).error).toBe("invalid_grant");

      const c = pkce();
      const code3 = (await signIn(h, "alice", c.challenge)).searchParams.get("code")!;
      const res3 = await token(h, {
        grant_type: "authorization_code", code: code3, code_verifier: c.verifier, resource: "https://other.example/mcp",
      });
      expect((await res3.json()).error).toBe("invalid_target");
    });

    it("rejects a code presented by a different client_id", async () => {
      const { verifier, challenge } = pkce();
      const code = (await signIn(h, "alice", challenge)).searchParams.get("code")!;
      const res = await token(h, {
        grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLAUDE_CLIENT_ID_URLS[1],
      });
      expect(res.status).toBe(400);
    });

    it("stores only hashes of the tokens it issues", async () => {
      const t = await fullSignIn(h, "alice");
      expect(await h.store.findToken(t.access_token)).toBeNull();
      expect((await h.store.findToken(hashToken(t.access_token)))?.kind).toBe("access");
    });
  });

  describe("refresh", () => {
    it("rotates refresh tokens and keeps the user signed in", async () => {
      const t1 = await fullSignIn(h, "alice");
      const res = await token(h, { grant_type: "refresh_token", refresh_token: t1.refresh_token });
      expect(res.status).toBe(200);
      const t2 = await res.json();
      expect(t2.refresh_token).not.toBe(t1.refresh_token);
      expect(t2.access_token).not.toBe(t1.access_token);
      expect((await mcp(h, t2.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).res.status).not.toBe(401);
    });

    it("treats reuse of a rotated-out refresh token as theft and ends the whole grant", async () => {
      const t1 = await fullSignIn(h, "alice");
      const t2 = await (await token(h, { grant_type: "refresh_token", refresh_token: t1.refresh_token })).json();

      const reuse = await token(h, { grant_type: "refresh_token", refresh_token: t1.refresh_token });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe("invalid_grant");

      const after = await token(h, { grant_type: "refresh_token", refresh_token: t2.refresh_token });
      expect((await after.json()).error).toBe("invalid_grant");
      const call = await fetch(`${h.base}/mcp`, {
        method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${t2.access_token}` }, body: "{}",
      });
      expect(call.status).toBe(401);
    });

    it("answers invalid_grant for unknown and expired refresh tokens", async () => {
      expect((await (await token(h, { grant_type: "refresh_token", refresh_token: "nope" })).json()).error).toBe("invalid_grant");
      const t = await fullSignIn(h, "alice");
      h.clock.t += REFRESH_TOKEN_TTL_MS + 1;
      expect((await (await token(h, { grant_type: "refresh_token", refresh_token: t.refresh_token })).json()).error)
        .toBe("invalid_grant");
    });

    it("stops refreshing for someone whose domain is no longer allowed", async () => {
      const t = await fullSignIn(h, "alice");
      (h.config as { allowedEmailDomains: string[] }).allowedEmailDomains = ["newfirm.com"];
      const res = await token(h, { grant_type: "refresh_token", refresh_token: t.refresh_token });
      expect((await res.json()).error).toBe("invalid_grant");
      const call = await fetch(`${h.base}/mcp`, {
        method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${t.access_token}` }, body: "{}",
      });
      expect(call.status).toBe(401);
    });

    it("expires access tokens after an hour", async () => {
      const t = await fullSignIn(h, "alice");
      h.clock.t += ACCESS_TOKEN_TTL_MS + 1;
      const res = await fetch(`${h.base}/mcp`, {
        method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${t.access_token}` }, body: "{}",
      });
      expect(res.status).toBe(401);
    });

    it("revocation ends the grant", async () => {
      const t = await fullSignIn(h, "alice");
      const res = await fetch(`${h.base}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT_ID, token: t.refresh_token }),
      });
      expect(res.status).toBe(200);
      const call = await fetch(`${h.base}/mcp`, {
        method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${t.access_token}` }, body: "{}",
      });
      expect(call.status).toBe(401);
    });
  });

  describe("MCP sessions", () => {
    it("registers auth_status but not the local-login tools", async () => {
      const t = await fullSignIn(h, "alice");
      const sid = await openSession(h, t.access_token);
      const list = await mcp(h, t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
      const names = list.json.result.tools.map((x: { name: string }) => x.name);
      expect(names).toContain("auth_status");
      expect(names).not.toContain("authenticate");
      expect(names).not.toContain("logout");
    });

    it("runs tools as the signed-in attorney", async () => {
      const t = await fullSignIn(h, "alice");
      const sid = await openSession(h, t.access_token);
      const call = await mcp(h, t.access_token, {
        jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "auth_status", arguments: {} },
      }, sid);
      const status = JSON.parse(call.json.result.content[0].text);
      expect(status.authenticated).toBe(true);
      expect(status.clio_user_id).toBe("101");
    });

    it("hides one attorney's session from another", async () => {
      const alice = await fullSignIn(h, "alice");
      const bob = await fullSignIn(h, "bob");
      const sid = await openSession(h, alice.access_token);
      const hijack = await mcp(h, bob.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
      expect(hijack.res.status).toBe(404);
    });
  });
});

describe("OAuth mode with a Clio account restriction and Clio PKCE", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness({ CLIO_ALLOWED_ACCOUNT_ID: "9", CLIO_USE_PKCE: "true" }); });
  afterEach(async () => { await h.close(); resetAudit(); });

  it("refuses a firm-domain email on a different Clio account", async () => {
    const loc = await signIn(h, "outsider", pkce().challenge);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(await h.store.getUser("404")).toBeNull();
  });

  it("uses PKCE with Clio and sends the verifier on exchange", async () => {
    const loc = await signIn(h, "alice", pkce().challenge);
    expect(loc.searchParams.get("code")).toBeTruthy();
    const challenge = h.clio.lastAuthorize!.searchParams.get("code_challenge")!;
    const verifier = h.clio.lastExchange!.codeVerifier!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
  });
});

describe("ClioTokenVault", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); resetAudit(); });

  it("refreshes near expiry once for concurrent callers and saves the rotated tokens", async () => {
    await fullSignIn(h, "alice");
    h.clock.t += 58 * 60 * 1000;
    const [a, b] = await Promise.all([h.vault.getFreshTokens("101"), h.vault.getFreshTokens("101")]);
    expect(h.clio.refreshCalls).toBe(1);
    expect(a.access_token).toBe(b.access_token);
    expect((await h.vault.getFreshTokens("101")).access_token).toBe(a.access_token);
  });

  it("signs the attorney out everywhere when Clio refuses the refresh token", async () => {
    const t = await fullSignIn(h, "alice");
    h.clock.t += 58 * 60 * 1000;
    h.clio.refreshError = new ClioOAuthError(400, "{}", "invalid_grant");
    await expect(h.vault.getFreshTokens("101")).rejects.toBeInstanceOf(ClioSignInRequiredError);
    const call = await fetch(`${h.base}/mcp`, {
      method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${t.access_token}` }, body: "{}",
    });
    expect(call.status).toBe(401);
  });
});
