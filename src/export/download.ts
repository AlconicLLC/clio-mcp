import fs from "fs/promises";
import { createWriteStream } from "fs";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import {
  clioRawGet,
  getClioBaseUrl,
  retryDelayMs,
  sleepAbortable,
  ClioApiError,
  ClioAbortedError,
  ClioRequestFailure,
} from "../utils/clioClient.js";
import { DownloadFailure, isAbort, isAuthExpired } from "./errors.js";
import { ensureDir, removeIfExists } from "./fsutil.js";

export interface DownloadOptions {
  documentId: number;
  versionUuid: string | null;
  destination: string;
  expectedSize: number | null;
  signal: AbortSignal;
  maxAttempts?: number;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
}

const MAX_HOPS = 5;

async function storageGet(url: URL, signal: AbortSignal, connectTimeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  try {
    return await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
  } catch (err) {
    if (signal.aborted) throw new ClioAbortedError();
    throw new DownloadFailure(null, "network", 1, true);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forward);
  }
}

function failFromStatus(status: number): DownloadFailure {
  if (status === 429 || status === 408 || status >= 500) return new DownloadFailure(status, "storage", 1, true);
  if (status === 403 || status === 404 || status === 410) return new DownloadFailure(status, "storage_expired", 1, true);
  return new DownloadFailure(status, "storage", 1, false);
}

async function openDownload(opts: DownloadOptions, connectTimeoutMs: number): Promise<Response> {
  const apiBase = getClioBaseUrl();
  const apiHost = new URL(apiBase).host;
  const apiPath = `/documents/${opts.documentId}/download${opts.versionUuid ? `?version_uuid=${encodeURIComponent(opts.versionUuid)}` : ""}`;

  let response: Response;
  try {
    response = await clioRawGet(apiPath, { redirect: "manual" });
  } catch (err) {
    if (err instanceof ClioApiError) throw new DownloadFailure(err.statusCode, "client", 1, false);
    if (err instanceof ClioRequestFailure) throw new DownloadFailure(err.status, err.kind, err.attempts, false);
    throw err;
  }

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (response.ok) return response;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new DownloadFailure(response.status, "redirect_without_location", 1, false);
      const target = new URL(location, `${apiBase}${apiPath}`);
      try {
        response =
          target.host === apiHost
            ? await clioRawGet(target.toString(), { redirect: "manual" })
            : await storageGet(target, opts.signal, connectTimeoutMs);
      } catch (err) {
        if (err instanceof ClioApiError) throw new DownloadFailure(err.statusCode, "client", 1, false);
        if (err instanceof ClioRequestFailure) throw new DownloadFailure(err.status, err.kind, err.attempts, false);
        throw err;
      }
      continue;
    }
    throw failFromStatus(response.status);
  }
  throw new DownloadFailure(null, "too_many_redirects", 1, false);
}

async function streamToFile(response: Response, tmp: string, signal: AbortSignal, idleTimeoutMs: number): Promise<number> {
  if (!response.body) throw new DownloadFailure(response.status, "empty_body", 1, true);
  const stop = new AbortController();
  let stalled = false;
  let timer = setTimeout(() => {
    stalled = true;
    stop.abort();
  }, idleTimeoutMs);
  const forward = () => stop.abort();
  if (signal.aborted) stop.abort();
  else signal.addEventListener("abort", forward, { once: true });

  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        stop.abort();
      }, idleTimeoutMs);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body as any), counter, createWriteStream(tmp), { signal: stop.signal });
  } catch (err) {
    if (signal.aborted) throw new ClioAbortedError();
    throw new DownloadFailure(null, stalled ? "stalled" : "stream_error", 1, true);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forward);
  }
  return bytes;
}

async function moveIntoPlace(tmp: string, destination: string): Promise<void> {
  try {
    await fs.rename(tmp, destination);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw err;
    await removeIfExists(destination);
    await fs.rename(tmp, destination);
  }
}

/**
 * Streams one document to `destination`. The bytes go to `<destination>.part` first, so a
 * half-written file never carries the final name. An abort leaves the `.part` file in place.
 */
export async function downloadDocument(opts: DownloadOptions): Promise<{ bytes: number }> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 60_000;
  const tmp = `${opts.destination}.part`;
  await ensureDir(path.dirname(opts.destination));

  let last: DownloadFailure = new DownloadFailure(null, "unknown", 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal.aborted) throw new ClioAbortedError();
    try {
      await removeIfExists(tmp);
      const response = await openDownload(opts, connectTimeoutMs);
      const bytes = await streamToFile(response, tmp, opts.signal, idleTimeoutMs);
      if (opts.expectedSize !== null && bytes !== opts.expectedSize) {
        throw new DownloadFailure(null, "size_mismatch", 1, true);
      }
      await moveIntoPlace(tmp, opts.destination);
      return { bytes };
    } catch (err) {
      if (isAbort(err) || opts.signal.aborted) throw new ClioAbortedError();
      if (isAuthExpired(err)) throw err;
      if (!(err instanceof DownloadFailure)) {
        await removeIfExists(tmp);
        throw err;
      }
      last = new DownloadFailure(err.status, err.kind, attempt, err.retryable);
      const giveUp = !err.retryable || (err.kind === "storage_expired" && attempt >= 2);
      if (giveUp) break;
      if (attempt < maxAttempts) await sleepAbortable(retryDelayMs(attempt - 1, null), opts.signal);
    }
  }
  await removeIfExists(tmp);
  throw last;
}
