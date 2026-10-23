import path from "path";
import { clioGet, extractNextPageToken, ClioApiError } from "../utils/clioClient.js";
import { csvHeader, csvRow, inferColumns } from "./csv.js";
import type { RunEnv } from "./env.js";
import { throwIfAborted } from "./env.js";
import { describeFailure, isAbort, isAuthExpired } from "./errors.js";
import { AppendFile, atomicWriteJson, readJsonIfExists, sha256File } from "./fsutil.js";
import type { FlatTypeSpec } from "./recordTypes.js";

export interface UnitState {
  label: string;
  params: Record<string, string>;
  expected: number | null;
  rows: number;
  state: "pending" | "done" | "unavailable" | "failed";
  reason?: string;
}

export interface FlatCheckpoint {
  type: string;
  status: "running" | "done" | "unavailable";
  fieldSet: number;
  columns: string[] | null;
  units: UnitState[];
  cursor: { unit: number; pageToken: string | null };
  files: Record<string, number>;
  rows: number;
  pages: number;
  bytes: number;
  warnings: string[];
  strippedCustomFieldRows: number;
}

export const INDEX_KEYS: Record<string, "matter_index" | "folder_index"> = {
  matter_index: "matter_index",
  folders: "folder_index",
};

export function checkpointPath(outDir: string, name: string): string {
  return path.join(outDir, "checkpoint", `${name}.json`);
}

const INVALID_FIELD = /is not a valid field|invalid field/i;

type PageResult =
  | { ok: true; body: any }
  | { ok: false; status: number | null; kind: string; attempts: number; unavailable: boolean };

async function fetchPage(
  spec: FlatTypeSpec,
  cp: FlatCheckpoint,
  unit: UnitState,
  token: string | null,
  env: RunEnv
): Promise<PageResult> {
  for (;;) {
    const params: Record<string, string> = { ...unit.params, limit: "200" };
    const fields = spec.fieldSets[cp.fieldSet];
    if (fields !== null) params.fields = fields;
    if (env.since && spec.sinceParam) params[spec.sinceParam] = env.since;
    if (token) params.page_token = token;
    try {
      return { ok: true, body: await clioGet(spec.endpoint, params) };
    } catch (err) {
      if (isAbort(err) || isAuthExpired(err)) throw err;
      if (err instanceof ClioApiError && err.statusCode === 400 && INVALID_FIELD.test(err.message) && cp.fieldSet < spec.fieldSets.length - 1) {
        cp.fieldSet++;
        cp.warnings.push(`fields_reduced_to_set_${cp.fieldSet}`);
        continue;
      }
      const info = describeFailure(err);
      const unavailable = err instanceof ClioApiError && (err.statusCode === 403 || err.statusCode === 404) && token === null;
      return { ok: false, ...info, unavailable };
    }
  }
}

function countStrippedCustomFields(rows: any[]): number {
  let stripped = 0;
  for (const row of rows) {
    const values = row?.custom_field_values;
    if (Array.isArray(values) && values.some((v) => v && (v.field_name === null || v.field_name === undefined))) stripped++;
  }
  return stripped;
}

