import fs from "fs/promises";
import { createReadStream } from "fs";
import readline from "readline";
import path from "path";
import { ClioApiError, ClioRequestFailure, ClioAbortedError, ClioAuthExpiredError } from "../utils/clioClient.js";
import { PathTooLongError } from "./fsnames.js";
import { ensureDir } from "./fsutil.js";

export class DownloadFailure extends Error {
  constructor(
    public readonly status: number | null,
    public readonly kind: string,
    public readonly attempts: number,
    public readonly retryable = false
  ) {
    super(`Download failed (${kind}${status ? ` ${status}` : ""}) after ${attempts} attempt(s)`);
    this.name = "DownloadFailure";
  }
}

export interface FailureInfo {
  status: number | null;
  kind: string;
  attempts: number;
}

export function isAbort(err: unknown): boolean {
  return err instanceof ClioAbortedError || (err instanceof Error && err.name === "AbortError");
}

export function isAuthExpired(err: unknown): boolean {
  return err instanceof ClioAuthExpiredError;
}

/** Reduces any failure to a status code and a kind. Messages are never kept: they can carry URLs or names. */
export function describeFailure(err: unknown): FailureInfo {
  if (err instanceof ClioApiError) return { status: err.statusCode, kind: "client", attempts: 1 };
  if (err instanceof ClioRequestFailure) return { status: err.status, kind: err.kind, attempts: err.attempts };
  if (err instanceof DownloadFailure) return { status: err.status, kind: err.kind, attempts: err.attempts };
  if (err instanceof PathTooLongError) return { status: null, kind: "path_too_long", attempts: 1 };
  const code = (err as NodeJS.ErrnoException)?.code;
  return { status: null, kind: typeof code === "string" ? `fs_${code.toLowerCase()}` : "unexpected", attempts: 1 };
}

export interface ErrorRecord extends FailureInfo {
  type: string;
  id?: number;
}

export class ErrorLog {
  private count = 0;

  constructor(private readonly file: string) {}

  static async create(file: string, truncate: boolean): Promise<ErrorLog> {
    await ensureDir(path.dirname(file));
    if (truncate) await fs.writeFile(file, "");
    const log = new ErrorLog(file);
    log.count = await countLines(file);
    return log;
  }

  get total(): number {
    return this.count;
  }

  async record(entry: ErrorRecord): Promise<void> {
    const line: Record<string, unknown> = { type: entry.type, status: entry.status, kind: entry.kind, attempts: entry.attempts };
    if (entry.id !== undefined) line.id = entry.id;
    await fs.appendFile(this.file, `${JSON.stringify(line)}\n`);
    this.count++;
  }
}

async function countLines(file: string): Promise<number> {
  let count = 0;
  try {
    for await (const line of readline.createInterface({ input: createReadStream(file) })) {
      if (line.trim() !== "") count++;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return count;
}

export interface ErrorGroup {
  type: string;
  status: number | null;
  kind: string;
  count: number;
}

export async function groupErrors(file: string): Promise<ErrorGroup[]> {
  const groups = new Map<string, ErrorGroup>();
  try {
    for await (const line of readline.createInterface({ input: createReadStream(file) })) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line) as ErrorRecord;
      const key = `${entry.type}|${entry.status}|${entry.kind}`;
      const group = groups.get(key) ?? { type: entry.type, status: entry.status, kind: entry.kind, count: 0 };
      group.count++;
      groups.set(key, group);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return [...groups.values()].sort((a, b) => a.type.localeCompare(b.type) || b.count - a.count);
}
