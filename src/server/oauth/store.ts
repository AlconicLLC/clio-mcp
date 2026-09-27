/**
 * Durable state for AUTH_MODE=oauth: signed-in users (with encrypted Clio
 * tokens), grants (one per Claude connection), and the hashes of the access
 * and refresh tokens issued under each grant.
 *
 * The store never sees a plaintext token or Clio credential: callers pass
 * hashes and ciphertext.
 */
import pg from "pg";
import { withVerifyFullSsl } from "../../utils/pgSsl.js";

export type TokenKind = "access" | "refresh";

export interface StoredUser {
  clioUserId: string;
  email: string;
  /** AES-256-GCM ciphertext, see crypto.ts. */
  clioTokens: string;
}

export interface TokenRow {
  tokenHash: string;
  kind: TokenKind;
  grantId: string;
  expiresAt: number;
}

export interface TokenLookup extends TokenRow {
  usedAt: number | null;
  clioUserId: string;
  clientId: string;
  grantRevokedAt: number | null;
}

export interface OAuthStore {
  /** Throws with setup instructions when the tables are missing. */
  checkSchema(): Promise<void>;
  upsertUser(user: StoredUser, now: number): Promise<void>;
  getUser(clioUserId: string): Promise<StoredUser | null>;
  updateUserTokens(clioUserId: string, clioTokens: string, now: number): Promise<void>;
  createGrant(grant: { grantId: string; clioUserId: string; clientId: string }, now: number): Promise<void>;
  insertTokens(rows: TokenRow[]): Promise<void>;
  findToken(tokenHash: string): Promise<TokenLookup | null>;
  /** Atomically marks an unused refresh token as used. False means it had already been used. */
  consumeRefreshToken(tokenHash: string, now: number): Promise<boolean>;
  revokeGrant(grantId: string, now: number): Promise<void>;
  revokeUserGrants(clioUserId: string, now: number): Promise<void>;
  purgeExpired(now: number): Promise<void>;
  close(): Promise<void>;
}

const REVOKED_GRANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class MemoryOAuthStore implements OAuthStore {
  private users = new Map<string, StoredUser>();
  private grants = new Map<string, { clioUserId: string; clientId: string; revokedAt: number | null }>();
  private tokens = new Map<string, TokenRow & { usedAt: number | null }>();

  async checkSchema(): Promise<void> {}

  async upsertUser(user: StoredUser): Promise<void> {
    this.users.set(user.clioUserId, { ...user });
  }

  async getUser(clioUserId: string): Promise<StoredUser | null> {
    const u = this.users.get(clioUserId);
    return u ? { ...u } : null;
  }

  async updateUserTokens(clioUserId: string, clioTokens: string): Promise<void> {
    const u = this.users.get(clioUserId);
    if (u) u.clioTokens = clioTokens;
  }

  async createGrant(grant: { grantId: string; clioUserId: string; clientId: string }): Promise<void> {
    if (!this.users.has(grant.clioUserId)) throw new Error("Unknown user for grant.");
    this.grants.set(grant.grantId, { clioUserId: grant.clioUserId, clientId: grant.clientId, revokedAt: null });
  }

  async insertTokens(rows: TokenRow[]): Promise<void> {
    for (const r of rows) {
      if (!this.grants.has(r.grantId)) throw new Error("Unknown grant for token.");
      this.tokens.set(r.tokenHash, { ...r, usedAt: null });
    }
  }

  async findToken(tokenHash: string): Promise<TokenLookup | null> {
    const t = this.tokens.get(tokenHash);
    if (!t) return null;
    const g = this.grants.get(t.grantId);
    if (!g || !this.users.has(g.clioUserId)) return null;
    return { ...t, clioUserId: g.clioUserId, clientId: g.clientId, grantRevokedAt: g.revokedAt };
  }

  async consumeRefreshToken(tokenHash: string, now: number): Promise<boolean> {
    const t = this.tokens.get(tokenHash);
    if (!t || t.kind !== "refresh" || t.usedAt !== null) return false;
    t.usedAt = now;
    return true;
  }

  async revokeGrant(grantId: string, now: number): Promise<void> {
    const g = this.grants.get(grantId);
    if (g && g.revokedAt === null) g.revokedAt = now;
  }

  async revokeUserGrants(clioUserId: string, now: number): Promise<void> {
    for (const g of this.grants.values()) {
      if (g.clioUserId === clioUserId && g.revokedAt === null) g.revokedAt = now;
    }
  }

  async purgeExpired(now: number): Promise<void> {
    for (const [hash, t] of this.tokens) if (t.expiresAt < now) this.tokens.delete(hash);
    for (const [id, g] of this.grants) {
      if (g.revokedAt !== null && g.revokedAt < now - REVOKED_GRANT_RETENTION_MS) {
        this.grants.delete(id);
        for (const [hash, t] of this.tokens) if (t.grantId === id) this.tokens.delete(hash);
      }
    }
  }

  async close(): Promise<void> {}
}

export type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
  end?: () => Promise<void>;
};

