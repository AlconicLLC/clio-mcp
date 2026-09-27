import { describe, it, expect, vi } from "vitest";
import { createClaudeClientsStore, validateClaudeClientDocument, CLAUDE_CLIENT_ID_URLS } from "../claudeClients.js";

const ID = CLAUDE_CLIENT_ID_URLS[0];
const DOC = {
  client_id: ID,
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createClaudeClientsStore", () => {
  it("never fetches a client_id that is not allowlisted", async () => {
    const fetchImpl = vi.fn(async () => json(DOC));
    const store = createClaudeClientsStore({ fetchImpl });
    expect(await store.getClient("https://evil.example/client.json")).toBeUndefined();
    expect(await store.getClient("http://169.254.169.254/latest/meta-data")).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns Claude as a public client with no secret", async () => {
    const store = createClaudeClientsStore({ fetchImpl: async () => json(DOC) });
    const client = await store.getClient(ID);
    expect(client?.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(client?.token_endpoint_auth_method).toBe("none");
    expect(client?.client_secret).toBeUndefined();
  });

  it("fetches without following redirects and caches for an hour", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return json(DOC);
    });
    const store = createClaudeClientsStore({ fetchImpl: fetchImpl as typeof fetch, now: () => t });
    await store.getClient(ID);
    t += 30 * 60 * 1000;
    await store.getClient(ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += 31 * 60 * 1000;
    await store.getClient(ID);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps using the last good document when a refetch fails", async () => {
    let t = 0;
    let fail = false;
    const store = createClaudeClientsStore({
      fetchImpl: async () => (fail ? json({}, 503) : json(DOC)),
      now: () => t,
    });
    await store.getClient(ID);
    fail = true;
    t += 2 * 60 * 60 * 1000;
    expect((await store.getClient(ID))?.redirect_uris).toEqual(DOC.redirect_uris);
  });

  it("falls back to Claude's documented callback when claude.ai blocks the fetch", async () => {
    const store = createClaudeClientsStore({
      fetchImpl: async () => new Response("<html>Just a moment...</html>", { status: 403 }),
    });
    const client = await store.getClient(ID);
    expect(client?.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  it("refuses a document that points codes anywhere but claude.ai (no pinned fallback with a custom allowlist)", async () => {
    const store = createClaudeClientsStore({
      allowedClientIds: [ID],
      fetchImpl: async () => json({ ...DOC, redirect_uris: ["https://evil.example/cb"] }),
    });
    expect(await store.getClient(ID)).toBeUndefined();
  });

  it("refuses an oversized document", async () => {
    const store = createClaudeClientsStore({
      allowedClientIds: [ID],
      fetchImpl: async () => new Response("x".repeat(70 * 1024)),
    });
    expect(await store.getClient(ID)).toBeUndefined();
  });
});

describe("validateClaudeClientDocument", () => {
  it.each([
    ["mismatched client_id", { ...DOC, client_id: "https://claude.ai/other" }],
    ["no redirect_uris", { ...DOC, redirect_uris: [] }],
    ["http redirect", { ...DOC, redirect_uris: ["http://claude.ai/api/mcp/auth_callback"] }],
    ["lookalike host", { ...DOC, redirect_uris: ["https://claude.ai.evil.example/cb"] }],
    ["userinfo trick", { ...DOC, redirect_uris: ["https://claude.ai@evil.example/cb"] }],
    ["confidential client", { ...DOC, token_endpoint_auth_method: "client_secret_post" }],
    ["not an object", "hello"],
  ])("rejects %s", (_label, doc) => {
    expect(() => validateClaudeClientDocument(ID, doc)).toThrow();
  });
});
