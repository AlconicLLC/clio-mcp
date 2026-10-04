import { vi, describe, it, expect, afterEach } from "vitest";

vi.mock("@napi-rs/keyring", () => ({
  Entry: class { getPassword() { return null; } setPassword() {} deletePassword() {} },
}));

import { clioGet } from "../utils/clioClient.js";
import { runWithSessionContext, type SessionContext } from "../utils/sessionContext.js";

function ctx(region?: SessionContext["region"]): SessionContext {
  return {
    sessionId: "s1",
    region,
    getAccessToken: async () => "tok",
    getTokens: async () => null,
    storeTokens: async () => {},
    clearTokens: async () => {},
  };
}

describe("per-session Clio region", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function captureUrl(): { urls: string[] } {
    const seen = { urls: [] as string[] };
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      seen.urls.push(String(url));
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    return seen;
  }

  it("sends data calls to the session's region, not the process default", async () => {
    const seen = captureUrl();
    await runWithSessionContext(ctx("eu"), () => clioGet("/users/who_am_i.json"));
    expect(seen.urls[0]).toMatch(/^https:\/\/eu\.app\.clio\.com\/api\/v4\/users\/who_am_i\.json/);
  });

  it("falls back to CLIO_REGION when the session has no region", async () => {
    const seen = captureUrl();
    await runWithSessionContext(ctx(), () => clioGet("/users/who_am_i.json"));
    expect(seen.urls[0]).toMatch(/^https:\/\/app\.clio\.com\/api\/v4\//);
  });
});
