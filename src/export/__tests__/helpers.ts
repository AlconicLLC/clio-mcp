import fs from "fs/promises";
import os from "os";
import path from "path";
import { startFakeClio } from "../../../scripts/fake-clio.mjs";
import type { FakeClio, FakeClioOptions } from "../../../scripts/fake-clio.mjs";
import type { ExportArgs } from "../../cli/args.js";
import { runWithSessionContext } from "../../utils/sessionContext.js";
import { runExportEngine } from "../engine.js";

export { startFakeClio };
export type { FakeClio, FakeClioOptions };

export const FIXED_NOW = new Date("2026-10-19T00:00:00Z");

export function makeArgs(out: string, overrides: Partial<ExportArgs> = {}): ExportArgs {
  return {
    out,
    since: null,
    only: null,
    notExported: [],
    documents: true,
    rate: 1000,
    concurrency: 3,
    resume: false,
    dryRun: false,
    ...overrides,
  };
}

export async function makeTempDir(prefix = "clio-export-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export interface EngineRun {
  code: number;
  stderr: string;
}

export async function runEngineAgainst(
  fake: FakeClio,
  args: ExportArgs,
  hooks: { signal?: AbortSignal; getAccessToken?: () => Promise<string>; retryBaseDelayMs?: number; progressIntervalMs?: number } = {}
): Promise<EngineRun> {
  process.env.CLIO_API_BASE = fake.apiBase;
  const lines: string[] = [];
  const code = await runWithSessionContext(
    {
      sessionId: "test",
      getAccessToken: hooks.getAccessToken ?? (async () => "test-token"),
      getTokens: async () => null,
      storeTokens: async () => {},
      clearTokens: async () => {},
    },
    () =>
      runExportEngine(
        { args, clioUserId: "1" },
        {
          handleSignals: false,
          signal: hooks.signal,
          retryBaseDelayMs: hooks.retryBaseDelayMs ?? 1,
          progressIntervalMs: hooks.progressIntervalMs,
          now: () => FIXED_NOW,
          stderr: (text) => void lines.push(text),
        }
      )
  );
  return { code, stderr: lines.join("") };
}

export async function readLines(file: string): Promise<string[]> {
  const text = await fs.readFile(file, "utf8");
  return text.split("\n").filter((l) => l !== "");
}

export async function readJsonl(file: string): Promise<any[]> {
  return (await readLines(file)).map((l) => JSON.parse(l));
}

export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return out.sort();
}
