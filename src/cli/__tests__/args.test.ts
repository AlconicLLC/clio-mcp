import { describe, it, expect } from "vitest";
import path from "path";
import { parseSince, parseExportArgs, DEFAULT_RATE, DEFAULT_CONCURRENCY } from "../args.js";

describe("parseSince", () => {
  it.each([
    ["2026-03-10", "2026-03-09T00:00:00.000Z", "date"],
    ["2026-01-01", "2025-12-31T00:00:00.000Z", "date"],
    ["2026-03-01", "2026-02-28T00:00:00.000Z", "date"],
    ["2024-03-01", "2024-02-29T00:00:00.000Z", "date"],
    ["2026-03-10T09:00:00+02:00", "2026-03-10T07:00:00.000Z", "datetime"],
    ["2026-03-10T09:00Z", "2026-03-10T09:00:00.000Z", "datetime"],
    ["2026-03-10T09:00:00.5-05:00", "2026-03-10T14:00:00.500Z", "datetime"],
    ["2026-03-10T00:30:00+01:00", "2026-03-09T23:30:00.000Z", "datetime"],
  ])("reads %s as %s", (input, iso, kind) => {
    const result = parseSince(input);
    expect(result).toEqual({ ok: true, since: { input, iso, kind } });
  });

  it.each([
    "",
    "yesterday",
    "10/03/2026",
    "2026-02-30",
    "2026-13-01",
    "2026-00-10",
    "1899-12-31",
    "2026-03-10T09:00:00",
    "2026-03-10 09:00",
    "2026-03-10T24:00:00Z",
    "2026-03-10T09:60:00Z",
    "2026-03-10T09:00:60Z",
    "2026-03-10T09:00:00+24:00",
    "2026-03-10T09:00:00+02:60",
    "2026-03-10T09:00:00+0200",
  ])("rejects %j", (input) => {
    expect(parseSince(input).ok).toBe(false);
  });

  it("gives the same instant every time for the same input", () => {
    expect(parseSince("2026-03-10")).toEqual(parseSince("2026-03-10"));
  });
});

describe("parseExportArgs", () => {
  const ok = (argv: string[]) => {
    const result = parseExportArgs(argv);
    if (!result.ok || result.help) throw new Error("expected parsed args");
    return result.args;
  };

  it("applies the documented defaults", () => {
    const args = ok(["--out", "export-folder"]);
    expect(args).toEqual({
      out: path.resolve("export-folder"),
      since: null,
      only: null,
      notExported: [],
      documents: true,
      rate: DEFAULT_RATE,
      concurrency: DEFAULT_CONCURRENCY,
      resume: false,
      dryRun: false,
    });
    expect(DEFAULT_RATE).toBe(0.8);
    expect(DEFAULT_CONCURRENCY).toBe(3);
  });

  it("accepts every flag, in both --flag value and --flag=value forms", () => {
    const args = ok([
      "--out=x",
      "--since", "2026-03-10",
      "--only", "Matters, folders,documents,matters",
      "--rate=0.5",
      "--concurrency", "8",
      "--dry-run",
    ]);
    expect(args.only).toEqual(["matters", "folders", "documents"]);
    expect(args.since?.iso).toBe("2026-03-09T00:00:00.000Z");
    expect(args.rate).toBe(0.5);
    expect(args.concurrency).toBe(8);
    expect(args.dryRun).toBe(true);
  });

  it("uses the same --since interpretation for dry run and real run", () => {
    const dry = ok(["--out", "x", "--since", "2026-03-10", "--dry-run"]);
    const real = ok(["--out", "x", "--since", "2026-03-10"]);
    expect(dry.since).toEqual(real.since);
  });

  it("returns help for --help and -h even next to bad input", () => {
    expect(parseExportArgs(["--help"])).toEqual({ ok: true, help: true });
    expect(parseExportArgs(["-h", "--bogus"])).toEqual({ ok: true, help: true });
    expect(parseExportArgs([])).toMatchObject({ ok: false });
  });

  it.each([
    [[]],
    [["--out"]],
    [["--out", "--resume"]],
    [["--out", " "]],
    [["--out", "x", "--bogus"]],
    [["--out", "x", "-z"]],
    [["--out", "x", "extra"]],
    [["--out", "x", "--out", "y"]],
    [["--out", "x", "--resume=yes"]],
    [["--out", "x", "--resume", "--resume"]],
    [["--out", "x", "--since", "soon"]],
    [["--out", "x", "--only", ""]],
    [["--out", "x", "--only", "matters,nonsense"]],
    [["--out", "x", "--rate", "0"]],
    [["--out", "x", "--rate", "abc"]],
    [["--out", "x", "--rate", "-1"]],
    [["--out", "x", "--rate", "11"]],
    [["--out", "x", "--concurrency", "0"]],
    [["--out", "x", "--concurrency", "9"]],
    [["--out", "x", "--concurrency", "2.5"]],
    [["--out", "x", "--resume", "--dry-run"]],
    [["--out", "x", "--no-documents", "--only", "documents"]],
    [["--out", "x", "--no-documents", "--only", "document_versions"]],
  ])("rejects %j", (argv) => {
    const result = parseExportArgs(argv as string[]);
    expect(result.ok).toBe(false);
  });

  it("allows --no-documents with other types", () => {
    const args = ok(["--out", "x", "--no-documents", "--only", "matters"]);
    expect(args.documents).toBe(false);
    expect(args.only).toEqual(["matters"]);
  });

  it("accepts ledger_reports next to real types and records it as not exported", () => {
    const args = ok(["--out", "x", "--only", "matters,ledger_reports"]);
    expect(args.only).toEqual(["matters"]);
    expect(args.notExported).toEqual(["ledger_reports"]);
  });

  it("refuses ledger_reports on its own with a clear message", () => {
    const result = parseExportArgs(["--out", "x", "--only", "ledger_reports"]);
    expect(result).toEqual({
      ok: false,
      message: "ledger_reports is not exported in this version, so there is nothing to export.",
    });
  });
});
