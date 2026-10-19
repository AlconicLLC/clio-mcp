import fs from "fs/promises";
import path from "path";
import { clioGet, extractNextPageToken, ClioApiError } from "../utils/clioClient.js";
import { csvHeader, csvRow, inferColumns } from "./csv.js";
import { downloadDocument } from "./download.js";
import type { RunEnv } from "./env.js";
import { throwIfAborted } from "./env.js";
import { describeFailure, isAbort, isAuthExpired } from "./errors.js";
import { AppendFile, atomicWriteJson, ensureDir, readJsonIfExists, readLinesFrom, removeFilesWithSuffix } from "./fsutil.js";
import { PathTooLongError, buildFileName, buildMatterFolderName, fitRelativePath, sanitizeSegment } from "./fsnames.js";
import { DOCUMENT_COLUMNS, DOCUMENT_FIELD_SETS } from "./recordTypes.js";

export type UnfiledStatus = "pending" | "none" | "not_enumerated" | "not_verified";

export interface PassCheckpoint {
  status: "running" | "done";
  fieldSet: number;
  files: Record<string, number>;
  rows: { documents: number; document_versions: number };
  expectedDocuments: number;
  expectedKnown: boolean;
  cursor: { indexOffset: number; matterId: number | null; subphase: "documents"; pageToken: string | null };
  matterDone: number;
  versionColumns: string[] | null;
  versionsUnavailable: boolean;
  stats: {
    pages: number;
    downloaded: number;
    unchanged: number;
    moved: number;
    failed: number;
    noVersion: number;
    bytes: number;
    orphans: number;
    unresolvedParents: number;
    listingFailures: number;
  };
  unfiled: { status: UnfiledStatus; accountTotal: number | null; outside: number | null };
  warnings: string[];
}

interface LedgerEntry {
  size: number | null;
  uuid: string;
  rel: string;
  lastSeen: string;
  orphan?: boolean;
}

interface Ledger {
  docs: Record<string, LedgerEntry>;
}

interface FolderNode {
  p: number | null;
  m: number | null;
  n: string;
}

export interface PassResult {
  checkpoint: PassCheckpoint | null;
  blockedReason?: string;
}

export class ResumeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeRefusedError";
  }
}

const INVALID_FIELD = /is not a valid field|invalid field/i;
const PASS_FILE = "matter_pass";

export const passCheckpointPath = (outDir: string) => path.join(outDir, "checkpoint", `${PASS_FILE}.json`);
const ledgerPath = (outDir: string, matterId: number) => path.join(outDir, "checkpoint", "documents", `${matterId}.json`);

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (failure === null) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        failure = { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}

async function loadFolderMap(file: string): Promise<Map<number, FolderNode>> {
  const map = new Map<number, FolderNode>();
  for await (const line of readLinesFrom(file, 0)) {
    if (line.text === "") continue;
    const entry = JSON.parse(line.text) as { i: number; p: number | null; m: number | null; n: string };
    map.set(entry.i, { p: entry.p, m: entry.m, n: entry.n });
  }
  return map;
}

function resolveSegments(parentId: number | null, matterId: number, map: Map<number, FolderNode>): { segments: string[]; resolved: boolean } {
  const chain: string[] = [];
  let current = parentId;
  for (let depth = 0; current !== null && depth < 200; depth++) {
    const folder = map.get(current);
    if (!folder) return { segments: [], resolved: false };
    if (folder.m !== matterId) break;
    const parent = folder.p === null ? undefined : map.get(folder.p);
    if (folder.p === null || parent === undefined || parent.m !== matterId) break;
    chain.push(sanitizeSegment(folder.n, "folder"));
    current = folder.p;
  }
  return { segments: chain.reverse(), resolved: true };
}

