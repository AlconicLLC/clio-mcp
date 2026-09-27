import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { newDb } from "pg-mem";
import { MemoryOAuthStore, PostgresOAuthStore } from "../store.js";
import type { OAuthStore } from "../store.js";

const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../schema.sql"), "utf8");

function pgStore(withSchema = true): PostgresOAuthStore {
  const db = newDb();
  if (withSchema) db.public.none(schema);
  const { Pool } = db.adapters.createPg();
  return new PostgresOAuthStore(new Pool());
}

const stores: Record<string, () => OAuthStore> = {
  memory: () => new MemoryOAuthStore(),
  postgres: () => pgStore(),
};

for (const [name, make] of Object.entries(stores)) {
  describe(`${name} OAuth store`, () => {
    let store: OAuthStore;
    const now = 1_000_000;

    beforeEach(async () => {
      store = make();
      await store.checkSchema();
      await store.upsertUser({ clioUserId: "u1", email: "a@firm.com", clioTokens: "v1:cipher" }, now);
      await store.createGrant({ grantId: "g1", clioUserId: "u1", clientId: "c1" }, now);
      await store.insertTokens([
        { tokenHash: "acc", kind: "access", grantId: "g1", expiresAt: now + 1000 },
        { tokenHash: "ref", kind: "refresh", grantId: "g1", expiresAt: now + 5000 },
      ]);
    });

    it("upserts users and updates their ciphertext", async () => {
      await store.upsertUser({ clioUserId: "u1", email: "b@firm.com", clioTokens: "v1:new" }, now + 1);
      expect(await store.getUser("u1")).toEqual({ clioUserId: "u1", email: "b@firm.com", clioTokens: "v1:new" });
      await store.updateUserTokens("u1", "v1:newer", now + 2);
      expect((await store.getUser("u1"))!.clioTokens).toBe("v1:newer");
      expect(await store.getUser("nobody")).toBeNull();
    });

    it("finds a token with its grant", async () => {
      expect(await store.findToken("acc")).toMatchObject({
        kind: "access", grantId: "g1", expiresAt: now + 1000, usedAt: null,
        clioUserId: "u1", clientId: "c1", grantRevokedAt: null,
      });
      expect(await store.findToken("missing")).toBeNull();
    });

    it("consumes a refresh token exactly once", async () => {
      expect(await store.consumeRefreshToken("ref", now)).toBe(true);
      expect(await store.consumeRefreshToken("ref", now)).toBe(false);
      expect(await store.consumeRefreshToken("acc", now)).toBe(false);
      expect((await store.findToken("ref"))!.usedAt).toBe(now);
    });

    it("revokes a grant and every grant of a user", async () => {
      await store.revokeGrant("g1", now + 10);
      expect((await store.findToken("acc"))!.grantRevokedAt).toBe(now + 10);

      await store.createGrant({ grantId: "g2", clioUserId: "u1", clientId: "c1" }, now);
      await store.insertTokens([{ tokenHash: "acc2", kind: "access", grantId: "g2", expiresAt: now + 1000 }]);
      await store.revokeUserGrants("u1", now + 20);
      expect((await store.findToken("acc2"))!.grantRevokedAt).toBe(now + 20);
      expect((await store.findToken("acc"))!.grantRevokedAt).toBe(now + 10);
    });

    it("purges expired tokens", async () => {
      await store.purgeExpired(now + 2000);
      expect(await store.findToken("acc")).toBeNull();
      expect(await store.findToken("ref")).not.toBeNull();
    });
  });
}

describe("PostgresOAuthStore.checkSchema", () => {
  it("names the setup command when the tables are missing", async () => {
    await expect(pgStore(false).checkSchema()).rejects.toThrow(/schema\.sql/);
  });
});
