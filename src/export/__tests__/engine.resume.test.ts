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

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async (_entry: unknown) => {}) }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: auditMock }));

import { startFakeClio, makeArgs, makeTempDir, runEngineAgainst, readJsonl, listFiles } from "./helpers.js";
import type { FakeClio, FakeClioOptions } from "./helpers.js";

const dirs: string[] = [];
const fakes: FakeClio[] = [];

async function dir(): Promise<string> {
  const d = await makeTempDir();
  dirs.push(d);
  return d;
}

async function fakeClio(options: FakeClioOptions = {}): Promise<FakeClio> {
  const f = await startFakeClio(options);
  fakes.push(f);
  return f;
}

beforeEach(() => auditMock.mockClear());

afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  delete process.env.CLIO_API_BASE;
});

const read = (root: string, rel: string) => fs.readFile(path.join(root, rel), "utf8");

async function dataFiles(root: string): Promise<string[]> {
  return (await listFiles(root)).filter((f) => f.startsWith("data/") && !f.startsWith("data/documents."));
}

async function referenceRun(options: FakeClioOptions, only: string[] | null = null): Promise<{ root: string; fake: FakeClio }> {
  const root = await dir();
  const fake = await fakeClio(options);
  const result = await runEngineAgainst(fake, makeArgs(root, { only }));
  expect(result.code).toBe(0);
  return { root, fake };
}

function abortWhen(condition: (record: { path: string; query: string }, count: number) => boolean) {
  const controller = new AbortController();
  let count = 0;
  const onRequest = (record: { path: string; query: string }) => {
    if (condition(record, count++)) controller.abort();
  };
  return { controller, onRequest };
}

