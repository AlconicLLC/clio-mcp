/**
 * The Clio side of OAuth mode: the calls made to Clio during sign-in, and the
 * vault that keeps each attorney's Clio tokens encrypted in the store and
 * fresh when a tool needs them.
 */
import {
  buildClioAuthorizeUrl,
  exchangeClioCode,
  refreshClioTokens,
  fetchClioWhoAmI,
  ClioOAuthError,
} from "../../auth/clioOAuth.js";
import type { ClioTokens, ClioWhoAmI } from "../../auth/clioOAuth.js";
import { encryptJson, decryptJson } from "./crypto.js";
import type { OAuthStore } from "./store.js";

export interface ClioAuthAdapter {
  authorizeUrl(p: { redirectUri: string; state: string; codeChallenge?: string }): string;
  exchange(p: { code: string; redirectUri: string; codeVerifier?: string }): Promise<ClioTokens>;
  refresh(refreshToken: string): Promise<ClioTokens>;
  whoAmI(accessToken: string, fields: string): Promise<ClioWhoAmI>;
}

/** Clio endpoints and credentials from the environment (CLIO_CLIENT_ID/SECRET, CLIO_REGION and overrides). */
export function createEnvClioAdapter(env: NodeJS.ProcessEnv = process.env): ClioAuthAdapter {
  const client = {
    clientId: (env.CLIO_CLIENT_ID ?? "").trim(),
    clientSecret: (env.CLIO_CLIENT_SECRET ?? "").trim(),
  };
  return {
    authorizeUrl: ({ redirectUri, state, codeChallenge }) => {
      const url = new URL(buildClioAuthorizeUrl({ clientId: client.clientId, redirectUri, state, codeChallenge }));
      url.searchParams.set("redirect_on_decline", "true");
      return url.toString();
    },
    exchange: ({ code, redirectUri, codeVerifier }) => exchangeClioCode({ ...client, code, redirectUri, codeVerifier }),
    refresh: (refreshToken) => refreshClioTokens({ ...client, refreshToken }),
    whoAmI: (accessToken, fields) => fetchClioWhoAmI(accessToken, { fields }),
  };
}

/** Raised when an attorney's Clio grant is gone and only a new sign-in can fix it. */
export class ClioSignInRequiredError extends Error {
  constructor() {
    super("Your Clio sign-in has expired or was revoked. Disconnect and reconnect the Clio connector in Claude to sign in again.");
    this.name = "ClioSignInRequiredError";
  }
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class ClioTokenVault {
  private inFlight = new Map<string, Promise<ClioTokens>>();

  constructor(
    private readonly store: OAuthStore,
    private readonly key: Buffer,
    private readonly clio: ClioAuthAdapter,
    private readonly now: () => number = Date.now
  ) {}

  private aad(clioUserId: string): string {
    return `clio-tokens:${clioUserId}`;
  }

  async save(clioUserId: string, email: string, tokens: ClioTokens): Promise<void> {
    const clioTokens = encryptJson(this.key, { ...tokens, clio_user_id: clioUserId }, this.aad(clioUserId));
    await this.store.upsertUser({ clioUserId, email, clioTokens }, this.now());
  }

  /** Current Clio tokens for the user, refreshed first when close to expiry. One refresh per user at a time. */
  getFreshTokens(clioUserId: string): Promise<ClioTokens> {
    const existing = this.inFlight.get(clioUserId);
    if (existing) return existing;
    const p = this.loadAndRefresh(clioUserId).finally(() => this.inFlight.delete(clioUserId));
    this.inFlight.set(clioUserId, p);
    return p;
  }

  private async loadAndRefresh(clioUserId: string): Promise<ClioTokens> {
    const user = await this.store.getUser(clioUserId);
    if (!user) throw new ClioSignInRequiredError();
    const tokens = decryptJson<ClioTokens>(this.key, user.clioTokens, this.aad(clioUserId));
    if (this.now() < tokens.expires_at - REFRESH_MARGIN_MS) return tokens;

    let refreshed: ClioTokens;
    try {
      refreshed = await this.clio.refresh(tokens.refresh_token);
    } catch (err) {
      if (err instanceof ClioOAuthError && (err.code === "invalid_grant" || err.status === 401)) {
        await this.store.revokeUserGrants(clioUserId, this.now());
        throw new ClioSignInRequiredError();
      }
      throw err;
    }
    const next: ClioTokens = { ...refreshed, clio_user_id: clioUserId };
    // Persist before use: if Clio rotated the refresh token, the old one may already be dead.
    await this.store.updateUserTokens(clioUserId, encryptJson(this.key, next, this.aad(clioUserId)), this.now());
    return next;
  }
}
