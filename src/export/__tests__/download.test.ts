import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    getPassword() { return null; }
    setPassword() {}
    deletePassword() {}
  },
}));

import { startFakeClio, makeTempDir } from "./helpers.js";
import type { FakeClio, FakeClioOptions } from "./helpers.js";
import { downloadDocument } from "../download.js";
import { DownloadFailure } from "../errors.js";
import { configureClioClient, ClioAbortedError } from "../../utils/clioClient.js";
import { runWithSessionContext } from "../../utils/sessionContext.js";

let fake: FakeClio;
let dir: string;

async function start(options: FakeClioOptions = {}) {
  fake = await startFakeClio(options);
  process.env.CLIO_API_BASE = fake.apiBase;
  configureClioClient({ requestsPerSecond: 1000, maxAttempts: 6, timeoutMs: 5000, baseDelayMs: 1 });
}

const inSession = <T>(fn: () => Promise<T>) =>
  runWithSessionContext(
    { sessionId: "t", getAccessToken: async () => "test-token", getTokens: async () => null, storeTokens: async () => {}, clearTokens: async () => {} },
    fn
  );

beforeEach(async () => {
  dir = await makeTempDir("clio-download-");
});

afterEach(async () => {
  configureClioClient(null);
  delete process.env.CLIO_API_BASE;
  await fake?.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

const doc = (id: number, extra: Partial<Parameters<typeof downloadDocument>[0]> = {}) => {
  const content = fake.state.contents.get(`uuid-${id}-1`) as string;
  return {
    documentId: id,
    versionUuid: `uuid-${id}-1`,
    destination: path.join(dir, "nested", "file.bin"),
    expectedSize: Buffer.byteLength(content),
    signal: new AbortController().signal,
    ...extra,
  };
};

describe("downloadDocument", () => {
  it("streams the file to its final name and sends the login only to the API host", async () => {
    await start();
    const opts = doc(5000);
    const { bytes } = await inSession(() => downloadDocument(opts));
    expect(await fs.readFile(opts.destination, "utf8")).toBe(fake.state.contents.get("uuid-5000-1"));
    expect(bytes).toBe(opts.expectedSize);
    await expect(fs.stat(`${opts.destination}.part`)).rejects.toThrow();
    expect(fake.stats.storage).toEqual([{ path: "/blob/uuid-5000-1", hasAuthorization: false }]);
    expect(fake.stats.requests.every((r) => r.hasAuthorization)).toBe(true);
  });

  it("never leaves a half-finished file under the final name when the size is wrong", async () => {
    await start();
    const opts = doc(5000, { expectedSize: 3 });
    const error = await inSession(() => downloadDocument(opts)).catch((e) => e);
    expect(error).toBeInstanceOf(DownloadFailure);
    expect(error).toMatchObject({ kind: "size_mismatch", attempts: 6 });
    await expect(fs.stat(opts.destination)).rejects.toThrow();
    await expect(fs.stat(`${opts.destination}.part`)).rejects.toThrow();
  });

  it("retries a storage error and succeeds", async () => {
    await start({ failures: [{ match: "uuid-5000-1", storage: true, status: 503, times: 2 }] });
    const opts = doc(5000);
    await inSession(() => downloadDocument(opts));
    expect(fake.stats.storage).toHaveLength(3);
    expect(await fs.readFile(opts.destination, "utf8")).toBe(fake.state.contents.get("uuid-5000-1"));
  });

  it("asks for a fresh link once or twice when the storage link has expired, then gives up", async () => {
    await start({ failures: [{ match: "uuid-5000-1", storage: true, status: 403, times: 100 }] });
    const error = await inSession(() => downloadDocument(doc(5000))).catch((e) => e);
    expect(error).toMatchObject({ status: 403, kind: "storage_expired" });
    expect(fake.stats.storage.length).toBe(2);
  });

  it("does not retry when Clio itself says the document is gone", async () => {
    await start();
    const error = await inSession(() => downloadDocument(doc(5000, { versionUuid: "uuid-unknown" }))).catch((e) => e);
    expect(error).toMatchObject({ status: 404, kind: "client" });
    expect(fake.stats.storage).toHaveLength(0);
  });

  it("stops with an abort error and never counts it as a failed download", async () => {
    await start({ downloadDelayMs: 300 });
    const controller = new AbortController();
    const pending = inSession(() => downloadDocument(doc(5000, { signal: controller.signal })));
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toBeInstanceOf(ClioAbortedError);
  });

  it("downloads an empty file", async () => {
    await start();
    fake.state.contents.set("uuid-empty", "");
    const opts = { ...doc(5000), versionUuid: "uuid-empty", expectedSize: 0 };
    fake.state.documents[0].latest_document_version.uuid = "uuid-empty";
    await inSession(() => downloadDocument(opts));
    expect((await fs.stat(opts.destination)).size).toBe(0);
  });
});
