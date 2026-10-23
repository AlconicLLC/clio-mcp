import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { runExport } from "../export.js";
import type { ExportDeps, ExportRunContext } from "../export.js";
import { EXIT } from "../args.js";
import { MANIFEST_FILE, MANIFEST_TOOL } from "../outputFolder.js";

const TOKENS = { access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 };
const VALID_ENV = { CLIO_CLIENT_ID: "id", CLIO_CLIENT_SECRET: "secret" } as NodeJS.ProcessEnv;

let root: string;
let out: string[];
let err: string[];

function deps(overrides: Partial<ExportDeps> = {}): Partial<ExportDeps> {
  return {
    env: VALID_ENV,
    loadTokens: vi.fn(async () => TOKENS),
    runEngine: vi.fn(async () => EXIT.OK),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    ...overrides,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clio-export-cli-"));
  out = [];
  err = [];
  delete process.env.CLIO_REGION;
  delete process.env.CLIO_API_BASE;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("runExport", () => {
  it("prints usage and exits 2 when --out is missing", async () => {
    const d = deps();
    expect(await runExport([], d)).toBe(EXIT.USAGE);
    expect(err.join("")).toContain("Usage:");
    expect(d.runEngine).not.toHaveBeenCalled();
  });

  it("prints usage and exits 2 on an unknown flag", async () => {
    expect(await runExport(["--out", root, "--bogus"], deps())).toBe(EXIT.USAGE);
    expect(err.join("")).toContain("Unknown option: --bogus");
    expect(err.join("")).toContain("Usage:");
  });

  it("prints usage on stdout and exits 0 for --help", async () => {
    expect(await runExport(["--help"], deps())).toBe(EXIT.OK);
    expect(out.join("")).toContain("Usage:");
    expect(err).toEqual([]);
  });

  it("exits 2 when the client credentials are missing", async () => {
    expect(await runExport(["--out", root], deps({ env: {} }))).toBe(EXIT.USAGE);
    expect(err.join("")).toContain("CLIO_CLIENT_ID");
  });

  it("accepts broker mode without client credentials", async () => {
    const d = deps({ env: { TOKEN_BROKER_URL: "https://broker.example" } as NodeJS.ProcessEnv });
    expect(await runExport(["--out", root], d)).toBe(EXIT.OK);
  });

  it("exits 3 with 'run auth first' when there is no saved login, and never starts the engine", async () => {
    const d = deps({ loadTokens: vi.fn(async () => null) });
    expect(await runExport(["--out", root], d)).toBe(EXIT.NOT_LOGGED_IN);
    expect(err.join("")).toContain("run auth first");
    expect(d.runEngine).not.toHaveBeenCalled();
  });

  it("exits 5 when the saved login cannot be read", async () => {
    const d = deps({ loadTokens: vi.fn(async () => { throw new Error("keychain locked"); }) });
    expect(await runExport(["--out", root], d)).toBe(EXIT.FATAL);
  });

  it("exits 2 on an invalid CLIO_REGION", async () => {
    process.env.CLIO_REGION = "mars";
    expect(await runExport(["--out", root], deps())).toBe(EXIT.USAGE);
  });

  it("refuses a non-empty folder that is not a previous export", async () => {
    await fs.writeFile(path.join(root, "something.txt"), "x");
    const d = deps();
    expect(await runExport(["--out", root], d)).toBe(EXIT.USAGE);
    expect(d.runEngine).not.toHaveBeenCalled();
  });

  it("refuses --resume without a previous export", async () => {
    expect(await runExport(["--out", root, "--resume"], deps())).toBe(EXIT.USAGE);
  });

  it("hands the parsed arguments to the engine and returns its exit code", async () => {
    await fs.writeFile(path.join(root, MANIFEST_FILE), JSON.stringify({ tool: MANIFEST_TOOL }));
    const runEngine = vi.fn(async (_ctx: ExportRunContext) => EXIT.INTERRUPTED);
    const code = await runExport(["--out", root, "--resume", "--rate", "0.5", "--only", "matters"], deps({ runEngine }));
    expect(code).toBe(EXIT.INTERRUPTED);
    expect(runEngine).toHaveBeenCalledTimes(1);
    expect(runEngine.mock.calls[0][0].args).toMatchObject({ out: root, resume: true, rate: 0.5, only: ["matters"] });
  });

  it("passes the same --since instant to the engine for dry runs and real runs", async () => {
    const seen: (string | undefined)[] = [];
    const runEngine = vi.fn(async (ctx: { args: { since: { iso: string } | null } }) => {
      seen.push(ctx.args.since?.iso);
      return EXIT.OK;
    });
    await runExport(["--out", path.join(root, "a"), "--since", "2026-03-10", "--dry-run"], deps({ runEngine }));
    await runExport(["--out", path.join(root, "b"), "--since", "2026-03-10"], deps({ runEngine }));
    expect(seen).toEqual(["2026-03-09T00:00:00.000Z", "2026-03-09T00:00:00.000Z"]);
  });

  it("tells the user that ledger_reports is not exported when other types are selected", async () => {
    expect(await runExport(["--out", root, "--only", "matters,ledger_reports"], deps())).toBe(EXIT.OK);
    expect(err.join("")).toContain("ledger_reports: not exported in this version");
  });

  it("exits 2 when ledger_reports is the only type", async () => {
    const d = deps();
    expect(await runExport(["--out", root, "--only", "ledger_reports"], d)).toBe(EXIT.USAGE);
    expect(d.runEngine).not.toHaveBeenCalled();
  });
});
