import { describe, it, expect, beforeEach, vi } from "vitest";
import { runAuth } from "../auth.js";
import type { AuthDeps } from "../auth.js";
import { EXIT } from "../args.js";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const VALID_ENV = { CLIO_CLIENT_ID: "id", CLIO_CLIENT_SECRET: "secret" } as NodeJS.ProcessEnv;

let out: string[];
let err: string[];

function deps(overrides: Partial<AuthDeps> = {}): Partial<AuthDeps> {
  return {
    env: VALID_ENV,
    now: () => NOW,
    login: vi.fn(async () => ({ access_token: "a", refresh_token: "r", expires_at: NOW + 3_600_000 })),
    whoAmI: vi.fn(async () => ({ id: "42", name: "Test User", email: "test@example.invalid" })),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    ...overrides,
  };
}

beforeEach(() => {
  out = [];
  err = [];
  delete process.env.CLIO_REGION;
  delete process.env.CLIO_API_BASE;
});

describe("runAuth", () => {
  it("prints who logged in and when the token expires, then exits 0", async () => {
    expect(await runAuth([], deps())).toBe(EXIT.OK);
    expect(out.join("")).toContain("Logged in to Clio as Test User <test@example.invalid> (user id 42).");
    expect(out.join("")).toContain("2026-10-19T13:00:00.000Z (in 60 minutes)");
  });

  it("still succeeds when who_am_i fails, falling back to the id saved with the token", async () => {
    const d = deps({
      login: vi.fn(async () => ({ access_token: "a", refresh_token: "r", expires_at: NOW + 60_000, clio_user_id: "7" })),
      whoAmI: vi.fn(async () => { throw new Error("boom"); }),
    });
    expect(await runAuth([], d)).toBe(EXIT.OK);
    expect(out.join("")).toContain("Logged in to Clio as user id 7.");
  });

  it("exits 5 with the reason when the login fails", async () => {
    const d = deps({ login: vi.fn(async () => { throw new Error("OAuth timeout"); }) });
    expect(await runAuth([], d)).toBe(EXIT.FATAL);
    expect(err.join("")).toContain("Login failed: OAuth timeout");
  });

  it("exits 2 when the client credentials are missing, without starting a login", async () => {
    const d = deps({ env: {} });
    expect(await runAuth([], d)).toBe(EXIT.USAGE);
    expect(d.login).not.toHaveBeenCalled();
  });

  it("exits 2 on an invalid CLIO_REGION", async () => {
    process.env.CLIO_REGION = "mars";
    const d = deps();
    expect(await runAuth([], d)).toBe(EXIT.USAGE);
    expect(d.login).not.toHaveBeenCalled();
  });

  it("rejects options and prints help on request", async () => {
    expect(await runAuth(["--out", "x"], deps())).toBe(EXIT.USAGE);
    expect(await runAuth(["--help"], deps())).toBe(EXIT.OK);
    expect(out.join("")).toContain("Usage:");
  });
});
