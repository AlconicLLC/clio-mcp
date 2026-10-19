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

import { startFakeClio, makeArgs, makeTempDir, runEngineAgainst, readJsonl, readLines, listFiles } from "./helpers.js";
import type { FakeClio } from "./helpers.js";

let fake: FakeClio;
let out: string;

beforeEach(async () => {
  out = await makeTempDir();
  auditMock.mockClear();
});

afterEach(async () => {
  await fake?.stop();
  delete process.env.CLIO_API_BASE;
  await fs.rm(out, { recursive: true, force: true });
});

const read = (rel: string) => fs.readFile(path.join(out, rel), "utf8");

describe("export engine: full run", () => {
  it("exports every record type and mirrors the folder tree with safe file names", async () => {
    fake = await startFakeClio();
    const result = await runEngineAgainst(fake, makeArgs(out));
    expect(result.code).toBe(0);

    expect(await readJsonl(path.join(out, "data/matters.jsonl"))).toHaveLength(6);
    expect(await readJsonl(path.join(out, "data/contacts.jsonl"))).toHaveLength(4);
    expect(await readJsonl(path.join(out, "data/notes.jsonl"))).toHaveLength(7);
    expect(await readJsonl(path.join(out, "data/calendar_entries.jsonl"))).toHaveLength(2);
    expect(await readJsonl(path.join(out, "data/documents.jsonl"))).toHaveLength(24);
    expect(await readJsonl(path.join(out, "data/folders.jsonl"))).toHaveLength(13);

    const dir = "matters/2025-0001 - Client 1";
    expect(await read(`${dir}/Engagement letter [5000].pdf`)).toBe(fake.state.contents.get("uuid-5000-1"));
    expect(await read(`${dir}/Pleadings/_CON [5001].txt`)).toBe(fake.state.contents.get("uuid-5001-1"));
    expect(await read(`${dir}/Pleadings/Motion_ draft_ [5002].docx`)).toBe(fake.state.contents.get("uuid-5002-1"));

    const files = await listFiles(out);
    expect(files.filter((f) => f.endsWith(".part"))).toEqual([]);
    expect(files).toContain("manifest.json");
    expect(files).toContain("REPORT.md");
    expect(files).toContain("errors.jsonl");

    const report = await read("REPORT.md");
    expect(report).toContain("Result: **COMPLETE**");
    expect(report).toContain("none (verified by count)");
    expect(report).toContain("ledger_reports");
    expect(await read("errors.jsonl")).toBe("");
  });

  it("writes CSV that opens cleanly in Excel and guards formulas in text only", async () => {
    fake = await startFakeClio();
    await runEngineAgainst(fake, makeArgs(out));
    const notes = await read("data/notes.csv");
    expect(notes.startsWith("﻿")).toBe(true);
    expect(notes).toContain("\r\n");
    expect(notes).toContain("'=SUM(1+1)");
    const expenses = await read("data/expenses.csv");
    expect(expenses).toContain(",-25.5,-25.5,");
    expect(expenses).not.toContain("'-25.5");
  });

  it("never writes to Clio and never sends the login to the storage host", async () => {
    fake = await startFakeClio();
    await runEngineAgainst(fake, makeArgs(out));
    expect(fake.stats.nonGet).toBe(0);
    expect(fake.stats.requests.length).toBeGreaterThan(50);
    expect(fake.stats.requests.every((r) => r.method === "GET" && r.hasAuthorization)).toBe(true);
    expect(fake.stats.storage.length).toBe(18);
    expect(fake.stats.storage.every((s) => !s.hasAuthorization)).toBe(true);
  });

  it("records one audit entry per type and phase with counts only", async () => {
    fake = await startFakeClio();
    await runEngineAgainst(fake, makeArgs(out));
    const entries = auditMock.mock.calls.map((c) => c[0] as any);
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.every((e) => e.tool === "export")).toBe(true);
    const allowed = new Set(["type", "phase", "pages", "files", "bytes", "since", "dry_run"]);
    for (const e of entries) {
      for (const key of Object.keys(e.args)) expect(allowed.has(key)).toBe(true);
    }
    const keys = entries.map((e) => `${e.args.type}:${e.args.phase}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("documents:download");
    const text = JSON.stringify(entries);
    for (const secret of ["Client 1", "Engagement", "Synthetic matter", "2025-0001", "Contact 1", "example.invalid"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("keeps names, titles and paths out of the progress and error output", async () => {
    fake = await startFakeClio({ failures: [{ match: "/contacts.json", status: 400, times: 1 }] });
    const result = await runEngineAgainst(fake, makeArgs(out));
    for (const secret of ["Client 1", "Engagement", "Synthetic matter", "Pleadings", "Contact 1"]) {
      expect(result.stderr).not.toContain(secret);
    }
    const errors = await read("errors.jsonl");
    for (const secret of ["injected", "Client", "Contact"]) expect(errors).not.toContain(secret);
  });

  it("limits parallel downloads to --concurrency", async () => {
    fake = await startFakeClio({ downloadDelayMs: 25 });
    await runEngineAgainst(fake, makeArgs(out, { concurrency: 2 }));
    expect(fake.stats.maxConcurrentDownloads).toBeLessThanOrEqual(2);
    expect(fake.stats.maxConcurrentDownloads).toBeGreaterThan(0);
  });

  it("exports document version history only when asked", async () => {
    fake = await startFakeClio();
    await runEngineAgainst(fake, makeArgs(out, { only: ["matters", "folders", "documents", "document_versions"] }));
    expect((await readJsonl(path.join(out, "data/document_versions.jsonl"))).length).toBe(18);
    const other = await makeTempDir();
    try {
      await runEngineAgainst(fake, makeArgs(other, { only: ["matters", "folders", "documents"] }));
      await expect(fs.stat(path.join(other, "data/document_versions.jsonl"))).rejects.toThrow();
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("builds the matter index without writing matters when only documents are named", async () => {
    fake = await startFakeClio();
    const result = await runEngineAgainst(fake, makeArgs(out, { only: ["documents"] }));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Building the matter index");
    const files = await listFiles(out);
    expect(files).not.toContain("data/matters.jsonl");
    expect(files).not.toContain("data/folders.jsonl");
    expect(files).toContain("data/documents.jsonl");
    expect(files).toContain("checkpoint/matter_index.jsonl");
  });
});

describe("export engine: completeness verdict", () => {
  it("reports a refused required type as NOT AVAILABLE and the run as INCOMPLETE", async () => {
    fake = await startFakeClio({ forbidden: ["/custom_fields.json"] });
    const result = await runEngineAgainst(fake, makeArgs(out));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("custom_fields: NOT AVAILABLE");
    const report = await read("REPORT.md");
    expect(report).toContain("Result: **INCOMPLETE**");
    expect(report).toMatch(/\| custom_fields \| NOT AVAILABLE/);
    expect(await readJsonl(path.join(out, "data/matters.jsonl"))).toHaveLength(6);
  });

  it("treats a missing record count as NOT VERIFIED and never says COMPLETE", async () => {
    fake = await startFakeClio({ omitRecords: true });
    const result = await runEngineAgainst(fake, makeArgs(out));
    expect(result.code).toBe(1);
    const report = await read("REPORT.md");
    expect(report).toContain("NOT VERIFIED");
    expect(report).not.toContain("Result: **COMPLETE**");
    expect(result.stderr).toContain("NOT VERIFIED");
  });

  it("reports documents outside any matter as NOT ENUMERATED and the run as INCOMPLETE", async () => {
    fake = await startFakeClio({ unfiledDocs: 2 });
    const result = await runEngineAgainst(fake, makeArgs(out));
    expect(result.code).toBe(1);
    const report = await read("REPORT.md");
    expect(report).toContain("2 NOT ENUMERATED");
    expect(report).toContain("Result: **INCOMPLETE**");
    expect(result.stderr).toContain("documents: INCOMPLETE");
  });

  it("reports contact notes that Clio refuses as NOT ENUMERATED", async () => {
    fake = await startFakeClio({ failures: [{ match: /notes\.json\?.*type=contact/, status: 403, times: 5 }] });
    const result = await runEngineAgainst(fake, makeArgs(out));
    expect(result.code).toBe(1);
    expect(await read("REPORT.md")).toContain("contact notes: NOT ENUMERATED");
  });

  it("falls back when Clio rejects part of the field selection and says so", async () => {
    fake = await startFakeClio({ rejectFields: ["custom_field_values"] });
    const result = await runEngineAgainst(fake, makeArgs(out));
    expect(result.code).toBe(0);
    expect(await read("REPORT.md")).toContain("some optional fields were not accepted by Clio");
    expect(await readJsonl(path.join(out, "data/matters.jsonl"))).toHaveLength(6);
  });

  it("flags custom field values that come back without names as unreadable", async () => {
    fake = await startFakeClio();
    fake.state.matters[0].custom_field_values = [{ id: "text-1", field_name: null, field_type: null, value: null }];
    const result = await runEngineAgainst(fake, makeArgs(out));
    expect(result.code).toBe(1);
    expect(await read("REPORT.md")).toContain("custom field values unreadable in 1 rows");
    expect(result.stderr).toContain("matters: INCOMPLETE - custom field values unreadable in 1 rows");
  });

  it("prints every INCOMPLETE and NOT VERIFIED reason in the terminal exactly as REPORT.md states it", async () => {
    fake = await startFakeClio({ omitRecords: true, unfiledDocs: 1, forbidden: ["/custom_fields.json"] });
    const result = await runEngineAgainst(fake, makeArgs(out));
    const report = await read("REPORT.md");
    const lines = result.stderr.split("\n").filter((l) => l.startsWith("  - ")).map((l) => l.slice(4));
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(report, line).toContain(line);
    expect(lines).toContain("users: NOT VERIFIED - Clio gave no record count to compare with");
    expect(lines).toContain("custom_fields: NOT AVAILABLE - Clio refused access (HTTP 403)");
    const secrets = ["Client 1", "Engagement", "Synthetic matter", "Contact 1", "Pleadings", "example.invalid"];
    for (const secret of secrets) expect(result.stderr).not.toContain(secret);
  });

  it("names the reason for each incomplete type, counts and codes only", async () => {
    fake = await startFakeClio({ failures: [{ match: /notes\.json\?.*type=contact/, status: 403, times: 5 }] });
    fake.state.matters[0].custom_field_values = [{ id: "x", field_name: null }];
    const result = await runEngineAgainst(fake, makeArgs(out));
    expect(result.stderr).toContain("notes: INCOMPLETE - contact notes: NOT ENUMERATED (HTTP 403)");
    expect(result.stderr).toContain("matters: INCOMPLETE - custom field values unreadable in 1 rows");
  });
});

describe("export engine: --since", () => {
  it("filters types that support it, walks every matter for documents, and states the coverage", async () => {
    fake = await startFakeClio();
    const result = await runEngineAgainst(
      fake,
      makeArgs(out, { since: { input: "2026-02-28", iso: "2026-02-27T00:00:00.000Z", kind: "date" } })
    );
    expect(result.code).toBe(0);
    expect(await readJsonl(path.join(out, "data/matters.jsonl"))).toHaveLength(3);
    expect(await readJsonl(path.join(out, "data/documents.jsonl"))).toHaveLength(12);
    expect(await readJsonl(path.join(out, "data/folders.jsonl"))).toHaveLength(13);
    const index = await readLines(path.join(out, "checkpoint/matter_index.jsonl"));
    expect(index).toHaveLength(6);
    const matterListings = fake.stats.requests.filter((r) => r.path.endsWith("/documents.json") && r.query.includes("matter_id="));
    expect(matterListings.length).toBe(6);
    const report = await read("REPORT.md");
    expect(report).toContain("2026-02-27T00:00:00.000Z");
    expect(report).toContain("not only matters changed since the date");
    expect(report).toContain("since filter not applied, exported in full");
    expect(report).toContain("## Since filter");
    expect(report).toContain("Orphan detection was not evaluated with a since filter");
  });

  it("prints no Since filter section in either report when --since is not given", async () => {
    fake = await startFakeClio();
    const real = await runEngineAgainst(fake, makeArgs(out));
    expect(real.code).toBe(0);
    const realReport = await read("REPORT.md");
    expect(realReport).toContain("Records changed since: all records");
    expect(realReport).not.toContain("## Since filter");

    const dry = await makeTempDir();
    try {
      await runEngineAgainst(fake, makeArgs(dry, { dryRun: true }));
      const dryReport = await fs.readFile(path.join(dry, "REPORT.md"), "utf8");
      expect(dryReport).toContain("Records changed since: all records");
      expect(dryReport).not.toContain("## Since filter");
    } finally {
      await fs.rm(dry, { recursive: true, force: true });
    }
  });
});

describe("export engine: progress", () => {
  it("shows the phase, a matter counter and a remaining-time estimate, and never 'records 0'", async () => {
    fake = await startFakeClio({ lightDocs: true, matterCount: 40 });
    const only = ["documents"];
    const result = await runEngineAgainst(fake, makeArgs(out, { only, rate: 60 }), { progressIntervalMs: 20 });
    expect(result.code).toBe(0);
    const lines = result.stderr.split("\n").filter((l) => l.startsWith("[export]"));
    const documentLines = lines.filter((l) => l.startsWith("[export] documents: matter"));
    expect(documentLines.length).toBeGreaterThan(2);
    expect(documentLines.some((l) => /matter \d+ of 40/.test(l))).toBe(true);
    for (const line of lines) {
      expect(line).not.toMatch(/(^|[^\d.])0 records|records 0\b/);
      expect(line).not.toContain("Client");
    }
    expect(documentLines.some((l) => /remaining ~/.test(l))).toBe(true);
  });

  it("counting phases show a matter counter and never a speed", async () => {
    fake = await startFakeClio({ matterCount: 60, lightDocs: true });
    const result = await runEngineAgainst(fake, makeArgs(out, { only: ["documents"], dryRun: true, rate: 100 }), { progressIntervalMs: 10 });
    expect(result.code).toBe(0);
    const lines = result.stderr.split("\n").filter((l) => l.startsWith("[export] counting"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain("records/s");
    expect(lines.some((l) => /counting documents: matter \d+ of 60/.test(l))).toBe(true);
  });
});

describe("export engine: dry run", () => {
  it("counts and writes only REPORT.md, with an estimate and the audit entries marked as dry runs", async () => {
    fake = await startFakeClio();
    const result = await runEngineAgainst(fake, makeArgs(out, { dryRun: true }));
    expect(result.code).toBe(0);
    expect(await listFiles(out)).toEqual(["REPORT.md"]);
    const report = await read("REPORT.md");
    expect(report).toContain("dry run");
    expect(report).toContain("Estimate for the full run");
    expect(report).toContain("Document bytes");
    expect(report).toContain("none (verified by count)");
    expect(report).toMatch(/Would download: 18 files, [\d.]+ [KMG]?B \(\d+ bytes\)/);
    expect(report).not.toContain("Downloaded this run");
    expect(report).not.toContain("Already on disk and unchanged");
    expect(report).toContain("n/a in a dry run");
    expect(fake.stats.storage).toHaveLength(0);
    const entries = auditMock.mock.calls.map((c) => c[0] as any);
    expect(entries.length).toBeGreaterThan(5);
    expect(entries.every((e) => e.args.dry_run === true && e.args.phase === "count")).toBe(true);
  });

  it("includes the since-filter coverage in the dry-run report", async () => {
    fake = await startFakeClio();
    const since = { input: "2026-02-28", iso: "2026-02-27T00:00:00.000Z", kind: "date" as const };
    await runEngineAgainst(fake, makeArgs(out, { dryRun: true, since }));
    const report = await read("REPORT.md");
    expect(report).toContain("## Since filter");
    expect(report).toContain("2026-02-27T00:00:00.000Z");
    expect(report).toContain("not only matters changed since the date");
    expect(report).toContain("since filter not applied, exported in full");
    expect(report).toMatch(/exported for: .*matters.*documents/);
    expect(report).not.toContain("Orphan detection");
  });

  it("uses the same --since instant as a real run", async () => {
    fake = await startFakeClio();
    const since = { input: "2026-02-28", iso: "2026-02-27T00:00:00.000Z", kind: "date" as const };
    await runEngineAgainst(fake, makeArgs(out, { dryRun: true, since }));
    const sinceValues = new Set(fake.stats.requests.map((r) => new URLSearchParams(r.query).get("updated_since")).filter(Boolean));
    expect([...sinceValues]).toEqual(["2026-02-27T00:00:00.000Z"]);
    expect(auditMock.mock.calls.every((c) => (c[0] as any).args.since === since.iso)).toBe(true);
  });

  it("matches the real run's counts when the source is stable", async () => {
    fake = await startFakeClio();
    await runEngineAgainst(fake, makeArgs(out, { dryRun: true }));
    const dryReport = await read("REPORT.md");
    const real = await makeTempDir();
    try {
      await runEngineAgainst(fake, makeArgs(real));
      const realReport = await fs.readFile(path.join(real, "REPORT.md"), "utf8");
      const rowOf = (report: string, name: string) => new RegExp(`\\| ${name} \\| [A-Z ]+ \\| (\\S+) \\| (\\S+) \\|`).exec(report);
      for (const name of ["matters", "contacts", "notes", "tasks"]) {
        expect(rowOf(dryReport, name)?.[2], name).toBe(rowOf(realReport, name)?.[2]);
      }
      expect(rowOf(dryReport, "documents")?.[2]).toBe(rowOf(realReport, "documents")?.[2]);
    } finally {
      await fs.rm(real, { recursive: true, force: true });
    }
  });
});
