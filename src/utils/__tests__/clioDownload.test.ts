import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../../auth/oauth.js", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
}));

vi.mock("../sessionContext.js", () => ({
  getSessionContext: vi.fn().mockReturnValue(undefined),
  requireSessionContext: vi.fn().mockReturnValue(null),
}));

vi.mock("../clioRegion.js", () => ({
  getClioApiBaseUrl: vi.fn().mockReturnValue("https://app.clio.com/api/v4"),
}));

import { clioDownload, ClioApiError, DownloadTooLargeError } from "../clioClient.js";

const S3_URL = "https://clio-docs.s3.amazonaws.com/abc?X-Amz-Signature=sig";

function fetchMock() {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

describe("clioDownload", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows Clio's redirect to storage without forwarding the Clio token", async () => {
    fetchMock()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: S3_URL } }))
      .mockResolvedValueOnce(new Response("file bytes"));

    const buf = await clioDownload("/documents/9/download", { version_uuid: "v1" }, { maxBytes: 1024 });
    expect(buf.toString()).toBe("file bytes");

    const [clioUrl, clioInit] = fetchMock().mock.calls[0];
    expect(new URL(clioUrl as string).pathname).toBe("/api/v4/documents/9/download");
    expect(new URL(clioUrl as string).searchParams.get("version_uuid")).toBe("v1");
    expect((clioInit as RequestInit).redirect).toBe("manual");
    expect((clioInit as any).headers.Authorization).toBe("Bearer test-token");

    const [storageUrl, storageInit] = fetchMock().mock.calls[1];
    expect(String(storageUrl)).toBe(S3_URL);
    expect((storageInit as any)?.headers?.Authorization).toBeUndefined();
  });

  it("returns the body directly when Clio serves the file itself", async () => {
    fetchMock().mockResolvedValueOnce(new Response("inline bytes"));
    const buf = await clioDownload("/documents/9/download", undefined, { maxBytes: 1024 });
    expect(buf.toString()).toBe("inline bytes");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("refuses a file whose declared size is over the limit", async () => {
    fetchMock().mockResolvedValueOnce(new Response("x".repeat(10), { headers: { "Content-Length": "5000" } }));
    await expect(clioDownload("/documents/9/download", undefined, { maxBytes: 100 }))
      .rejects.toBeInstanceOf(DownloadTooLargeError);
  });

  it("stops reading once a streamed body passes the limit", async () => {
    fetchMock().mockResolvedValueOnce(new Response("x".repeat(500)));
    await expect(clioDownload("/documents/9/download", undefined, { maxBytes: 100 }))
      .rejects.toBeInstanceOf(DownloadTooLargeError);
  });

  it("surfaces Clio errors as ClioApiError", async () => {
    fetchMock().mockResolvedValueOnce(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
    await expect(clioDownload("/documents/9/download", undefined, { maxBytes: 100 }))
      .rejects.toBeInstanceOf(ClioApiError);
  });

  it("reports a storage failure without echoing the signed URL", async () => {
    fetchMock()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: S3_URL } }))
      .mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const err = await clioDownload("/documents/9/download", undefined, { maxBytes: 100 }).catch((e) => e);
    expect(err.message).toContain("HTTP 403");
    expect(err.message).not.toContain("X-Amz-Signature");
  });

  it("fails clearly when a redirect has no Location", async () => {
    fetchMock().mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(clioDownload("/documents/9/download", undefined, { maxBytes: 100 }))
      .rejects.toThrow(/without a download location/);
  });
});