export async function runFlatType(spec: FlatTypeSpec, env: RunEnv, opts: { writeData: boolean }): Promise<FlatCheckpoint> {
  const cpFile = checkpointPath(env.outDir, spec.name);
  const existing = await readJsonIfExists<FlatCheckpoint>(cpFile);
  if (existing && (existing.status === "done" || existing.status === "unavailable")) return existing;

  const writeData = opts.writeData && !spec.noData;
  const jsonlRel = `data/${spec.name}.jsonl`;
  const csvRel = `data/${spec.name}.csv`;
  const indexKey = spec.side ? INDEX_KEYS[spec.name] : undefined;

  const cp: FlatCheckpoint = existing ?? {
    type: spec.name,
    status: "running",
    fieldSet: 0,
    columns: spec.columns,
    units: spec.units({ sinceIso: env.since, now: env.now() }).map((u) => ({ ...u, expected: null, rows: 0, state: "pending" as const })),
    cursor: { unit: 0, pageToken: null },
    files: {},
    rows: 0,
    pages: 0,
    bytes: 0,
    warnings: [],
    strippedCustomFieldRows: 0,
  };
  const resuming = existing !== null;

  const offsetOf = (rel: string) => (resuming ? cp.files[rel] ?? 0 : null);
  const jsonl = writeData ? await AppendFile.open(path.join(env.outDir, jsonlRel), offsetOf(jsonlRel)) : null;
  const csv = writeData ? await AppendFile.open(path.join(env.outDir, csvRel), offsetOf(csvRel)) : null;
  const side = spec.side ? await AppendFile.open(path.join(env.outDir, spec.side.file), offsetOf(spec.side.file)) : null;

  const saveFiles = async () => {
    for (const file of [jsonl, csv, side]) await file?.sync();
    if (jsonl) cp.files[jsonlRel] = jsonl.bytes;
    if (csv) cp.files[csvRel] = csv.bytes;
    if (side && spec.side) cp.files[spec.side.file] = side.bytes;
    await atomicWriteJson(cpFile, cp);
  };

  let failedUnits = 0;
  env.progress.setPhase(spec.name === "matter_index" ? "matter index" : spec.name);
  try {
    if (!resuming) {
      if (indexKey) {
        env.manifest.indexes[indexKey] = { status: "building" };
        await env.saveManifest();
      }
      if (csv && cp.columns && cp.columns.length > 0) await csv.write(csvHeader(cp.columns));
      await saveFiles();
    }

    for (let u = cp.cursor.unit; u < cp.units.length; u++) {
      const unit = cp.units[u];
      if (unit.state !== "pending") continue;
      if (cp.units.length > 1) env.progress.setStep(u + 1, cp.units.length, spec.name === "calendar_entries" ? "year" : "part");
      let token = u === cp.cursor.unit ? cp.cursor.pageToken : null;

      for (;;) {
        throwIfAborted(env.signal);
        const page = await fetchPage(spec, cp, unit, token, env);

        if (!page.ok) {
          if (page.unavailable) {
            unit.state = "unavailable";
            unit.reason = `HTTP ${page.status}`;
          } else {
            unit.state = "failed";
            unit.reason = page.status ? `HTTP ${page.status}` : page.kind;
            failedUnits++;
            await env.errors.record({ type: spec.name, status: page.status, kind: page.kind, attempts: page.attempts });
          }
          cp.cursor = { unit: u + 1, pageToken: null };
          await saveFiles();
          break;
        }

        const rows: any[] = Array.isArray(page.body?.data) ? page.body.data : [];
        if (token === null) {
          unit.expected = typeof page.body?.meta?.records === "number" ? page.body.meta.records : null;
          env.progress.addExpected(unit.expected ?? 0);
        }

        if (csv && cp.columns === null && rows.length > 0) cp.columns = inferColumns(rows);
        if (csv && csv.bytes === 0 && cp.columns && cp.columns.length > 0) await csv.write(csvHeader(cp.columns));
        if (jsonl && rows.length > 0) await jsonl.write(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
        if (csv && cp.columns && rows.length > 0) await csv.write(rows.map((r) => csvRow(r, cp.columns!)).join(""));
        if (side && spec.side && rows.length > 0) await side.write(`${rows.map((r) => JSON.stringify(spec.side!.map(r))).join("\n")}\n`);

        cp.rows += rows.length;
        cp.pages++;
        unit.rows += rows.length;
        if (jsonl) cp.bytes = jsonl.bytes;
        cp.strippedCustomFieldRows += countStrippedCustomFields(rows);
        env.progress.addRecords(rows.length);

        const next = rows.length > 0 ? extractNextPageToken(page.body?.meta) : null;
        if (next) {
          cp.cursor = { unit: u, pageToken: next };
        } else {
          unit.state = "done";
          cp.cursor = { unit: u + 1, pageToken: null };
        }
        await saveFiles();
        if (!next) break;
        token = next;
      }
    }

    if (csv && csv.bytes === 0) {
      cp.columns = cp.columns && cp.columns.length > 0 ? cp.columns : ["id"];
      await csv.write(csvHeader(cp.columns));
    }
    cp.status = cp.units.every((unit) => unit.state === "unavailable") ? "unavailable" : "done";
    await saveFiles();
  } finally {
    for (const file of [jsonl, csv, side]) await file?.close();
  }

  if (indexKey && spec.side && failedUnits === 0 && cp.units.every((unit) => unit.state === "done")) {
    const { sha256, bytes } = await sha256File(path.join(env.outDir, spec.side.file));
    env.manifest.indexes[indexKey] = { status: "complete", built_at: env.now().toISOString(), count: cp.rows, sha256, bytes };
    await env.saveManifest();
  }

  const failed = cp.units.filter((unit) => unit.state === "failed" || unit.state === "unavailable");
  await env.audit({
    type: spec.name,
    phase: "fetch",
    pages: cp.pages,
    files: 0,
    bytes: cp.bytes,
    rows: cp.rows,
    outcome: failed.length > 0 ? "error" : "success",
    errorText: failed.length > 0 ? failed.map((unit) => unit.reason ?? "failed").join(", ") : undefined,
  });
  return cp;
}
