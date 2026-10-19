import { ClioAbortedError } from "../utils/clioClient.js";
import type { ErrorLog } from "./errors.js";
import type { Manifest } from "./manifest.js";
import type { Progress } from "./progress.js";

export interface AuditInput {
  type: string;
  phase: "count" | "fetch" | "download";
  pages: number;
  files: number;
  bytes: number;
  rows: number;
  outcome: "success" | "error";
  errorText?: string;
}

export interface RunEnv {
  outDir: string;
  signal: AbortSignal;
  since: string | null;
  concurrency: number;
  clioUserId: string | null;
  errors: ErrorLog;
  progress: Progress;
  manifest: Manifest;
  now(): Date;
  saveManifest(): Promise<void>;
  audit(entry: AuditInput): Promise<void>;
  log(line: string): void;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ClioAbortedError();
}
