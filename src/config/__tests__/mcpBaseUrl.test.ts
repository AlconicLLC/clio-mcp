import { describe, it, expect } from "vitest";
import { resolveMcpBaseUrl } from "../mcpBaseUrl.js";

describe("resolveMcpBaseUrl", () => {
  it("returns undefined when nothing is set", () => {
    expect(resolveMcpBaseUrl({})).toBeUndefined();
    expect(resolveMcpBaseUrl({ MCP_BASE_URL: "  ", RAILWAY_PUBLIC_DOMAIN: "" })).toBeUndefined();
  });

  it("uses MCP_BASE_URL when set and strips trailing slashes", () => {
    expect(resolveMcpBaseUrl({ MCP_BASE_URL: "https://mcp.example.com/" })).toBe("https://mcp.example.com");
    expect(resolveMcpBaseUrl({ MCP_BASE_URL: "https://mcp.example.com///" })).toBe("https://mcp.example.com");
    expect(resolveMcpBaseUrl({ MCP_BASE_URL: "  http://127.0.0.1:3000  " })).toBe("http://127.0.0.1:3000");
  });

  it("prefers MCP_BASE_URL over Railway's generated domain", () => {
    expect(
      resolveMcpBaseUrl({
        MCP_BASE_URL: "https://clio.example.com",
        RAILWAY_PUBLIC_DOMAIN: "ignored.up.railway.app",
      })
    ).toBe("https://clio.example.com");
  });

  it("falls back to https://RAILWAY_PUBLIC_DOMAIN", () => {
    expect(resolveMcpBaseUrl({ RAILWAY_PUBLIC_DOMAIN: "clio-mcp-prod.up.railway.app" }))
      .toBe("https://clio-mcp-prod.up.railway.app");
    expect(resolveMcpBaseUrl({ RAILWAY_PUBLIC_DOMAIN: "clio-mcp-prod.up.railway.app/" }))
      .toBe("https://clio-mcp-prod.up.railway.app");
  });

  it("does not double-prefix a Railway domain that already includes a scheme", () => {
    expect(resolveMcpBaseUrl({ RAILWAY_PUBLIC_DOMAIN: "https://custom.example.com" }))
      .toBe("https://custom.example.com");
  });
});
