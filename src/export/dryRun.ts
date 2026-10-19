import fs from "fs/promises";
import { clioGet, extractNextPageToken, ClioApiError } from "../utils/clioClient.js";
import type { RunEnv } from "./env.js";
import { throwIfAborted } from "./env.js";
import { describeFailure, isAbort, isAuthExpired } from "./errors.js";
import { FLAT_SPECS } from "./recordTypes.js";
import type { DocumentSummary, ReportInput, TypeLine } from "./report.js";
import type { Selection } from "./selection.js";

const PAGE = 200;
const INVALID_FIELD = /is not a valid field|invalid field/i;

export interface DryRunOutput {
  types: TypeLine[];
  documents: DocumentSummary | null;
  estimate: NonNullable<ReportInput["estimate"]>;
  matterCount: number | null;
  notes: string[];
  anyFailure: boolean;
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const stat = await (fs as any).statfs(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

async function countOf(endpoint: string, params: Record<string, string>): Promise<{ records: number | null } | { unavailable: true; status: number | null } | { failed: ReturnType<typeof describeFailure> }> {
  try {
    const body = await clioGet(endpoint, params);
    return { records: typeof body?.meta?.records === "number" ? body.meta.records : null };
  } catch (err) {
    if (isAbort(err) || isAuthExpired(err)) throw err;
    if (err instanceof ClioApiError && (err.statusCode === 403 || err.statusCode === 404)) return { unavailable: true, status: err.statusCode };
    return { failed: describeFailure(err) };
  }
}

export async function runDryRun(env: RunEnv, selection: Selection, rate: number): Promise<DryRunOutput> {
  const types: TypeLine[] = [];
  const notes: string[] = [];
  let requests = 0;
  let anyFailure = false;

  const flatNames = new Set(selection.flat);
  if (selection.documents) flatNames.add("folders");

  for (const name of [...flatNames]) {
    const spec = FLAT_SPECS[name];
    const shown = selection.names.has(name);
    env.progress.setPhase(`counting ${name === "matter_index" ? "matter index" : name}`, { showRate: false });
    const units = spec.units({ sinceIso: env.since, now: env.now() });
    let total = 0;
    let known = true;
    let unavailable = 0;
    let failed = 0;
    const unitNotes: string[] = [];
    const typeNotes: string[] = [];
    if (env.since && spec.sinceParam === null) typeNotes.push("since filter not applied, exported in full");
    let pages = 0;
    for (const unit of units) {
      throwIfAborted(env.signal);
      const params: Record<string, string> = { ...unit.params, limit: "1", fields: "id" };
      if (env.since && spec.sinceParam) params[spec.sinceParam] = env.since;
      const result = await countOf(spec.endpoint, params);
      requests++;
      if ("records" in result) {
        if (result.records === null) known = false;
        else {
          total += result.records;
          pages += Math.max(1, Math.ceil(result.records / PAGE));
        }
      } else if ("unavailable" in result) {
        unavailable++;
        unitNotes.push(`${unit.label}: not available (HTTP ${result.status})`);
      } else {
        failed++;
        anyFailure = true;
        unitNotes.push(`${unit.label}: count failed`);
      }
    }
    requests += pages;
    env.progress.addRecords(total);
    const allUnavailable = unavailable === units.length;
    if (shown) {
      types.push({
        name,
        status: allUnavailable ? "NOT AVAILABLE" : failed > 0 || unavailable > 0 ? "INCOMPLETE" : known ? "COMPLETE" : "NOT VERIFIED",
        rows: null,
        expected: allUnavailable ? null : known ? total : null,
        required: !spec.optional,
        notes: [...unitNotes, ...typeNotes],
      });
    }
    await env.audit({
      type: name,
      phase: "count",
      pages: pages,
      files: 0,
      bytes: 0,
      rows: total,
      outcome: failed > 0 || unavailable > 0 ? "error" : "success",
      errorText: unitNotes.length > 0 ? unitNotes.join(", ") : undefined,
    });
  }

  let documents: DocumentSummary | null = null;
  let matterCount: number | null = null;
  let docCount = 0;
  let docBytes = 0;
  let sizeMissing = 0;
  let withVersion = 0;
  let versionKnown = true;

  if (selection.documents) {
    let matters = 0;
    let matterTotal = 0;
    let pageToken: string | null = null;
    let listingFailed = false;
    let fieldSet = 0;
    const fieldSets = ["id,size,latest_document_version{uuid,size}", "id,size"];
    env.progress.setPhase("counting documents", { showRate: false });

    do {
      throwIfAborted(env.signal);
      const mp: Record<string, string> = { limit: String(PAGE), fields: "id", ...(pageToken ? { page_token: pageToken } : {}) };
      let matterPage: any;
      try {
        matterPage = await clioGet("/matters.json", mp);
        requests++;
      } catch (err) {
        if (isAbort(err) || isAuthExpired(err)) throw err;
        listingFailed = true;
        anyFailure = true;
        break;
      }
      if (matterTotal === 0 && typeof matterPage.meta?.records === "number") matterTotal = matterPage.meta.records;
      for (const matter of matterPage.data ?? []) {
        matters++;
        if (matterTotal > 0) env.progress.setStep(matters, matterTotal, "matter");
        let token: string | null = null;
        for (;;) {
          throwIfAborted(env.signal);
          const params: Record<string, string> = {
            matter_id: String(matter.id),
            limit: String(PAGE),
            fields: fieldSets[fieldSet],
            ...(env.since ? { updated_since: env.since } : {}),
            ...(token ? { page_token: token } : {}),
          };
          let body: any;
          try {
            body = await clioGet("/documents.json", params);
            requests++;
          } catch (err) {
            if (isAbort(err) || isAuthExpired(err)) throw err;
            if (err instanceof ClioApiError && err.statusCode === 400 && INVALID_FIELD.test(err.message) && fieldSet < fieldSets.length - 1) {
              fieldSet++;
              continue;
            }
            listingFailed = true;
            anyFailure = true;
            break;
          }
          const docs: any[] = body.data ?? [];
          if (fieldSet > 0) versionKnown = false;
          for (const doc of docs) {
            docCount++;
            if (doc.latest_document_version) withVersion++;
            const size = doc.latest_document_version?.size ?? doc.size;
            if (typeof size === "number") docBytes += size;
            else sizeMissing++;
          }
          env.progress.addRecords(docs.length);
          token = docs.length > 0 ? extractNextPageToken(body.meta) : null;
          if (!token) break;
        }
      }
      pageToken = extractNextPageToken(matterPage.meta);
    } while (pageToken);

    matterCount = matters;
    const downloadable = versionKnown ? withVersion : docCount;
    requests += downloadable;

    let unfiled = "not verified";
    try {
      const account = await countOf("/documents.json", { limit: "1", fields: "id", ...(env.since ? { updated_since: env.since } : {}) });
      requests++;
      if ("records" in account && account.records !== null && !listingFailed) {
        const outside = account.records - docCount;
        unfiled = outside === 0 ? "none (verified by count)" : outside > 0 ? `${outside} outside any matter, NOT ENUMERATED` : "not verified (counts differ)";
      }
    } catch (err) {
      if (isAbort(err) || isAuthExpired(err)) throw err;
    }
    if (sizeMissing > 0) notes.push(`${sizeMissing} documents have no size in Clio, so the byte estimate is a minimum.`);
    types.push({
      name: "documents",
      status: listingFailed ? "INCOMPLETE" : "COMPLETE",
      rows: null,
      expected: docCount,
      required: true,
      notes: listingFailed ? ["some listings failed"] : [],
    });
    documents = {
      downloaded: 0,
      unchanged: 0,
      moved: 0,
      failed: 0,
      noVersion: versionKnown ? docCount - withVersion : 0,
      bytes: docBytes,
      orphans: 0,
      unresolvedParents: 0,
      unfiled,
      wouldDownload: downloadable,
    };
    if (!versionKnown) notes.push("Clio did not return file versions in the listing, so every document is counted as a download.");
    await env.audit({
      type: "documents",
      phase: "count",
      pages: 0,
      files: docCount,
      bytes: docBytes,
      rows: docCount,
      outcome: listingFailed ? "error" : "success",
    });
  }

  const free = await freeBytes(env.outDir);
  const needed = docBytes * 1.1;
  return {
    types,
    documents,
    matterCount,
    notes,
    anyFailure,
    estimate: {
      requests,
      seconds: requests / rate,
      rate,
      bytes: docBytes,
      freeBytes: free,
      diskWarning: free !== null && needed > free,
    },
  };
}