const REQUIRED_TABLES = ["oauth_users", "oauth_grants", "oauth_tokens"];

export class PostgresOAuthStore implements OAuthStore {
  constructor(private readonly db: Queryable) {}

  static fromUrl(databaseUrl: string): PostgresOAuthStore {
    return new PostgresOAuthStore(new pg.Pool({ connectionString: withVerifyFullSsl(databaseUrl), max: 5 }));
  }

  async checkSchema(): Promise<void> {
    const missing: string[] = [];
    for (const table of REQUIRED_TABLES) {
      try {
        await this.db.query(`SELECT 1 FROM ${table} LIMIT 0`);
      } catch (err: any) {
        // 42P01 is undefined_table; anything else (auth, network) is a different problem.
        if (err?.code === "42P01" || /does not exist/i.test(String(err?.message))) missing.push(table);
        else throw err;
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Sign-in tables are missing from DATABASE_URL (${missing.join(", ")}). ` +
        `Create them once with: psql "$DATABASE_URL" -f src/server/oauth/schema.sql`
      );
    }
  }

  async upsertUser(user: StoredUser, now: number): Promise<void> {
    await this.db.query(
      `INSERT INTO oauth_users (clio_user_id, email, clio_tokens, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (clio_user_id) DO UPDATE SET email = EXCLUDED.email, clio_tokens = EXCLUDED.clio_tokens, updated_at = EXCLUDED.updated_at`,
      [user.clioUserId, user.email, user.clioTokens, now]
    );
  }

  async getUser(clioUserId: string): Promise<StoredUser | null> {
    const { rows } = await this.db.query(
      "SELECT clio_user_id, email, clio_tokens FROM oauth_users WHERE clio_user_id = $1",
      [clioUserId]
    );
    const r = rows[0];
    return r ? { clioUserId: String(r.clio_user_id), email: String(r.email), clioTokens: String(r.clio_tokens) } : null;
  }

  async updateUserTokens(clioUserId: string, clioTokens: string, now: number): Promise<void> {
    await this.db.query(
      "UPDATE oauth_users SET clio_tokens = $2, updated_at = $3 WHERE clio_user_id = $1",
      [clioUserId, clioTokens, now]
    );
  }

  async createGrant(grant: { grantId: string; clioUserId: string; clientId: string }, now: number): Promise<void> {
    await this.db.query(
      "INSERT INTO oauth_grants (grant_id, clio_user_id, client_id, created_at) VALUES ($1, $2, $3, $4)",
      [grant.grantId, grant.clioUserId, grant.clientId, now]
    );
  }

  async insertTokens(rows: TokenRow[]): Promise<void> {
    for (const r of rows) {
      await this.db.query(
        "INSERT INTO oauth_tokens (token_hash, kind, grant_id, expires_at) VALUES ($1, $2, $3, $4)",
        [r.tokenHash, r.kind, r.grantId, r.expiresAt]
      );
    }
  }

  async findToken(tokenHash: string): Promise<TokenLookup | null> {
    const { rows } = await this.db.query(
      `SELECT t.token_hash, t.kind, t.grant_id, t.expires_at, t.used_at, g.clio_user_id, g.client_id, g.revoked_at
       FROM oauth_tokens t JOIN oauth_grants g ON g.grant_id = t.grant_id
       WHERE t.token_hash = $1`,
      [tokenHash]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      tokenHash: String(r.token_hash),
      kind: r.kind === "refresh" ? "refresh" : "access",
      grantId: String(r.grant_id),
      expiresAt: Number(r.expires_at),
      usedAt: r.used_at === null || r.used_at === undefined ? null : Number(r.used_at),
      clioUserId: String(r.clio_user_id),
      clientId: String(r.client_id),
      grantRevokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : Number(r.revoked_at),
    };
  }

  async consumeRefreshToken(tokenHash: string, now: number): Promise<boolean> {
    const { rows } = await this.db.query(
      "UPDATE oauth_tokens SET used_at = $2 WHERE token_hash = $1 AND kind = 'refresh' AND used_at IS NULL RETURNING token_hash",
      [tokenHash, now]
    );
    return rows.length === 1;
  }

  async revokeGrant(grantId: string, now: number): Promise<void> {
    await this.db.query(
      "UPDATE oauth_grants SET revoked_at = $2 WHERE grant_id = $1 AND revoked_at IS NULL",
      [grantId, now]
    );
  }

  async revokeUserGrants(clioUserId: string, now: number): Promise<void> {
    await this.db.query(
      "UPDATE oauth_grants SET revoked_at = $2 WHERE clio_user_id = $1 AND revoked_at IS NULL",
      [clioUserId, now]
    );
  }

  async purgeExpired(now: number): Promise<void> {
    await this.db.query("DELETE FROM oauth_tokens WHERE expires_at < $1", [now]);
    await this.db.query(
      "DELETE FROM oauth_grants WHERE revoked_at IS NOT NULL AND revoked_at < $1",
      [now - REVOKED_GRANT_RETENTION_MS]
    );
  }

  async close(): Promise<void> {
    await this.db.end?.();
  }
}
