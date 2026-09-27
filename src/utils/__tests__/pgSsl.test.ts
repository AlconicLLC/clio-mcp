import { describe, expect, it, vi } from "vitest";

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function Pool() {
      return { query: vi.fn(), end: vi.fn() };
    }),
  },
}));

import pg from "pg";
import { createNeonAuditSink } from "../../fork/neonAuditSink.js";
import { PostgresOAuthStore } from "../../server/oauth/store.js";
import { withVerifyFullSsl } from "../pgSsl.js";

describe("withVerifyFullSsl", () => {
  it("rewrites the ssl modes pg currently aliases and will later weaken", () => {
    expect(withVerifyFullSsl("postgres://u:p@ep.neon.tech/neondb?sslmode=require")).toBe(
      "postgres://u:p@ep.neon.tech/neondb?sslmode=verify-full",
    );
    expect(withVerifyFullSsl("postgresql://u:p@h/db?channel_binding=require&sslmode=prefer")).toBe(
      "postgresql://u:p@h/db?channel_binding=require&sslmode=verify-full",
    );
    expect(withVerifyFullSsl("postgres://u:p@h/db?sslmode=verify-ca")).toBe(
      "postgres://u:p@h/db?sslmode=verify-full",
    );
    expect(withVerifyFullSsl("host=ep.neon.tech sslmode=require dbname=neondb")).toBe(
      "host=ep.neon.tech sslmode=verify-full dbname=neondb",
    );
  });

  it("leaves verify-full, disable, and strings without sslmode unchanged", () => {
    for (const url of [
      "postgres://u:p@h/db?sslmode=verify-full",
      "postgres://u:p@h/db?sslmode=disable",
      "postgres://u:p@h/db",
      "postgres://u:sslmode=require@h/db",
    ]) {
      expect(withVerifyFullSsl(url)).toBe(url);
    }
  });

  it("opens both pools with sslmode=verify-full", () => {
    const url = "postgres://u:p@ep.neon.tech/neondb?sslmode=require";
    const expected = {
      connectionString: "postgres://u:p@ep.neon.tech/neondb?sslmode=verify-full",
      max: 5,
    };
    createNeonAuditSink(url);
    PostgresOAuthStore.fromUrl(url);
    expect(pg.Pool).toHaveBeenCalledTimes(2);
    expect(pg.Pool).toHaveBeenNthCalledWith(1, expected);
    expect(pg.Pool).toHaveBeenNthCalledWith(2, expected);
  });
});