describe("export engine: resume", () => {
  it("resumes a flat type mid-page-sequence with no duplicate or missing rows", async () => {
    const only = ["matters"];
    const reference = await referenceRun({ matterCount: 450 }, only);
    const root = await dir();
    const { controller, onRequest } = abortWhen((r) => r.path.endsWith("/matters.json") && r.query.includes("billable") && r.query.includes("page_token"));
    const fake = await fakeClio({ matterCount: 450, onRequest });

    const first = await runEngineAgainst(fake, makeArgs(root, { only }), { signal: controller.signal });
    expect(first.code).toBe(4);
    expect((await read(root, "data/matters.jsonl")).split("\n").filter(Boolean).length).toBeLessThan(450);

    const second = await runEngineAgainst(fake, makeArgs(root, { only, resume: true }));
    expect(second.code).toBe(0);
    for (const file of await dataFiles(reference.root)) {
      expect(await read(root, file), file).toBe(await read(reference.root, file));
    }
    const ids = (await readJsonl(path.join(root, "data/matters.jsonl"))).map((m) => m.id);
    expect(new Set(ids).size).toBe(450);
  });

  it("truncates rows written after the last checkpoint, as after a kill between write and checkpoint", async () => {
    const only = ["matters"];
    const reference = await referenceRun({ matterCount: 450 }, only);
    const root = await dir();
    const { controller, onRequest } = abortWhen((r) => r.path.endsWith("/matters.json") && r.query.includes("billable") && r.query.includes("page_token"));
    const fake = await fakeClio({ matterCount: 450, onRequest });
    expect((await runEngineAgainst(fake, makeArgs(root, { only }), { signal: controller.signal })).code).toBe(4);

    await fs.appendFile(path.join(root, "data/matters.jsonl"), '{"id":999999,"stray":"row after the checkpoint"}\n');
    await fs.appendFile(path.join(root, "data/matters.csv"), "999999,stray\r\n");

    expect((await runEngineAgainst(fake, makeArgs(root, { only, resume: true }))).code).toBe(0);
    expect(await read(root, "data/matters.jsonl")).toBe(await read(reference.root, "data/matters.jsonl"));
    expect(await read(root, "data/matters.csv")).toBe(await read(reference.root, "data/matters.csv"));
  });

  it("resumes the per-matter documents pass at the right matter and page without duplicates", async () => {
    const reference = await referenceRun({ matterCount: 60 });
    const root = await dir();
    const { controller, onRequest } = abortWhen((r) => r.path.endsWith("/documents.json") && r.query.includes("matter_id=30&"));
    const fake = await fakeClio({ matterCount: 60, onRequest });
    const first = await runEngineAgainst(fake, makeArgs(root), { signal: controller.signal });
    expect(first.code).toBe(4);
    const partial = await readJsonl(path.join(root, "data/documents.jsonl"));
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(240);

    expect((await runEngineAgainst(fake, makeArgs(root, { resume: true }))).code).toBe(0);
    const docs = await readJsonl(path.join(root, "data/documents.jsonl"));
    const refDocs = await readJsonl(path.join(reference.root, "data/documents.jsonl"));
    expect(docs).toHaveLength(240);
    expect(new Set(docs.map((d) => d.id)).size).toBe(240);
    expect(docs.map((d) => d.id)).toEqual(refDocs.map((d) => d.id));
    expect((await listFiles(root)).filter((f) => f.startsWith("matters/")).length).toBe(
      (await listFiles(reference.root)).filter((f) => f.startsWith("matters/")).length
    );
  }, 60_000);

  it("resumes the shared documents checkpoint with the documents and version files kept consistent", async () => {
    const root = await dir();
    const { controller, onRequest } = abortWhen((r) => r.path.endsWith("/documents.json") && r.query.includes("matter_id=20&"));
    const fake = await fakeClio({ matterCount: 40, onRequest });
    const only = ["matters", "folders", "documents", "document_versions"];
    expect((await runEngineAgainst(fake, makeArgs(root, { only }), { signal: controller.signal })).code).toBe(4);
    await fs.appendFile(path.join(root, "data/documents.jsonl"), '{"id":1}\n');
    await fs.appendFile(path.join(root, "data/document_versions.jsonl"), '{"id":1}\n');
    expect((await runEngineAgainst(fake, makeArgs(root, { only, resume: true }))).code).toBe(0);
    expect(new Set((await readJsonl(path.join(root, "data/documents.jsonl"))).map((d) => d.id)).size).toBe(160);
    expect(await readJsonl(path.join(root, "data/document_versions.jsonl"))).toHaveLength(120);
  });

  it("stops quickly on Ctrl-C during downloads, leaves .part files, never records the abort as an error, and resumes cleanly", async () => {
    const root = await dir();
    const controller = new AbortController();
    const fake = await fakeClio({
      downloadDelayMs: 200,
      onRequest: (record, stats) => {
        if (record.path.includes("/download") && stats.requests.filter((r: any) => r.path.includes("/download")).length >= 3) controller.abort();
      },
    });
    const started = Date.now();
    const first = await runEngineAgainst(fake, makeArgs(root), { signal: controller.signal });
    expect(first.code).toBe(4);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await read(root, "errors.jsonl")).toBe("");
    expect(await read(root, "REPORT.md")).toContain("INTERRUPTED");

    const second = await runEngineAgainst(fake, makeArgs(root, { resume: true }));
    expect(second.code).toBe(0);
    const files = await listFiles(root);
    expect(files.filter((f) => f.endsWith(".part"))).toEqual([]);
    expect(files.filter((f) => f.startsWith("matters/") && !f.endsWith(".part")).length).toBe(18);
    expect(await read(root, "errors.jsonl")).toBe("");
  });

  it("refuses to resume when the options differ from the original run", async () => {
    const root = await dir();
    const fake = await fakeClio();
    await runEngineAgainst(fake, makeArgs(root, { only: ["matters"] }));
    const result = await runEngineAgainst(fake, makeArgs(root, { only: ["contacts"], resume: true }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("options differ");
  });
});

describe("export engine: matter index integrity", () => {
  it("exits 2 when the index file changed, and does not rebuild it", async () => {
    const root = await dir();
    const fake = await fakeClio();
    await runEngineAgainst(fake, makeArgs(root));
    const indexFile = path.join(root, "checkpoint/matter_index.jsonl");
    await fs.appendFile(indexFile, '{"id":1,"n":"x","c":"y"}\n');
    const before = await fs.readFile(indexFile, "utf8");
    const requestsBefore = fake.stats.requests.length;

    const result = await runEngineAgainst(fake, makeArgs(root, { resume: true }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("index changed or missing, rerun without --resume");
    expect(fake.stats.requests.length).toBe(requestsBefore);
    expect(await fs.readFile(indexFile, "utf8")).toBe(before);
  });

  it("exits 2 when the index file is missing, and 2 for the folder index as well", async () => {
    const root = await dir();
    const fake = await fakeClio();
    await runEngineAgainst(fake, makeArgs(root));
    await fs.rm(path.join(root, "checkpoint/folder_index.jsonl"));
    const result = await runEngineAgainst(fake, makeArgs(root, { resume: true }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("index changed or missing");
  });

  it("records the index state in the manifest", async () => {
    const root = await dir();
    const fake = await fakeClio();
    await runEngineAgainst(fake, makeArgs(root));
    const manifest = JSON.parse(await read(root, "manifest.json"));
    expect(manifest.indexes.matter_index).toMatchObject({ status: "complete", count: 6 });
    expect(manifest.indexes.matter_index.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.indexes.folder_index).toMatchObject({ status: "complete", count: 13 });
    expect(await read(root, "REPORT.md")).toContain("Matter index built");
  });

  it("resumes an index that was still being built from its own checkpoint", async () => {
    const root = await dir();
    const { controller, onRequest } = abortWhen((r) => r.path.endsWith("/matters.json") && r.query.includes("page_token") && !r.query.includes("billable"));
    const fake = await fakeClio({ matterCount: 450, lightDocs: true, onRequest });
    const only = ["documents"];
    expect((await runEngineAgainst(fake, makeArgs(root, { only }), { signal: controller.signal })).code).toBe(4);
    const building = JSON.parse(await read(root, "manifest.json"));
    expect(building.indexes.matter_index.status).toBe("building");
    expect((await runEngineAgainst(fake, makeArgs(root, { only, resume: true }))).code).toBe(0);
    const done = JSON.parse(await read(root, "manifest.json"));
    expect(done.indexes.matter_index).toMatchObject({ status: "complete", count: 450 });
  }, 60_000);
});

describe("export engine: errors, retries and login expiry", () => {
  it("retries server errors and succeeds without recording an error", async () => {
    const root = await dir();
    const fake = await fakeClio({ failures: [{ match: "/contacts.json", status: 503, times: 2 }] });
    const result = await runEngineAgainst(fake, makeArgs(root));
    expect(result.code, result.stderr).toBe(0);
    expect(fake.stats.requests.filter((r) => r.path.endsWith("/contacts.json")).length).toBe(3);
    expect(await read(root, "errors.jsonl")).toBe("");
  });

  it("honours Retry-After on 429 and pauses before retrying", async () => {
    const root = await dir();
    const fake = await fakeClio({ failures: [{ match: "/users.json", status: 429, times: 1, headers: { "Retry-After": "0" } }] });
    expect((await runEngineAgainst(fake, makeArgs(root))).code).toBe(0);
    expect(fake.stats.requests.filter((r) => r.path.endsWith("/users.json")).length).toBe(2);
  });

  it("gives up after 6 attempts, records the failure with status and kind only, and moves on", async () => {
    const root = await dir();
    const fake = await fakeClio({ failures: [{ match: "/contacts.json", status: 503, times: 100 }] });
    const result = await runEngineAgainst(fake, makeArgs(root));
    expect(result.code).toBe(1);
    expect(fake.stats.requests.filter((r) => r.path.endsWith("/contacts.json")).length).toBe(6);
    const errors = await readJsonl(path.join(root, "errors.jsonl"));
    expect(errors).toEqual([{ type: "contacts", status: 503, kind: "server", attempts: 6 }]);
    expect(await readJsonl(path.join(root, "data/tasks.jsonl"))).toHaveLength(6);
    const report = await read(root, "REPORT.md");
    expect(report).toContain("| contacts | 503 | server | 1 |");
  });

  it("retries a failed download and records a download that fails 6 times with its id", async () => {
    const root = await dir();
    const fake = await fakeClio({ failures: [{ match: "uuid-5000-1", storage: true, status: 503, times: 100 }, { match: "uuid-5004-1", storage: true, status: 503, times: 2 }] });
    const result = await runEngineAgainst(fake, makeArgs(root));
    expect(result.code).toBe(1);
    const errors = await readJsonl(path.join(root, "errors.jsonl"));
    expect(errors).toEqual([{ type: "documents", status: 503, kind: "storage", attempts: 6, id: 5000 }]);
    await expect(fs.stat(path.join(root, "matters/2025-0002 - Client 2/Engagement letter [5004].pdf"))).resolves.toBeTruthy();
    expect((await listFiles(root)).filter((f) => f.endsWith(".part"))).toEqual([]);
    const docs = await readJsonl(path.join(root, "data/documents.jsonl"));
    expect(docs.find((d) => d.id === 5000).export.status).toBe("failed");
  });

  it("saves its place, exits 3 when the login expires, and resumes after a new login", async () => {
    const root = await dir();
    const fake = await fakeClio({ failures: [{ match: "/contacts.json", status: 401, times: 1 }] });
    const first = await runEngineAgainst(fake, makeArgs(root));
    expect(first.code).toBe(3);
    expect(first.stderr).toContain("Run auth, then rerun with --resume");
    expect(await read(root, "REPORT.md")).toContain("INTERRUPTED");
    expect(await read(root, "errors.jsonl")).toBe("");
    const usersBefore = await read(root, "data/users.jsonl");

    const second = await runEngineAgainst(fake, makeArgs(root, { resume: true }));
    expect(second.code).toBe(0);
    expect(await read(root, "data/users.jsonl")).toBe(usersBefore);
    expect(await readJsonl(path.join(root, "data/contacts.jsonl"))).toHaveLength(4);
  });

  it("exits 3 when the token cannot be obtained at all", async () => {
    const root = await dir();
    const fake = await fakeClio();
    const result = await runEngineAgainst(fake, makeArgs(root), { getAccessToken: async () => { throw new Error("refresh failed"); } });
    expect(result.code).toBe(3);
  });

  it("refuses to resume an export that belongs to another account or region", async () => {
    const root = await dir();
    const fake = await fakeClio();
    await runEngineAgainst(fake, makeArgs(root, { only: ["matters"] }));
    const manifestFile = path.join(root, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    manifest.clio_user_id = "someone-else";
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    const result = await runEngineAgainst(fake, makeArgs(root, { only: ["matters"], resume: true }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("different Clio account or region");
  });
});

describe("export engine: refresh runs keep the document ledgers", () => {
  it("skips unchanged files, re-downloads only a changed version, and rewrites the data files", async () => {
    const root = await dir();
    const fake = await fakeClio();
    await runEngineAgainst(fake, makeArgs(root));
    expect(fake.stats.storage).toHaveLength(18);

    const second = await runEngineAgainst(fake, makeArgs(root));
    expect(second.code).toBe(0);
    expect(fake.stats.storage).toHaveLength(18);
    const docs = await readJsonl(path.join(root, "data/documents.jsonl"));
    expect(docs).toHaveLength(24);
    expect(docs.filter((d) => d.export.status === "unchanged")).toHaveLength(18);

    const doc = fake.state.documents.find((d: any) => d.id === 5002);
    const body = "x".repeat(doc.latest_document_version.size);
    fake.state.contents.set("uuid-5002-2", body);
    doc.latest_document_version.uuid = "uuid-5002-2";
    const third = await runEngineAgainst(fake, makeArgs(root));
    expect(third.code).toBe(0);
    expect(fake.stats.storage).toHaveLength(19);
    expect(await read(root, "matters/2025-0001 - Client 1/Pleadings/Motion_ draft_ [5002].docx")).toBe(body);
  });

  it("moves files when a client is renamed instead of downloading them again", async () => {
    const root = await dir();
    const fake = await fakeClio();
    await runEngineAgainst(fake, makeArgs(root));
    fake.state.matters[0].client.name = "Renamed Client";

    const result = await runEngineAgainst(fake, makeArgs(root));
    expect(result.code).toBe(0);
    expect(fake.stats.storage).toHaveLength(18);
    const files = await listFiles(root);
    expect(files).toContain("matters/2025-0001 - Renamed Client/Engagement letter [5000].pdf");
    expect(files.filter((f) => f.startsWith("matters/2025-0001 - Client 1/"))).toEqual([]);
    const report = await read(root, "REPORT.md");
    expect(report).toContain("Moved after a rename: 3");
  });

  it("counts files deleted in Clio as orphans and keeps them on disk", async () => {
    const root = await dir();
    const fake = await fakeClio();
    await runEngineAgainst(fake, makeArgs(root));
    fake.state.documents = fake.state.documents.filter((d: any) => d.id !== 5000);

    const result = await runEngineAgainst(fake, makeArgs(root));
    expect(result.code).toBe(0);
    expect(await read(root, "REPORT.md")).toContain("Orphans (kept on disk, no longer in Clio): 1");
    await expect(fs.stat(path.join(root, "matters/2025-0001 - Client 1/Engagement letter [5000].pdf"))).resolves.toBeTruthy();
  });

  it("does not evaluate orphans under a --since filter", async () => {
    const root = await dir();
    const fake = await fakeClio();
    await runEngineAgainst(fake, makeArgs(root));
    fake.state.documents = fake.state.documents.filter((d: any) => d.id !== 5000);
    const since = { input: "2020-01-01", iso: "2019-12-31T00:00:00.000Z", kind: "date" as const };
    await runEngineAgainst(fake, makeArgs(root, { since }));
    expect(await read(root, "REPORT.md")).toContain("Orphans (kept on disk, no longer in Clio): 0");
    expect(await read(root, "REPORT.md")).toContain("Orphan detection was not evaluated");
  });
});