async function sizeMatches(file: string, size: number | null): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && (size === null || stat.size === size);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function removeEmptyDirs(start: string, stopAt: string): Promise<void> {
  let dir = start;
  while (dir.length > stopAt.length && dir.startsWith(stopAt)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

interface DocOutcome {
  row: any;
}

export async function runDocumentsPass(env: RunEnv, opts: { versions: boolean }): Promise<PassResult> {
  const indexInfo = env.manifest.indexes.matter_index;
  const folderInfo = env.manifest.indexes.folder_index;
  if (indexInfo?.status !== "complete") return { checkpoint: null, blockedReason: "the matter index is incomplete" };
  if (folderInfo?.status !== "complete") return { checkpoint: null, blockedReason: "the folder index is incomplete" };

  const cpFile = passCheckpointPath(env.outDir);
  const existing = await readJsonIfExists<PassCheckpoint>(cpFile);
  if (existing?.status === "done") return { checkpoint: existing };
  const resuming = existing !== null;

  const cp: PassCheckpoint = existing ?? {
    status: "running",
    fieldSet: 0,
    files: {},
    rows: { documents: 0, document_versions: 0 },
    expectedDocuments: 0,
    expectedKnown: true,
    cursor: { indexOffset: 0, matterId: null, subphase: "documents", pageToken: null },
    matterDone: 0,
    versionColumns: null,
    versionsUnavailable: false,
    stats: { pages: 0, downloaded: 0, unchanged: 0, moved: 0, failed: 0, noVersion: 0, bytes: 0, orphans: 0, unresolvedParents: 0, listingFailures: 0 },
    unfiled: { status: "pending", accountTotal: null, outside: null },
    warnings: [],
  };

  const indexFile = path.join(env.outDir, "checkpoint", "matter_index.jsonl");
  const folderMap = await loadFolderMap(path.join(env.outDir, "checkpoint", "folder_index.jsonl"));
  const refreshId = env.manifest.refresh_id ?? env.manifest.created_at;
  const totalMatters = indexInfo.count ?? 0;
  env.progress.setPhase("documents");

  const rel = {
    docJsonl: "data/documents.jsonl",
    docCsv: "data/documents.csv",
    verJsonl: "data/document_versions.jsonl",
    verCsv: "data/document_versions.csv",
  };
  const offset = (file: string) => (resuming ? cp.files[file] ?? 0 : null);
  const docJsonl = await AppendFile.open(path.join(env.outDir, rel.docJsonl), offset(rel.docJsonl));
  const docCsv = await AppendFile.open(path.join(env.outDir, rel.docCsv), offset(rel.docCsv));
  const verJsonl = opts.versions ? await AppendFile.open(path.join(env.outDir, rel.verJsonl), offset(rel.verJsonl)) : null;
  const verCsv = opts.versions ? await AppendFile.open(path.join(env.outDir, rel.verCsv), offset(rel.verCsv)) : null;

  const save = async () => {
    for (const file of [docJsonl, docCsv, verJsonl, verCsv]) await file?.sync();
    cp.files[rel.docJsonl] = docJsonl.bytes;
    cp.files[rel.docCsv] = docCsv.bytes;
    if (verJsonl && verCsv) {
      cp.files[rel.verJsonl] = verJsonl.bytes;
      cp.files[rel.verCsv] = verCsv.bytes;
    }
    await atomicWriteJson(cpFile, cp);
  };

  try {
    if (!resuming) {
      await docCsv.write(csvHeader(DOCUMENT_COLUMNS));
      await save();
    }

    for await (const line of readLinesFrom(indexFile, cp.cursor.indexOffset)) {
      throwIfAborted(env.signal);
      if (line.text === "") continue;
      const matter = JSON.parse(line.text) as { id: number; n: string | null; c: string | null };
      const midMatter = line.offset === cp.cursor.indexOffset && cp.cursor.matterId !== null;
      if (midMatter && cp.cursor.matterId !== matter.id) {
        throw new ResumeRefusedError("the matter index no longer matches the checkpoint");
      }
      const folderName = buildMatterFolderName(matter.n, matter.c, matter.id);
      if (midMatter) await removeFilesWithSuffix(path.join(env.outDir, "matters", folderName), ".part");
      if (totalMatters > 0) env.progress.setStep(cp.matterDone + 1, totalMatters, "matter");

      await processMatter(matter, folderName, line, midMatter ? cp.cursor.pageToken : null);
      cp.cursor = { indexOffset: line.nextOffset, matterId: null, subphase: "documents", pageToken: null };
      await save();
    }

    await checkUnfiled();
    cp.status = "done";
    await save();
  } finally {
    for (const file of [docJsonl, docCsv, verJsonl, verCsv]) await file?.close();
  }

  await env.audit({
    type: "documents",
    phase: "fetch",
    pages: cp.stats.pages,
    files: 0,
    bytes: cp.files[rel.docJsonl] ?? 0,
    rows: cp.rows.documents,
    outcome: cp.stats.listingFailures > 0 ? "error" : "success",
    errorText: cp.stats.listingFailures > 0 ? `${cp.stats.listingFailures} listing failures` : undefined,
  });
  await env.audit({
    type: "documents",
    phase: "download",
    pages: 0,
    files: cp.stats.downloaded,
    bytes: cp.stats.bytes,
    rows: cp.stats.downloaded + cp.stats.moved + cp.stats.unchanged,
    outcome: cp.stats.failed > 0 ? "error" : "success",
    errorText: cp.stats.failed > 0 ? `${cp.stats.failed} failed downloads` : undefined,
  });
  return { checkpoint: cp };

  async function fetchDocumentPage(matterId: number, token: string | null): Promise<{ ok: true; body: any } | { ok: false; info: ReturnType<typeof describeFailure> }> {
    for (;;) {
      const params: Record<string, string> = {
        matter_id: String(matterId),
        limit: "200",
        fields: DOCUMENT_FIELD_SETS[cp.fieldSet],
      };
      if (env.since) params.updated_since = env.since;
      if (token) params.page_token = token;
      try {
        return { ok: true, body: await clioGet("/documents.json", params) };
      } catch (err) {
        if (isAbort(err) || isAuthExpired(err)) throw err;
        if (err instanceof ClioApiError && err.statusCode === 400 && INVALID_FIELD.test(err.message) && cp.fieldSet < DOCUMENT_FIELD_SETS.length - 1) {
          cp.fieldSet++;
          cp.warnings.push(`document_fields_reduced_to_set_${cp.fieldSet}`);
          continue;
        }
        return { ok: false, info: describeFailure(err) };
      }
    }
  }

  async function listVersions(documentId: number): Promise<any[]> {
    const out: any[] = [];
    let token: string | null = null;
    for (;;) {
      throwIfAborted(env.signal);
      const params: Record<string, string> = { limit: "200", ...(token ? { page_token: token } : {}) };
      let body: any;
      try {
        body = await clioGet(`/documents/${documentId}/versions.json`, params);
      } catch (err) {
        if (isAbort(err) || isAuthExpired(err)) throw err;
        if (err instanceof ClioApiError && (err.statusCode === 403 || err.statusCode === 404) && token === null) {
          cp.versionsUnavailable = true;
          cp.warnings.push("document_versions_unavailable");
          return out;
        }
        await env.errors.record({ type: "document_versions", id: documentId, ...describeFailure(err) });
        return out;
      }
      const rows: any[] = Array.isArray(body?.data) ? body.data : [];
      for (const row of rows) out.push({ document_id: documentId, ...row });
      token = rows.length > 0 ? extractNextPageToken(body?.meta) : null;
      if (!token) return out;
    }
  }

  async function processMatter(
    matter: { id: number; n: string | null; c: string | null },
    folderName: string,
    position: { offset: number; nextOffset: number },
    resumeToken: string | null
  ): Promise<void> {
    const ledger = (await readJsonIfExists<Ledger>(ledgerPath(env.outDir, matter.id))) ?? { docs: {} };
    let ledgerDirty = false;
    let token = resumeToken;
    let listedAll = true;

    for (;;) {
      throwIfAborted(env.signal);
      const page = await fetchDocumentPage(matter.id, token);
      if (!page.ok) {
        cp.stats.listingFailures++;
        cp.matterDone++;
        listedAll = false;
        await env.errors.record({ type: "documents", ...page.info });
        break;
      }
      const docs: any[] = Array.isArray(page.body?.data) ? page.body.data : [];
      if (token === null) {
        const records = page.body?.meta?.records;
        if (typeof records === "number") {
          cp.expectedDocuments += records;
          env.progress.addExpected(records);
        } else {
          cp.expectedKnown = false;
        }
      }

      const outcomes = await mapLimit<any, DocOutcome>(docs, env.concurrency, (doc) => processDocument(doc));
      const rows = outcomes.map((o) => o.row);
      if (rows.length > 0) {
        await docJsonl.write(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
        await docCsv.write(rows.map((r) => csvRow(r, DOCUMENT_COLUMNS)).join(""));
      }
      if (opts.versions && verJsonl && verCsv && !cp.versionsUnavailable) {
        const batches = await mapLimit<any, any[]>(docs, env.concurrency, (doc) => listVersions(doc.id));
        const versionRows = batches.flat();
        if (versionRows.length > 0) {
          cp.versionColumns ??= inferColumns(versionRows);
          if (verCsv.bytes === 0) await verCsv.write(csvHeader(cp.versionColumns));
          await verJsonl.write(`${versionRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
          await verCsv.write(versionRows.map((r) => csvRow(r, cp.versionColumns!)).join(""));
          cp.rows.document_versions += versionRows.length;
        }
      }
      cp.rows.documents += rows.length;
      cp.stats.pages++;
      env.progress.addRecords(rows.length);
      if (ledgerDirty) {
        await atomicWriteJson(ledgerPath(env.outDir, matter.id), ledger);
        ledgerDirty = false;
      }

      const next = docs.length > 0 ? extractNextPageToken(page.body?.meta) : null;
      if (!next) cp.matterDone++;
      cp.cursor = next
        ? { indexOffset: position.offset, matterId: matter.id, subphase: "documents", pageToken: next }
        : { indexOffset: position.nextOffset, matterId: null, subphase: "documents", pageToken: null };
      await save();
      if (!next) break;
      token = next;
    }

    if (listedAll && !env.since) {
      let orphaned = 0;
      for (const entry of Object.values(ledger.docs)) {
        if (entry.lastSeen !== refreshId) {
          orphaned++;
          if (!entry.orphan) {
            entry.orphan = true;
            ledgerDirty = true;
          }
        }
      }
      cp.stats.orphans += orphaned;
    }
    if (ledgerDirty) await atomicWriteJson(ledgerPath(env.outDir, matter.id), ledger);

    async function processDocument(doc: any): Promise<DocOutcome> {
      const withExport = (status: string, relPath: string | null): DocOutcome => ({ row: { ...doc, export: { status, path: relPath } } });
      const version = doc.latest_document_version;
      const uuid: string | null = typeof version?.uuid === "string" ? version.uuid : null;
      const size: number | null = typeof version?.size === "number" ? version.size : typeof doc.size === "number" ? doc.size : null;
      const key = String(doc.id);

      if (!uuid) {
        cp.stats.noVersion++;
        return withExport("no_version", null);
      }

      const parentId = typeof doc.parent?.id === "number" ? doc.parent.id : null;
      const { segments, resolved } = resolveSegments(parentId, matter.id, folderMap);
      if (!resolved) cp.stats.unresolvedParents++;

      let relParts: string[];
      try {
        const fitted = fitRelativePath(env.outDir, ["matters", folderName, ...segments], buildFileName(String(doc.name ?? "document"), doc.id));
        relParts = [...fitted.segments, fitted.fileName];
      } catch (err) {
        if (!(err instanceof PathTooLongError)) throw err;
        cp.stats.failed++;
        await env.errors.record({ type: "documents", id: doc.id, ...describeFailure(err) });
        return withExport("failed", null);
      }
      const relPath = relParts.join("/");
      const target = path.join(env.outDir, ...relParts);
      const entry = ledger.docs[key];

      const remember = (bytes: number | null) => {
        ledger.docs[key] = { size: size ?? bytes, uuid, rel: relPath, lastSeen: refreshId };
        ledgerDirty = true;
      };

      if ((await sizeMatches(target, size)) && (!entry || entry.uuid === uuid)) {
        remember(null);
        cp.stats.unchanged++;
        return withExport("unchanged", relPath);
      }

      if (entry && entry.uuid === uuid && entry.size === size && entry.rel !== relPath) {
        const previous = path.join(env.outDir, ...entry.rel.split("/"));
        if (await sizeMatches(previous, size)) {
          try {
            await ensureDir(path.dirname(target));
            await fs.rename(previous, target);
            await removeEmptyDirs(path.dirname(previous), path.join(env.outDir, "matters"));
            remember(null);
            cp.stats.moved++;
            return withExport("moved", relPath);
          } catch {
            cp.stats.orphans++;
          }
        }
      }

      try {
        const { bytes } = await downloadDocument({
          documentId: doc.id,
          versionUuid: uuid,
          destination: target,
          expectedSize: size,
          signal: env.signal,
        });
        remember(bytes);
        cp.stats.downloaded++;
        cp.stats.bytes += bytes;
        env.progress.addFile(bytes);
        return withExport("downloaded", relPath);
      } catch (err) {
        if (isAbort(err) || isAuthExpired(err)) throw err;
        cp.stats.failed++;
        await env.errors.record({ type: "documents", id: doc.id, ...describeFailure(err) });
        return withExport("failed", null);
      }
    }
  }

  async function checkUnfiled(): Promise<void> {
    if (!cp.expectedKnown) {
      cp.unfiled = { status: "not_verified", accountTotal: null, outside: null };
      return;
    }
    try {
      const params: Record<string, string> = { limit: "1", fields: "id" };
      if (env.since) params.updated_since = env.since;
      const body = await clioGet("/documents.json", params);
      const total = body?.meta?.records;
      if (typeof total !== "number") {
        cp.unfiled = { status: "not_verified", accountTotal: null, outside: null };
        return;
      }
      const outside = total - cp.expectedDocuments;
      cp.unfiled = {
        status: outside === 0 ? "none" : outside > 0 ? "not_enumerated" : "not_verified",
        accountTotal: total,
        outside,
      };
    } catch (err) {
      if (isAbort(err) || isAuthExpired(err)) throw err;
      cp.unfiled = { status: "not_verified", accountTotal: null, outside: null };
    }
  }
}
