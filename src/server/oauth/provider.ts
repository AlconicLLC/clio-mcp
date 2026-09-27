/**
 * OAuth authorization server for Claude, backed by Clio sign-in.
 *
 * Claude (the OAuth client) sends the attorney here; we show a consent page,
 * send them on to Clio's own login, check who they are, and give Claude an
 * authorization code for *our* tokens. Clio's tokens never leave this server:
 * they are stored encrypted per attorney and used on their behalf.
 *
 * Short-lived state (pending sign-ins, authorization codes) is in memory, so a
 * restart only interrupts sign-ins that are in progress. Tokens and grants are
 * in the store so they survive restarts.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { appendAuditLog } from "../../utils/auditLog.js";
import { sessionStorage } from "../../utils/sessionContext.js";
import type { SessionContext } from "../../utils/sessionContext.js";
import { isEmailAllowed } from "./config.js";
import type { OAuthConfig } from "./config.js";
import { hashToken, randomToken, safeEqual } from "./crypto.js";
import type { OAuthStore, TokenRow } from "./store.js";
import type { ClioAuthAdapter, ClioTokenVault } from "./clio.js";
import { sendConsentPage, sendMessagePage } from "./pages.js";

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
/** Bounds memory if someone floods /authorize; each entry is small and expires in minutes. */
const MAX_PENDING = 5_000;

interface PendingAuthorization {
  clientId: string;
  clientHost: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  consentTokenHash: string;
  /** Hash of the browser-binding cookie set with the consent page. */
  browserHash: string;
  /** Set once the attorney approves; the pending entry is then keyed by this too. */
  clioStateHash?: string;
  clioVerifier?: string;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clioUserId: string;
  expiresAt: number;
  challengeUsed: boolean;
}

export interface ProviderDeps {
  config: OAuthConfig;
  store: OAuthStore;
  clients: OAuthRegisteredClientsStore;
  clio: ClioAuthAdapter;
  vault: ClioTokenVault;
  now?: () => number;
}

/** Logged under the attorney's identity so their own get_audit_log shows it. Never includes the email. */
function auditSignIn(clioUserId: string, outcome: "success" | "error", error_message?: string): Promise<void> {
  const ctx: SessionContext = {
    sessionId: "oauth-signin",
    userId: clioUserId,
    clioUserId,
    getAccessToken: async () => { throw new Error("unavailable during sign-in"); },
    getTokens: async () => null,
    storeTokens: async () => {},
    clearTokens: async () => {},
  };
  return sessionStorage.run(ctx, () =>
    appendAuditLog({ tool: "oauth_callback", args: {}, outcome, clio_user_id: clioUserId, ...(error_message && { error_message }) })
  );
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function redirectWith(res: Response, redirectUri: string, params: Record<string, string | undefined>): void {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, url.href);
}

function firstString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= 2048 ? v : undefined;
}

/**
 * Ties a sign-in to the browser that started it, so a page on another site
 * cannot submit someone's consent form and a Clio callback cannot be replayed
 * in a different browser. SameSite=Lax keeps it off cross-site POSTs while
 * still sending it on Clio's top-level redirect back to us.
 */
export const BROWSER_COOKIE = "clio_mcp_signin";

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      const value = part.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

