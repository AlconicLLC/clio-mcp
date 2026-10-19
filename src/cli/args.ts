import path from "path";
import {
  DEFAULT_EXPORT_TYPES,
  OPTIONAL_EXPORT_TYPES,
  NOT_EXPORTED_TYPES,
} from "../export/typeNames.js";

export const EXIT = {
  OK: 0,
  DONE_WITH_ERRORS: 1,
  USAGE: 2,
  NOT_LOGGED_IN: 3,
  INTERRUPTED: 4,
  FATAL: 5,
} as const;

export const DEFAULT_RATE = 0.8;
export const MAX_RATE = 10;
export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;

export interface SinceInstant {
  input: string;
  iso: string;
  kind: "date" | "datetime";
}

export type SinceResult = { ok: true; since: SinceInstant } | { ok: false; message: string };

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

function isRealDate(year: number, month: number, day: number): boolean {
  if (year < 1900) return false;
  const t = new Date(Date.UTC(year, month - 1, day));
  return t.getUTCFullYear() === year && t.getUTCMonth() === month - 1 && t.getUTCDate() === day;
}

export function parseSince(input: string): SinceResult {
  const invalid: SinceResult = {
    ok: false,
    message: "Invalid --since value: use a date (YYYY-MM-DD) or a full ISO datetime with offset (2026-03-10T09:00:00+02:00).",
  };

  const dateOnly = DATE_ONLY.exec(input);
  if (dateOnly) {
    const [year, month, day] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    if (!isRealDate(year, month, day)) return invalid;
    const iso = new Date(Date.UTC(year, month - 1, day) - DAY_MS).toISOString();
    return { ok: true, since: { input, iso, kind: "date" } };
  }

  const dateTime = DATE_TIME.exec(input);
  if (!dateTime) return invalid;

  const [year, month, day, hour, minute] = dateTime.slice(1, 6).map(Number);
  const second = dateTime[6] === undefined ? 0 : Number(dateTime[6]);
  const millis = dateTime[7] === undefined ? 0 : Number(dateTime[7].padEnd(3, "0"));
  if (!isRealDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return invalid;

  let offsetMinutes = 0;
  const zone = dateTime[8];
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return invalid;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
  return { ok: true, since: { input, iso: new Date(utc).toISOString(), kind: "datetime" } };
}

export interface ExportArgs {
  out: string;
  since: SinceInstant | null;
  only: string[] | null;
  notExported: string[];
  documents: boolean;
  rate: number;
  concurrency: number;
  resume: boolean;
  dryRun: boolean;
}

export type ExportParseResult =
  | { ok: true; help: false; args: ExportArgs }
  | { ok: true; help: true }
  | { ok: false; message: string };

const VALUE_FLAGS = new Set(["out", "since", "only", "rate", "concurrency"]);
const BOOLEAN_FLAGS = new Set(["no-documents", "resume", "dry-run"]);
const EXPORTABLE = new Set<string>([...DEFAULT_EXPORT_TYPES, ...OPTIONAL_EXPORT_TYPES]);
const NOT_EXPORTED = new Set<string>(NOT_EXPORTED_TYPES);

function fail(message: string): ExportParseResult {
  return { ok: false, message };
}

function parseNumber(value: string, name: string, pattern: RegExp): number | string {
  if (!pattern.test(value)) return `Invalid --${name} value.`;
  return Number(value);
}

export function parseExportArgs(argv: readonly string[]): ExportParseResult {
  if (argv.includes("--help") || argv.includes("-h")) return { ok: true, help: true };

  const values = new Map<string, string>();
  const switches = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      return fail(token.startsWith("-") ? `Unknown option: ${token}` : `Unexpected argument: ${token}`);
    }

    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) return fail(`Option --${name} does not take a value.`);
      if (switches.has(name)) return fail(`Option --${name} was given more than once.`);
      switches.add(name);
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      if (values.has(name)) return fail(`Option --${name} was given more than once.`);
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) return fail(`Option --${name} needs a value.`);
        value = next;
        i++;
      }
      values.set(name, value);
      continue;
    }

    return fail(`Unknown option: --${name}`);
  }

  const outValue = values.get("out");
  if (outValue === undefined || outValue.trim() === "") return fail("Missing required option --out <folder>.");

  let since: SinceInstant | null = null;
  const sinceValue = values.get("since");
  if (sinceValue !== undefined) {
    const parsed = parseSince(sinceValue);
    if (!parsed.ok) return fail(parsed.message);
    since = parsed.since;
  }

  let only: string[] | null = null;
  let notExported: string[] = [];
  const onlyValue = values.get("only");
  if (onlyValue !== undefined) {
    const names = [...new Set(onlyValue.split(",").map((n) => n.trim().toLowerCase()).filter((n) => n !== ""))];
    if (names.length === 0) return fail("Option --only needs at least one record type.");
    const unknown = names.filter((n) => !EXPORTABLE.has(n) && !NOT_EXPORTED.has(n));
    if (unknown.length > 0) {
      return fail(
        `Unknown record type in --only: ${unknown.join(", ")}. Valid types: ${[...EXPORTABLE, ...NOT_EXPORTED].join(", ")}.`
      );
    }
    notExported = names.filter((n) => NOT_EXPORTED.has(n));
    only = names.filter((n) => EXPORTABLE.has(n));
    if (only.length === 0) {
      return fail(`${notExported.join(", ")} is not exported in this version, so there is nothing to export.`);
    }
  }

  const documents = !switches.has("no-documents");
  if (!documents && only !== null && (only.includes("documents") || only.includes("document_versions"))) {
    return fail("Option --no-documents conflicts with --only documents or document_versions.");
  }

  if (only !== null && only.includes("document_versions") && !only.includes("documents")) {
    return fail("Option --only document_versions needs documents as well.");
  }

  let rate = DEFAULT_RATE;
  const rateValue = values.get("rate");
  if (rateValue !== undefined) {
    const parsed = parseNumber(rateValue, "rate", /^\d+(\.\d+)?$/);
    if (typeof parsed === "string") return fail(parsed);
    if (!(parsed > 0 && parsed <= MAX_RATE)) return fail(`Option --rate must be greater than 0 and at most ${MAX_RATE} requests per second.`);
    rate = parsed;
  }

  let concurrency = DEFAULT_CONCURRENCY;
  const concurrencyValue = values.get("concurrency");
  if (concurrencyValue !== undefined) {
    const parsed = parseNumber(concurrencyValue, "concurrency", /^\d+$/);
    if (typeof parsed === "string") return fail(parsed);
    if (parsed < 1 || parsed > MAX_CONCURRENCY) return fail(`Option --concurrency must be between 1 and ${MAX_CONCURRENCY}.`);
    concurrency = parsed;
  }

  const resume = switches.has("resume");
  const dryRun = switches.has("dry-run");
  if (resume && dryRun) return fail("Options --resume and --dry-run cannot be combined.");

  return {
    ok: true,
    help: false,
    args: { out: path.resolve(outValue), since, only, notExported, documents, rate, concurrency, resume, dryRun },
  };
}
