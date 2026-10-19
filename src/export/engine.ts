import fs from "fs/promises";
import path from "path";
import { EXIT } from "../cli/args.js";
import type { ExportRunContext } from "../cli/export.js";
import { getClioRegion } from "../utils/clioRegion.js";
import { configureClioClient } from "../utils/clioClient.js";
import { createAuditor } from "./audit.js";
import { runDocumentsPass, ResumeRefusedError } from "./documents.js";
import type { PassCheckpoint } from "./documents.js";
import { runDryRun } from "./dryRun.js";
import type { RunEnv } from "./env.js";
import { ErrorLog, groupErrors, isAbort, isAuthExpired } from "./errors.js";
import { checkpointPath, runFlatType } from "./flat.js";
import type { FlatCheckpoint } from "./flat.js";
import { ExportCorruptionError, atomicWriteFile, ensureDir, readJsonIfExists, removeFilesWithSuffix, sha256File } from "./fsutil.js";
import { newManifest, optionsOf, packageVersion, readManifest, sameOptions, writeManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import { Progress } from "./progress.js";
import { FLAT_ORDER, FLAT_SPECS } from "./recordTypes.js";
import { describeLine, renderReport } from "./report.js";
import type { DocumentSummary, ReportInput, SinceCoverage, TypeLine } from "./report.js";
import { selectTypes } from "./selection.js";
import type { Selection } from "./selection.js";

function sinceCoverage(selection: Selection): SinceCoverage {
  const filtered = selection.flat.filter((n) => FLAT_SPECS[n].sinceParam !== null);
  const full = selection.flat.filter((n) => FLAT_SPECS[n].sinceParam === null);
  if (selection.documents) filtered.push("documents");
  return { filtered, full, calendar: selection.names.has("calendar_entries") };
}

export interface EngineHooks {
  signal?: AbortSignal;
  handleSignals?: boolean;
  retryBaseDelayMs?: number;
  progressIntervalMs?: number;
  now?: () => Date;
  stderr?: (text: string) => void;
}

function installSignalHandlers(controller: AbortController, log: (text: string) => void): () => void {
  let count = 0;
  const handler = () => {
    count++;
    if (count === 1) {
      log("Interrupted: stopping. Rerun with --resume to continue.\n");
      controller.abort();
    } else {
      process.exit(EXIT.INTERRUPTED);
    }
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

async function verifyIndex(outDir: string, key: "matter_index" | "folder_index", manifest: Manifest): Promise<void> {
  const info = manifest.indexes[key];
  if (!info || info.status !== "complete") return;
  const file = path.join(outDir, "checkpoint", key === "matter_index" ? "matter_index.jsonl" : "folder_index.jsonl");
  let actual;
  try {
    actual = await sha256File(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ResumeRefusedError("index changed or missing, rerun without --resume");
    throw err;
  }
  if (actual.sha256 !== info.sha256 || actual.bytes !== info.bytes) {
    throw new ResumeRefusedError("index changed or missing, rerun without --resume");
  }
}

async function resetForRefresh(outDir: string): Promise<void> {
  const checkpointDir = path.join(outDir, "checkpoint");
  let entries: import("fs").Dirent[] = [];
  try {
    entries = await fs.readdir(checkpointDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const entry of entries) {
    if (entry.isFile()) await fs.unlink(path.join(checkpointDir, entry.name));
  }
  await fs.rm(path.join(outDir, "data"), { recursive: true, force: true });
  await removeFilesWithSuffix(path.join(outDir, "matters"), ".part");
  await removeFilesWithSuffix(path.join(outDir, "unfiled"), ".part");
}

function describeFlat(cp: FlatCheckpoint | null, name: string, sinceApplied: boolean): TypeLine {
  const spec = FLAT_SPECS[name];
  const base = { name, required: !spec.optional };
  if (!cp) return { ...base, status: "INCOMPLETE", rows: null, expected: null, notes: ["not started"] };

  const notes: string[] = [];
  const problems = cp.units.filter((u) => u.state === "failed" || u.state === "unavailable");
  const expectedKnown = cp.units.every((u) => u.state !== "done" || u.expected !== null);
  const expected = expectedKnown ? cp.units.reduce((sum, u) => sum + (u.expected ?? 0), 0) : null;

  if (cp.status === "unavailable") {
    const reason = cp.units[0]?.reason ?? "unavailable";
    return { ...base, status: "NOT AVAILABLE", rows: cp.rows, expected: null, notes: [`Clio refused access (${reason})`] };
  }
  if (cp.status === "running") notes.push("interrupted before the end");
  for (const unit of problems) {
    notes.push(unit.state === "unavailable" ? `${unit.label}: NOT ENUMERATED (${unit.reason})` : `${unit.label}: failed (${unit.reason})`);
  }
  if (cp.warnings.some((w) => w.startsWith("fields_reduced"))) notes.push("some optional fields were not accepted by Clio and were left out");
  if (cp.strippedCustomFieldRows > 0) notes.push(`custom field values unreadable in ${cp.strippedCustomFieldRows} rows`);
  if (sinceApplied && spec.sinceParam === null && name !== "matter_index") notes.push("since filter not applied, exported in full");
  if (name === "calendar_entries" && cp.units.length > 0) notes.push(`years ${cp.units[0].label} to ${cp.units[cp.units.length - 1].label}`);

  let status: TypeLine["status"] = "COMPLETE";
  if (cp.status === "running" || problems.length > 0 || cp.strippedCustomFieldRows > 0) status = "INCOMPLETE";
  else if (expected === null) status = "NOT VERIFIED";
  else if (cp.rows < expected) {
    status = "INCOMPLETE";
    notes.push(`${cp.rows} of ${expected} rows`);
  } else if (cp.rows > expected) notes.push(`${cp.rows - expected} more rows than counted at the start (records changed during the run)`);
  if (status === "NOT VERIFIED") notes.push("Clio gave no record count to compare with");
  return { ...base, status, rows: cp.rows, expected, notes };
}

function describeDocuments(pass: PassCheckpoint | null, blocked: string | undefined, versions: boolean): { lines: TypeLine[]; summary: DocumentSummary | null } {
  if (!pass) {
    return {
      lines: [{ name: "documents", status: "INCOMPLETE", rows: null, expected: null, required: true, notes: [blocked ?? "not started"] }],
      summary: null,
    };
  }
  const notes: string[] = [];
  const expected = pass.expectedKnown ? pass.expectedDocuments : null;
  let status: TypeLine["status"] = "COMPLETE";
  if (pass.status === "running") {
    status = "INCOMPLETE";
    notes.push("interrupted before the end");
  }
  if (pass.stats.failed > 0) {
    status = "INCOMPLETE";
    notes.push(`${pass.stats.failed} documents failed`);
  }
  if (pass.stats.listingFailures > 0) {
    status = "INCOMPLETE";
    notes.push(`${pass.stats.listingFailures} matter listings failed`);
  }
  if (expected === null && status === "COMPLETE") status = "NOT VERIFIED";
  else if (expected !== null && pass.rows.documents < expected) {
    status = "INCOMPLETE";
    notes.push(`${pass.rows.documents} of ${expected} rows`);
  }
  if (pass.unfiled.status === "not_enumerated") {
    status = "INCOMPLETE";
    notes.push(`${pass.unfiled.outside} documents outside any matter were NOT ENUMERATED`);
  } else if (pass.unfiled.status === "not_verified" && status === "COMPLETE") {
    status = "NOT VERIFIED";
    notes.push("documents outside matters could not be verified by count");
  }
  if (pass.warnings.some((w) => w.startsWith("document_fields_reduced"))) {
    notes.push("some document fields were not accepted by Clio (folder structure may be flattened)");
  }

  const lines: TypeLine[] = [{ name: "documents", status, rows: pass.rows.documents, expected, required: true, notes }];
  if (versions) {
    lines.push({
      name: "document_versions",
      status: pass.versionsUnavailable ? "NOT AVAILABLE" : "NOT VERIFIED",
      rows: pass.rows.document_versions,
      expected: null,
      required: false,
      notes: pass.versionsUnavailable ? ["Clio refused access"] : ["Clio gives no count to compare with"],
    });
  }
  const unfiledText =
    pass.unfiled.status === "none"
      ? "none (verified by count)"
      : pass.unfiled.status === "not_enumerated"
        ? `${pass.unfiled.outside} NOT ENUMERATED`
        : "not verified";
  return {
    lines,
    summary: {
      downloaded: pass.stats.downloaded,
      unchanged: pass.stats.unchanged,
      moved: pass.stats.moved,
      failed: pass.stats.failed,
      noVersion: pass.stats.noVersion,
      bytes: pass.stats.bytes,
      orphans: pass.stats.orphans,
      unresolvedParents: pass.stats.unresolvedParents,
      unfiled: unfiledText,
    },
  };
}

export async function runExportEngine(ctx: ExportRunContext, hooks: EngineHooks = {}): Promise<number> {
  const { args } = ctx;
  const log = hooks.stderr ?? ((text: string) => void process.stderr.write(text));
  const now = hooks.now ?? (() => new Date());
  const controller = new AbortController();
  if (hooks.signal) {
    if (hooks.signal.aborted) controller.abort();
    else hooks.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const removeHandlers = hooks.handleSignals === false ? () => {} : installSignalHandlers(controller, log);
  const progress = new Progress((line) => log(`${line}\n`), undefined, hooks.progressIntervalMs);
  const startedAt = now().toISOString();
  const selection = selectTypes(args);
  let reportContext: { manifest: Manifest; errors: ErrorLog | null } | null = null;

  const writeReport = async (verdict: ReportInput["verdict"], reasons: string[], manifest: Manifest | null, extra?: Partial<ReportInput>) => {
    try {
      const flatCps: Record<string, FlatCheckpoint | null> = {};
      const names = FLAT_ORDER.filter((n) => selection.names.has(n));
      for (const name of names) flatCps[name] = await readJsonIfExists<FlatCheckpoint>(checkpointPath(args.out, name));
      const types = extra?.types ?? names.map((name) => describeFlat(flatCps[name], name, args.since !== null));
      const errors = await groupErrors(path.join(args.out, "errors.jsonl"));
      const input: ReportInput = {
        mode: "export",
        verdict,
        reasons,
        version: packageVersion(),
        region: getClioRegion(),
        startedAt,
        finishedAt: now().toISOString(),
        since: args.since?.iso ?? null,
        types,
        documents: null,
        errors,
        notExported: args.notExported.length > 0 ? args.notExported : ["ledger_reports"],
        notes: [],
        matterIndexBuiltAt: manifest?.indexes.matter_index?.built_at ?? null,
        matterCount: manifest?.indexes.matter_index?.count ?? null,
        ...extra,
      };
      await atomicWriteFile(path.join(args.out, "REPORT.md"), renderReport(input));
    } catch {
      /* the report is best effort when the run already failed */
    }
  };

  try {
    configureClioClient({
      requestsPerSecond: args.rate,
      maxAttempts: 6,
      timeoutMs: 60_000,
      signal: controller.signal,
      baseDelayMs: hooks.retryBaseDelayMs,
    });
    await ensureDir(args.out);
    const region = getClioRegion();
    const auditor = createAuditor({ clioUserId: ctx.clioUserId, since: args.since?.iso ?? null, dryRun: args.dryRun });

    const existing = await readManifest(args.out);
    let manifest: Manifest;
    let resumed = false;

    if (args.dryRun) {
      manifest = existing ?? newManifest(args, ctx.clioUserId, region, now());
    } else if (existing && args.resume) {
      if (!sameOptions(existing.options, optionsOf(args))) {
        throw new ResumeRefusedError("the options differ from the original run, repeat them exactly or rerun without --resume");
      }
      if (existing.region !== region || (existing.clio_user_id && ctx.clioUserId && existing.clio_user_id !== ctx.clioUserId)) {
        throw new ResumeRefusedError("this export belongs to a different Clio account or region");
      }
      await verifyIndex(args.out, "matter_index", existing);
      await verifyIndex(args.out, "folder_index", existing);
      manifest = existing;
      resumed = true;
    } else if (existing) {
      await resetForRefresh(args.out);
      manifest = {
        ...newManifest(args, ctx.clioUserId, region, now()),
        created_at: existing.created_at,
        refresh_started_at: now().toISOString(),
      };
      await writeManifest(args.out, manifest);
    } else {
      manifest = newManifest(args, ctx.clioUserId, region, now());
      await writeManifest(args.out, manifest);
    }

    const errors = await ErrorLog.create(path.join(args.out, "errors.jsonl"), !resumed && !args.dryRun);
    reportContext = { manifest, errors };
    const env: RunEnv = {
      outDir: args.out,
      signal: controller.signal,
      since: args.since?.iso ?? null,
      concurrency: args.concurrency,
      clioUserId: ctx.clioUserId,
      errors,
      progress,
      manifest,
      now,
      saveManifest: async () => {
        if (!args.dryRun) await writeManifest(args.out, manifest);
      },
      audit: auditor,
      log: (line) => log(`${line}\n`),
    };

    progress.start();

    if (args.dryRun) {
      const result = await runDryRun(env, selection, args.rate);
      progress.stop();
      const input: ReportInput = {
        mode: "dry-run",
        verdict: "DRY RUN",
        reasons: [],
        version: packageVersion(),
        region,
        startedAt,
        finishedAt: now().toISOString(),
        since: args.since?.iso ?? null,
        types: result.types,
        documents: result.documents,
        errors: [],
        notExported: args.notExported.length > 0 ? args.notExported : ["ledger_reports"],
        notes: result.notes,
        matterIndexBuiltAt: null,
        matterCount: result.matterCount,
        estimate: result.estimate,
        sinceCoverage: args.since ? sinceCoverage(selection) : undefined,
      };
      await atomicWriteFile(path.join(args.out, "REPORT.md"), renderReport(input));
      log(`Dry run finished: about ${result.estimate.requests} requests. See REPORT.md in the output folder.\n`);
      if (result.estimate.diskWarning) log("Warning: the free disk space looks too small for this export.\n");
      return result.anyFailure ? EXIT.DONE_WITH_ERRORS : EXIT.OK;
    }

    if (selection.needsMatterIndex) log("Building the matter index (needed for documents).\n");
    const flatCps: Record<string, FlatCheckpoint> = {};
    if (selection.needsMatterIndex) await runFlatType(FLAT_SPECS.matter_index, env, { writeData: false });
    for (const name of FLAT_ORDER) {
      const wanted = selection.names.has(name);
      if (!wanted && !(name === "folders" && selection.needsFolderIndex)) continue;
      const cp = await runFlatType(FLAT_SPECS[name], env, { writeData: wanted });
      if (wanted) flatCps[name] = cp;
    }
    let pass: PassCheckpoint | null = null;
    let blocked: string | undefined;
    if (selection.documents) {
      const result = await runDocumentsPass(env, { versions: selection.versions });
      pass = result.checkpoint;
      blocked = result.blockedReason;
    }
    progress.stop();

    const lines: TypeLine[] = FLAT_ORDER.filter((n) => selection.names.has(n)).map((n) => describeFlat(flatCps[n] ?? null, n, args.since !== null));
    const docs = selection.documents ? describeDocuments(pass, blocked, selection.versions) : { lines: [], summary: null };
    const types = [...lines, ...docs.lines];

    const reasons = types.filter((t) => t.status !== "COMPLETE" && (t.required || t.status === "INCOMPLETE")).map(describeLine);
    if (errors.total > 0) reasons.push(`${errors.total} errors recorded in errors.jsonl`);
    const verdict = reasons.length === 0 ? "COMPLETE" : "INCOMPLETE";

    const unverified = types
      .filter((t) => (t.status === "INCOMPLETE" || t.status === "NOT VERIFIED") && !reasons.includes(describeLine(t)))
      .map(describeLine);
    const summaryLines = [...reasons, ...unverified];

    const notes = ["Expense entries are exported per Clio activity type (expense, hard cost, soft cost); rows carry their type."];
    await writeReport(verdict, summaryLines, manifest, {
      types,
      documents: docs.summary,
      notes,
      sinceCoverage: args.since ? sinceCoverage(selection) : undefined,
    });

    log(`Export finished: ${verdict}.\n`);
    for (const line of summaryLines) log(`  - ${line}\n`);
    log("See REPORT.md in the output folder.\n");
    return verdict === "COMPLETE" ? EXIT.OK : EXIT.DONE_WITH_ERRORS;
  } catch (err) {
    progress.stop();
    if (isAuthExpired(err)) {
      log("The Clio login expired or was revoked. Run auth, then rerun with --resume.\n");
      await writeReport("INTERRUPTED", ["login expired; rerun with --resume after running auth"], reportContext?.manifest ?? null);
      return EXIT.NOT_LOGGED_IN;
    }
    if (isAbort(err) || controller.signal.aborted) {
      await writeReport("INTERRUPTED", ["interrupted; rerun with --resume"], reportContext?.manifest ?? null);
      return EXIT.INTERRUPTED;
    }
    if (err instanceof ResumeRefusedError) {
      log(`Cannot resume: ${err.message}.\n`);
      return EXIT.USAGE;
    }
    if (err instanceof ExportCorruptionError) {
      log(`${err.message}. Rerun without --resume.\n`);
      return EXIT.FATAL;
    }
    const code = (err as NodeJS.ErrnoException)?.code;
    log(`Fatal error (${err instanceof Error ? err.name : "unknown"}${code ? ` ${code}` : ""}).\n`);
    return EXIT.FATAL;
  } finally {
    progress.stop();
    removeHandlers();
    configureClioClient(null);
  }
}
