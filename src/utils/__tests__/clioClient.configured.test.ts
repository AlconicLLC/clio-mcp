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

import {
  clioGet,
  clioPost,
  clioRawGet,
  configureClioClient,
  acquireRequestSlot,
  pauseRequests,
  ClioApiError,
  ClioAuthExpiredError,
  ClioAbortedError,
  ClioRequestFailure,
} from "../clioClient.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;

const config = (overrides: Record<string, unknown> = {}) =>
  configureClioClient({ requestsPerSecond: 1000, maxAttempts: 6, timeoutMs: 5000, baseDelayMs: 1, ...overrides });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  configureClioClient(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("clio client without configuration", () => {
  it("behaves as before: a 503 is not retried", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "down" }, 503));
    await expect(clioGet("/matters.json")).rejects.toBeInstanceOf(ClioApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("configured client: retries", () => {
  it("retries server errors and returns the eventual answer", async () => {
    config();
    fetchMock
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({}, 502))
      .mockResolvedValueOnce(json({ data: [1] }));
    await expect(clioGet("/matters.json")).resolves.toEqual({ data: [1] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after exactly 6 attempts with a failure that carries status and kind but no URL", async () => {
    config();
    fetchMock.mockImplementation(async () => json({}, 503));
    const error = await clioGet("/matters.json").catch((e) => e);
    expect(error).toBeInstanceOf(ClioRequestFailure);
    expect(error).toMatchObject({ status: 503, kind: "server", attempts: 6 });
    expect(error.message).not.toContain("clio.com");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("retries network errors", async () => {
    config();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json({ data: [] }));
    await expect(clioGet("/matters.json")).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out a request that never answers and reports it as a timeout", async () => {
    config({ timeoutMs: 20, maxAttempts: 2 });
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
    );
    const error = await clioGet("/matters.json").catch((e) => e);
    expect(error).toBeInstanceOf(ClioRequestFailure);
    expect(error).toMatchObject({ kind: "timeout", attempts: 2 });
  });

  it("retries a 429 after the Retry-After pause", async () => {
    config();
    fetchMock.mockResolvedValueOnce(json({}, 429, { "Retry-After": "0" })).mockResolvedValueOnce(json({ data: [] }));
    await expect(clioGet("/matters.json")).resolves.toEqual({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry client errors and keeps the URL out of the message", async () => {
    config();
    fetchMock.mockResolvedValueOnce(json({ error: { message: "nope" } }, 404));
    const error = await clioGet("/matters.json").catch((e) => e);
    expect(error).toBeInstanceOf(ClioApiError);
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe("Clio API error 404: nope");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a 401 as an expired login and does not retry", async () => {
    config();
    fetchMock.mockResolvedValueOnce(json({}, 401));
    await expect(clioGet("/matters.json")).rejects.toBeInstanceOf(ClioAuthExpiredError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies the 5xx and network retry to GET only", async () => {
    config();
    fetchMock.mockResolvedValueOnce(json({}, 503));
    await expect(clioPost("/notes.json", { data: {} })).rejects.toBeInstanceOf(ClioApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(clioPost("/notes.json", { data: {} })).rejects.toBeInstanceOf(ClioRequestFailure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at once when the run is aborted", async () => {
    const controller = new AbortController();
    config({ signal: controller.signal });
    controller.abort();
    fetchMock.mockImplementation(async () => json({}));
    await expect(clioGet("/matters.json")).rejects.toBeInstanceOf(ClioAbortedError);
  });

  it("maps a failed token lookup to an expired login", async () => {
    config();
    const oauth = await import("../../auth/oauth.js");
    (oauth.getValidAccessToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("refresh failed"));
    await expect(clioGet("/matters.json")).rejects.toBeInstanceOf(ClioAuthExpiredError);
  });
});

describe("configured client: rate limit", () => {
  it("spaces requests at the configured rate across concurrent callers", async () => {
    vi.useFakeTimers();
    config({ requestsPerSecond: 2 });
    const times: number[] = [];
    const start = Date.now();
    const calls = [0, 1, 2].map(() => acquireRequestSlot().then(() => times.push(Date.now() - start)));
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.all(calls);
    expect(times).toEqual([0, 500, 1000]);
  });

  it("pauses every caller when Clio asks for a pause", async () => {
    vi.useFakeTimers();
    config({ requestsPerSecond: 1000 });
    pauseRequests(2000);
    let done = false;
    const call = acquireRequestSlot().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await call;
    expect(done).toBe(true);
  });

  it("does nothing without a configuration", async () => {
    configureClioClient(null);
    await expect(acquireRequestSlot()).resolves.toBeUndefined();
  });
});

describe("clioRawGet", () => {
  it("returns a redirect without following it and sends the login only to the API host", async () => {
    config();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 303, headers: { Location: "https://storage.example/blob" } }));
    const res = await clioRawGet("/documents/1/download", { redirect: "manual" });
    expect(res.status).toBe(303);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://app.clio.com/api/v4/documents/1/download");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("refuses to send the login to any other host", async () => {
    config();
    await expect(clioRawGet("https://storage.example/blob")).rejects.toThrow(/other than the Clio API/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