export class ClioProxyOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly pendingByClioState = new Map<string, string>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly now: () => number;

  constructor(private readonly deps: ProviderDeps) {
    this.now = deps.now ?? Date.now;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.deps.clients;
  }

  private get callbackUri(): string {
    return `${this.deps.config.baseUrl}/oauth/callback`;
  }

  /** Access tokens are only for this server's /mcp. */
  private checkResource(resource: URL | undefined): void {
    if (resource && resource.href !== this.deps.config.resourceUrl.href) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.deps.config.resourceUrl.href}`);
    }
  }

  /** Drop expired sign-ins and codes. Called on every write and periodically. */
  sweep(): void {
    const now = this.now();
    for (const [id, p] of this.pending) {
      if (p.expiresAt <= now) this.deletePending(id);
    }
    for (const [h, c] of this.codes) {
      if (c.expiresAt <= now) this.codes.delete(h);
    }
  }

  private browserMatches(req: Request, pending: PendingAuthorization): boolean {
    const cookie = readCookie(req, BROWSER_COOKIE);
    return cookie !== undefined && safeEqual(hashToken(cookie), pending.browserHash);
  }

  private deletePending(id: string): void {
    const p = this.pending.get(id);
    if (p?.clioStateHash) this.pendingByClioState.delete(p.clioStateHash);
    this.pending.delete(id);
  }

  // ---- Step 1: Claude sends the attorney to /authorize (validated by the SDK) ----

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    this.sweep();
    if (this.pending.size >= MAX_PENDING) {
      sendMessagePage(res, 503, "Try again shortly", "Too many sign-ins are in progress. Please try again in a few minutes.");
      return;
    }

    const requestId = randomUUID();
    const consentToken = randomToken();
    const browser = readCookie(res.req, BROWSER_COOKIE) ?? randomToken();
    this.pending.set(requestId, {
      clientId: client.client_id,
      clientHost: hostOf(client.client_id),
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      consentTokenHash: hashToken(consentToken),
      browserHash: hashToken(browser),
      expiresAt: this.now() + PENDING_TTL_MS,
    });

    res.cookie(BROWSER_COOKIE, browser, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.deps.config.baseUrl.startsWith("https:"),
      path: "/oauth",
      maxAge: PENDING_TTL_MS,
    });

    sendConsentPage(res, {
      clientHost: client.client_name ? `${client.client_name} (${hostOf(client.client_id)})` : hostOf(client.client_id),
      redirectHost: hostOf(params.redirectUri),
      serverHost: hostOf(this.deps.config.baseUrl),
      requestId,
      consentToken,
    });
  }

  // ---- Step 2: the attorney approves or cancels on the consent page ----

  handleConsent = async (req: Request, res: Response): Promise<void> => {
    const requestId = firstString(req.body?.request_id);
    const consentToken = firstString(req.body?.consent_token);
    const decision = req.body?.decision;
    const pending = requestId ? this.pending.get(requestId) : undefined;
    const origin = req.headers.origin;
    const foreignOrigin = origin !== undefined && origin !== new URL(this.deps.config.baseUrl).origin;

    if (
      !requestId || !consentToken || !pending || foreignOrigin ||
      pending.expiresAt <= this.now() ||
      pending.clioStateHash !== undefined ||
      !safeEqual(hashToken(consentToken), pending.consentTokenHash) ||
      !this.browserMatches(req, pending)
    ) {
      sendMessagePage(res, 400, "Sign-in expired", "This sign-in link has expired or was already used. Return to Claude and click Connect again.");
      return;
    }

    if (decision !== "approve") {
      this.deletePending(requestId);
      redirectWith(res, pending.redirectUri, {
        error: "access_denied",
        error_description: "The user cancelled the sign-in.",
        state: pending.state,
      });
      return;
    }

    const clioState = randomToken();
    pending.clioStateHash = hashToken(clioState);
    pending.expiresAt = this.now() + PENDING_TTL_MS;
    this.pendingByClioState.set(pending.clioStateHash, requestId);

    let codeChallenge: string | undefined;
    if (this.deps.config.clioUsePkce) {
      pending.clioVerifier = randomToken();
      codeChallenge = createHash("sha256").update(pending.clioVerifier).digest("base64url");
    }

    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, this.deps.clio.authorizeUrl({ redirectUri: this.callbackUri, state: clioState, codeChallenge }));
  };

  // ---- Step 3: Clio sends the attorney back to /oauth/callback ----

  handleClioCallback = async (req: Request, res: Response): Promise<void> => {
    const clioState = firstString(req.query.state);
    const stateHash = clioState ? hashToken(clioState) : undefined;
    const requestId = stateHash ? this.pendingByClioState.get(stateHash) : undefined;
    const pending = requestId ? this.pending.get(requestId) : undefined;

    if (!requestId || !pending || pending.expiresAt <= this.now() || !this.browserMatches(req, pending)) {
      if (requestId) this.deletePending(requestId);
      sendMessagePage(res, 400, "Sign-in expired", "This sign-in link has expired or was already used. Return to Claude and click Connect again.");
      return;
    }
    // Single use: whatever happens next, this state cannot be replayed.
    this.deletePending(requestId);

    const deny = (description: string) =>
      redirectWith(res, pending.redirectUri, { error: "access_denied", error_description: description, state: pending.state });

    if (req.query.error !== undefined) {
      deny("Clio sign-in was cancelled or refused.");
      return;
    }
    const code = firstString(req.query.code);
    if (!code) {
      deny("Clio did not return an authorization code.");
      return;
    }

    let clioUserId: string;
    try {
      const tokens = await this.deps.clio.exchange({
        code,
        redirectUri: this.callbackUri,
        codeVerifier: pending.clioVerifier,
      });
      const fields = this.deps.config.allowedAccountId ? "id,name,email,account{id}" : "id,name,email";
      const me = await this.deps.clio.whoAmI(tokens.access_token, fields);
      if (!/^\d+$/.test(me.id ?? "")) throw new Error("Clio who_am_i returned no user id.");
      clioUserId = me.id;

      const accountOk = !this.deps.config.allowedAccountId || me.accountId === this.deps.config.allowedAccountId;
      if (!isEmailAllowed(me.email, this.deps.config.allowedEmailDomains) || !accountOk) {
        await auditSignIn(clioUserId, "error", "Sign-in refused: Clio account is not permitted.");
        deny("This Clio account is not permitted to use this connector.");
        return;
      }

      await this.deps.vault.save(clioUserId, String(me.email).toLowerCase(), tokens);
    } catch (err: any) {
      console.error(`[oauth] Clio sign-in failed: ${err?.message ?? err}`);
      redirectWith(res, pending.redirectUri, {
        error: "server_error",
        error_description: "Signing in to Clio failed. Please try again.",
        state: pending.state,
      });
      return;
    }

    const authCode = randomToken();
    this.codes.set(hashToken(authCode), {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      clioUserId,
      expiresAt: this.now() + CODE_TTL_MS,
      challengeUsed: false,
    });
    await auditSignIn(clioUserId, "success");
    redirectWith(res, pending.redirectUri, { code: authCode, state: pending.state });
  };

  // ---- Step 4: Claude exchanges the code at /token ----

  private liveCode(client: OAuthClientInformationFull, code: string): AuthorizationCode {
    const entry = this.codes.get(hashToken(code));
    if (!entry || entry.expiresAt <= this.now() || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return entry;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const entry = this.liveCode(client, code);
    // One PKCE attempt per code: a wrong verifier burns it.
    if (entry.challengeUsed) {
      this.codes.delete(hashToken(code));
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    entry.challengeUsed = true;
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const entry = this.liveCode(client, code);
    this.codes.delete(hashToken(code));
    if (!entry.challengeUsed) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.checkResource(resource);

    const grantId = randomUUID();
    await this.deps.store.createGrant({ grantId, clioUserId: entry.clioUserId, clientId: client.client_id }, this.now());
    return this.issueTokens(grantId);
  }

  private async issueTokens(grantId: string): Promise<OAuthTokens> {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = this.now();
    const rows: TokenRow[] = [
      { tokenHash: hashToken(accessToken), kind: "access", grantId, expiresAt: now + ACCESS_TOKEN_TTL_MS },
      { tokenHash: hashToken(refreshToken), kind: "refresh", grantId, expiresAt: now + REFRESH_TOKEN_TTL_MS },
    ];
    await this.deps.store.insertTokens(rows);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
    };
  }

  // ---- Step 5: Claude refreshes ----

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    this.checkResource(resource);
    const hash = hashToken(refreshToken);
    const row = await this.deps.store.findToken(hash);
    const now = this.now();
    if (!row || row.kind !== "refresh" || row.clientId !== client.client_id || row.grantRevokedAt !== null) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (row.usedAt !== null) {
      // A rotated-out refresh token came back: someone else has a copy. End the whole grant.
      await this.deps.store.revokeGrant(row.grantId, now);
      console.error(`[oauth] Refresh token reuse detected; revoked grant ${row.grantId}`);
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (row.expiresAt <= now) throw new InvalidGrantError("Refresh token expired");
    // ALLOWED_EMAIL_DOMAINS may have been narrowed since this attorney signed in.
    const user = await this.deps.store.getUser(row.clioUserId);
    if (!user || !isEmailAllowed(user.email, this.deps.config.allowedEmailDomains)) {
      await this.deps.store.revokeGrant(row.grantId, now);
      throw new InvalidGrantError("This account is no longer permitted to use this connector");
    }
    if (!(await this.deps.store.consumeRefreshToken(hash, now))) {
      // Lost a race with a concurrent refresh of the same token; the winner's tokens stay valid.
      throw new InvalidGrantError("Invalid refresh token");
    }
    return this.issueTokens(row.grantId);
  }

  // ---- Every /mcp request ----

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = await this.deps.store.findToken(hashToken(token));
    if (!row || row.kind !== "access" || row.grantRevokedAt !== null || row.expiresAt <= this.now()) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: row.clientId,
      scopes: [],
      expiresAt: Math.floor(row.expiresAt / 1000),
      resource: this.deps.config.resourceUrl,
      extra: { clioUserId: row.clioUserId, grantId: row.grantId },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = await this.deps.store.findToken(hashToken(request.token));
    if (row && row.clientId === client.client_id) await this.deps.store.revokeGrant(row.grantId, this.now());
  }
}
