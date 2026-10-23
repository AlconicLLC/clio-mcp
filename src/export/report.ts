import { formatBytes, formatDuration } from "./progress.js";
import type { ErrorGroup } from "./errors.js";

export type TypeStatus = "COMPLETE" | "INCOMPLETE" | "NOT VERIFIED" | "NOT AVAILABLE" | "NOT EXPORTED";

export interface TypeLine {
  name: string;
  status: TypeStatus;
  rows: number | null;
  expected: number | null;
  required: boolean;
  notes: string[];
}

export interface DocumentSummary {
  downloaded: number;
  unchanged: number;
  moved: number;
  failed: number;
  noVersion: number;
  bytes: number;
  orphans: number;
  unresolvedParents: number;
  unfiled: string;
  wouldDownload?: number;
}

export interface SinceCoverage {
  filtered: string[];
  full: string[];
  calendar: boolean;
}

/** One line per type, identical in the terminal summary and in REPORT.md. Counts and reason codes only. */
export function describeLine(t: TypeLine): string {
  return `${t.name}: ${t.status}${t.notes.length > 0 ? ` - ${t.notes.join("; ")}` : ""}`;
}

export interface ReportInput {
  mode: "export" | "dry-run";
  verdict: "COMPLETE" | "INCOMPLETE" | "INTERRUPTED" | "NOT STARTED" | "DRY RUN";
  reasons: string[];
  version: string;
  region: string;
  startedAt: string;
  finishedAt: string;
  since: string | null;
  types: TypeLine[];
  documents: DocumentSummary | null;
  errors: ErrorGroup[];
  notExported: string[];
  notes: string[];
  matterIndexBuiltAt: string | null;
  matterCount: number | null;
  sinceCoverage?: SinceCoverage;
  estimate?: {
    requests: number;
    seconds: number;
    rate: number;
    bytes: number;
    freeBytes: number | null;
    diskWarning: boolean;
  };
}

const cell = (value: number | null) => (value === null ? "n/a" : String(value));

export function renderReport(input: ReportInput): string {
  const out: string[] = [];
  out.push("# Clio export report", "");
  out.push(`- Result: **${input.verdict}**`);
  for (const reason of input.reasons) out.push(`  - ${reason}`);
  out.push(`- Mode: ${input.mode === "dry-run" ? "dry run (counts only, nothing was exported)" : "export"}`);
  out.push(`- Connector version: ${input.version}`);
  out.push(`- Clio region: ${input.region}`);
  out.push(`- Started: ${input.startedAt}`);
  out.push(`- Finished: ${input.finishedAt}`);
  out.push(`- Records changed since: ${input.since ?? "all records"}`);
  if (input.matterIndexBuiltAt) out.push(`- Matter index built: ${input.matterIndexBuiltAt} (${cell(input.matterCount)} matters)`);
  out.push("");

  if (input.estimate) {
    const e = input.estimate;
    out.push("## Estimate for the full run", "");
    out.push(`- Requests: about ${e.requests}`);
    out.push(`- Time at ${e.rate} requests per second: about ${formatDuration(e.seconds)}`);
    out.push(`- Document bytes: about ${formatBytes(e.bytes)}`);
    out.push(`- Free disk space in the output folder: ${e.freeBytes === null ? "unknown" : formatBytes(e.freeBytes)}`);
    if (e.diskWarning) out.push("- **Warning: the free space looks too small for this export.**");
    out.push("");
  }

  out.push("## Record types", "");
  out.push("| Type | Status | Rows | Clio count | Notes |", "|---|---|---|---|---|");
  for (const t of input.types) {
    out.push(`| ${t.name} | ${t.status} | ${cell(t.rows)} | ${cell(t.expected)} | ${t.notes.join("; ")} |`);
  }
  out.push("");

  if (input.documents) {
    const d = input.documents;
    if (input.mode === "dry-run") {
      out.push("## Documents (estimate)", "");
      out.push(`- Would download: ${d.wouldDownload ?? d.downloaded} files, ${formatBytes(d.bytes)} (${d.bytes} bytes)`);
      out.push(`- Without a file version (nothing to download): ${d.noVersion}`);
      out.push(`- Documents outside any matter: ${d.unfiled}`);
      out.push("- Already on disk, moved, failed, orphans and unresolved folders: n/a in a dry run");
    } else {
      out.push("## Documents", "");
      out.push(`- Downloaded this run: ${d.downloaded} (${formatBytes(d.bytes)})`);
      out.push(`- Already on disk and unchanged: ${d.unchanged}`);
      out.push(`- Moved after a rename: ${d.moved}`);
      out.push(`- Failed: ${d.failed}`);
      out.push(`- Without a file version (nothing to download): ${d.noVersion}`);
      out.push(`- Orphans (kept on disk, no longer in Clio): ${d.orphans}`);
      out.push(`- Documents whose folder could not be resolved (placed at the matter root): ${d.unresolvedParents}`);
      out.push(`- Documents outside any matter: ${d.unfiled}`);
    }
    out.push("");
  }

  if (input.since && input.sinceCoverage) {
    const c = input.sinceCoverage;
    out.push("## Since filter", "");
    out.push(`- Records changed after ${input.since} are exported for: ${c.filtered.join(", ") || "none"}.`);
    out.push(`- Exported in full, because there is no confirmed updated_since filter for them: ${c.full.join(", ") || "none"}.`);
    out.push("- Folders are always exported in full, because the folder tree is needed for document paths.");
    out.push("- Documents are checked for every matter in the index, not only matters changed since the date.");
    if (c.calendar) out.push("- Calendar entries that start before the since year are not included.");
    if (input.mode === "export") out.push("- Orphan detection was not evaluated with a since filter.");
    out.push("");
  }

  if (input.errors.length > 0) {
    out.push("## Errors", "", "| Type | Status | Kind | Count |", "|---|---|---|---|");
    for (const e of input.errors) out.push(`| ${e.type} | ${e.status ?? "n/a"} | ${e.kind} | ${e.count} |`);
    out.push("");
  }

  if (input.notExported.length > 0) {
    out.push("## Not exported in this version", "");
    for (const name of input.notExported) out.push(`- ${name}`);
    out.push("");
  }

  if (input.notes.length > 0) {
    out.push("## Notes", "");
    for (const note of input.notes) out.push(`- ${note}`);
    out.push("");
  }
  return `${out.join("\n")}\n`;
}
