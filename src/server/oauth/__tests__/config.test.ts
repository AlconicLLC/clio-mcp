import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { resolveAuthMode, resolveOAuthConfig, isEmailAllowed, parseEmailDomains } from "../config.js";
import { encryptJson, decryptJson, randomToken, safeEqual } from "../crypto.js";

const BASE = {
  MCP_BASE_URL: "https://clio-mcp.example.com",
  ALLOWED_EMAIL_DOMAINS: "firm.com",
  ENCRYPTION_KEY: "ab".repeat(32),
  DATABASE_URL: "postgres://u:p@db.example/neondb",
  CLIO_CLIENT_ID: "cid",
  CLIO_CLIENT_SECRET: "secret",
};

describe("resolveAuthMode", () => {
  it("defaults to api_key and rejects unknown values", () => {
    expect(resolveAuthMode({})).toBe("api_key");
    expect(resolveAuthMode({ AUTH_MODE: "OAuth" })).toBe("oauth");
    expect(() => resolveAuthMode({ AUTH_MODE: "none" })).toThrow(/AUTH_MODE/);
  });
});

describe("resolveOAuthConfig", () => {
  it("builds the resource URL from MCP_BASE_URL and defaults to Postgres", () => {
    const c = resolveOAuthConfig(BASE);
    expect(c.resourceUrl.href).toBe("https://clio-mcp.example.com/mcp");
    expect(c.store).toEqual({ kind: "postgres", databaseUrl: BASE.DATABASE_URL });
    expect(c.clioUsePkce).toBe(false);
    expect(c.trustProxy).toBe(1);
  });

  it.each([
    ["no allowed domains", { ALLOWED_EMAIL_DOMAINS: "" }, /ALLOWED_EMAIL_DOMAINS/],
    ["a short key", { ENCRYPTION_KEY: "abcd" }, /ENCRYPTION_KEY/],
    ["plain http on a public host", { MCP_BASE_URL: "http://clio-mcp.example.com" }, /https/i],
    ["a base URL with a path", { MCP_BASE_URL: "https://clio-mcp.example.com/app" }, /MCP_BASE_URL/],
    ["no database", { DATABASE_URL: "" }, /DATABASE_URL/],
    ["broker mode", { TOKEN_BROKER_URL: "https://broker.example" }, /TOKEN_BROKER_URL/],
    ["no Clio secret", { CLIO_CLIENT_SECRET: "" }, /CLIO_CLIENT_SECRET/],
  ])("refuses %s", (_label, over, message) => {
    expect(() => resolveOAuthConfig({ ...BASE, ...over })).toThrow(message);
  });

  it("allows http only on loopback, for local testing", () => {
    expect(resolveOAuthConfig({ ...BASE, MCP_BASE_URL: "http://127.0.0.1:3000" }).baseUrl).toBe("http://127.0.0.1:3000");
  });
});

describe("email domain check", () => {
  const domains = parseEmailDomains("Firm.com, @firm-law.com");

  it("accepts exact domains, case-insensitively", () => {
    expect(isEmailAllowed("a@firm.com", domains)).toBe(true);
    expect(isEmailAllowed("A@FIRM-LAW.COM", domains)).toBe(true);
  });

  it.each([
    "a@sub.firm.com", "a@firm.com.evil.example", "a@evilfirm.com", "a@b@firm.com", "@firm.com", "firm.com", "", undefined,
  ])("rejects %s", (email) => {
    expect(isEmailAllowed(email, domains)).toBe(false);
  });

  it("rejects malformed domains in configuration", () => {
    expect(() => parseEmailDomains("firm.com, *.evil")).toThrow();
  });
});

describe("crypto", () => {
  const key = randomBytes(32);

  it("round-trips and binds ciphertext to its AAD and key", () => {
    const blob = encryptJson(key, { a: 1 }, "clio-tokens:1");
    expect(decryptJson(key, blob, "clio-tokens:1")).toEqual({ a: 1 });
    expect(() => decryptJson(key, blob, "clio-tokens:2")).toThrow();
    expect(() => decryptJson(randomBytes(32), blob, "clio-tokens:1")).toThrow();
  });

  it("detects tampering", () => {
    const blob = encryptJson(key, { a: 1 }, "x");
    const raw = Buffer.from(blob.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptJson(key, `v1:${raw.toString("base64")}`, "x")).toThrow();
  });

  it("uses a fresh IV every time", () => {
    expect(encryptJson(key, { a: 1 }, "x")).not.toBe(encryptJson(key, { a: 1 }, "x"));
  });

  it("makes 256-bit url-safe tokens and compares safely", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(safeEqual(t, t)).toBe(true);
    expect(safeEqual(t, t.slice(1))).toBe(false);
  });
});
