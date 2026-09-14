/**
 * Temporary audit viewer, hosted inside this repo until it moves to
 * clio-mcp-audit-ui. Served at GET /audit on the HTTP transport.
 *
 * The HTML shell is public so a browser can load it. /audit/api/* uses the
 * same MCP_API_KEY gate as /mcp.
 */
import { readFileSync } from "fs";
import type express from "express";
import { WRITE_TOOLS } from "../../tools/index.js";
import { readAuditLog } from "../../utils/auditLog.js";
import type { AuditEntry, AuditFilter } from "../../utils/auditLog.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOMES = new Set<AuditEntry["outcome"]>(["success", "error", "not_found"]);
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export class AuditQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditQueryError";
  }
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim() || undefined;
  return undefined;
}

function parseLimit(value: unknown, fallback: number): number {
  const raw = firstString(value);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new AuditQueryError("limit must be an integer from 1 to 1000");
  }
  return n;
}

function parseOffset(value: unknown): number {
  const raw = firstString(value);
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new AuditQueryError("offset must be an integer >= 0");
  }
  return n;
}

/** Parse /audit/api query parameters into an AuditFilter. Throws AuditQueryError. */
export function parseAuditQuery(query: Record<string, unknown>): AuditFilter {
  const filter: AuditFilter = {};
  const date_from = firstString(query.date_from);
  const date_to = firstString(query.date_to);
  if (date_from) {
    if (!DATE.test(date_from)) throw new AuditQueryError("date_from must be YYYY-MM-DD");
    filter.date_from = date_from;
  }
  if (date_to) {
    if (!DATE.test(date_to)) throw new AuditQueryError("date_to must be YYYY-MM-DD");
    filter.date_to = date_to;
  }

  const matterRaw = firstString(query.matter_id);
  if (matterRaw) {
    const matter_id = Number(matterRaw);
    if (!Number.isInteger(matter_id) || matter_id < 1) {
      throw new AuditQueryError("matter_id must be a positive integer");
    }
    filter.matter_id = matter_id;
  }

  const tool = firstString(query.tool);
  if (tool) {
    if (!TOOL_NAME.test(tool)) throw new AuditQueryError("tool must be a snake_case tool name");
    filter.tool = tool;
  }

  const outcome = firstString(query.outcome);
  if (outcome) {
    if (!OUTCOMES.has(outcome as AuditEntry["outcome"])) {
      throw new AuditQueryError("outcome must be success, error, or not_found");
    }
    filter.outcome = outcome as AuditEntry["outcome"];
  }

  const session_id = firstString(query.session_id);
  if (session_id) filter.session_id = session_id;

  filter.limit = parseLimit(query.limit, 100);
  filter.offset = parseOffset(query.offset);
  return filter;
}

export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CSV_COLUMNS = [
  "timestamp",
  "tool",
  "outcome",
  "matter_id",
  "session_id",
  "clio_user_id",
  "user_id",
  "request_id",
  "result_count",
  "error_message",
  "args_json",
] as const;

export function entriesToCsv(entries: AuditEntry[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = entries.map((entry) =>
    [
      csvCell(entry.timestamp),
      csvCell(entry.tool),
      csvCell(entry.outcome),
      csvCell(entry.matter_id),
      csvCell(entry.session_id),
      csvCell(entry.clio_user_id),
      csvCell(entry.user_id),
      csvCell(entry.request_id),
      csvCell(entry.result_count),
      csvCell(entry.error_message),
      csvCell(entry.args),
    ].join(",")
  );
  return [header, ...rows].join("\n") + (entries.length ? "\n" : "");
}

function pageStats(entries: AuditEntry[]) {
  let success = 0;
  let error = 0;
  let not_found = 0;
  let writes = 0;
  for (const entry of entries) {
    if (entry.outcome === "success") success += 1;
    else if (entry.outcome === "error") error += 1;
    else if (entry.outcome === "not_found") not_found += 1;
    if (WRITE_TOOLS.has(entry.tool)) writes += 1;
  }
  return { success, error, not_found, writes };
}

function loadHtml(): string {
  return readFileSync(new URL("./index.html", import.meta.url), "utf8");
}

function sendQueryError(res: express.Response, err: unknown): void {
  if (err instanceof AuditQueryError) {
    res.status(400).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Failed to read audit log";
  res.status(500).json({ error: message });
}

/** Register GET /audit and GET /audit/api/* on the HTTP app. */
export function mountAuditUi(app: express.Express): void {
  const html = loadHtml();

  const sendHtml: express.RequestHandler = (_req, res) => {
    res.type("html").send(html);
  };
  app.get("/audit", sendHtml);
  app.get("/audit/", sendHtml);

  app.get("/audit/api/entries", async (req, res) => {
    try {
      const filter = parseAuditQuery(req.query as Record<string, unknown>);
      const result = await readAuditLog(filter);
      const entries = [...result.entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      res.json({
        entries,
        total_matched: result.total_matched,
        truncated: result.truncated,
        offset: filter.offset ?? 0,
        limit: filter.limit ?? 100,
        page_stats: pageStats(entries),
      });
    } catch (err) {
      sendQueryError(res, err);
    }
  });

  app.get("/audit/api/export", async (req, res) => {
    try {
      const filter = parseAuditQuery(req.query as Record<string, unknown>);
      filter.limit = Math.min(filter.limit ?? 1000, 1000);
      filter.offset = 0;
      const result = await readAuditLog(filter);
      const entries = [...result.entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const format = (firstString(req.query.format) ?? "jsonl").toLowerCase();
      const stamp = new Date().toISOString().slice(0, 10);

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="clio-mcp-audit-${stamp}.csv"`);
        res.send(entriesToCsv(entries));
        return;
      }
      if (format !== "jsonl") {
        res.status(400).json({ error: "format must be jsonl or csv" });
        return;
      }
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="clio-mcp-audit-${stamp}.jsonl"`);
      res.send(entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""));
    } catch (err) {
      sendQueryError(res, err);
    }
  });
}
