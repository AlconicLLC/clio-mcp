/**
 * Optional Postgres audit sink for hosted deploys (Railway + Neon, etc.).
 *
 * This module is not imported by the default `build/index.js` entrypoint, so
 * pulling upstream into a fork cannot reset the log location. Hosts start via
 * `build/fork/start.js` and set DATABASE_URL.
 */
import pg from "pg";
import type { AuditEntry, AuditFilter, AuditSink } from "../utils/auditLog.js";

export type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

const OUTCOMES = new Set<AuditEntry["outcome"]>(["success", "error", "not_found"]);

function asOutcome(value: unknown): AuditEntry["outcome"] {
  const raw = typeof value === "string" ? value : "";
  return OUTCOMES.has(raw as AuditEntry["outcome"]) ? (raw as AuditEntry["outcome"]) : "error";
}

function asIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

function asArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* fall through */ }
  }
  return {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function rowToEntry(row: Record<string, unknown>): AuditEntry {
  return {
    timestamp: asIsoTimestamp(row.timestamp),
    session_id: typeof row.session_id === "string" ? row.session_id : "",
    ...(optionalString(row.machine_ip) && { machine_ip: optionalString(row.machine_ip) }),
    ...(optionalString(row.user_id) && { user_id: optionalString(row.user_id) }),
    ...(optionalString(row.request_id) && { request_id: optionalString(row.request_id) }),
    tool: typeof row.tool === "string" ? row.tool : "",
    args: asArgs(row.args),
    outcome: asOutcome(row.outcome),
    ...(optionalString(row.error_message) && { error_message: optionalString(row.error_message) }),
    ...(optionalString(row.clio_user_id) && { clio_user_id: optionalString(row.clio_user_id) }),
    ...(optionalNumber(row.matter_id) !== undefined && { matter_id: optionalNumber(row.matter_id) }),
    ...(optionalNumber(row.result_count) !== undefined && { result_count: optionalNumber(row.result_count) }),
  };
}

function buildWhere(filter: AuditFilter): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const placeholder = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter.date_from) {
    clauses.push(`timestamp >= ${placeholder(filter.date_from)}::date`);
  }
  if (filter.date_to) {
    clauses.push(`timestamp < (${placeholder(filter.date_to)}::date + interval '1 day')`);
  }
  if (filter.matter_id !== undefined) {
    clauses.push(`matter_id = ${placeholder(filter.matter_id)}`);
  }
  if (filter.session_id) {
    clauses.push(`session_id = ${placeholder(filter.session_id)}`);
  }
  if (filter.user_id) {
    clauses.push(`user_id = ${placeholder(filter.user_id)}`);
  }
  if (filter.tool) {
    clauses.push(`tool = ${placeholder(filter.tool)}`);
  }
  if (filter.outcome) {
    clauses.push(`outcome = ${placeholder(filter.outcome)}`);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/**
 * Postgres/Neon sink. Pass `pool` in tests; production constructs a Pool from DATABASE_URL.
 */
export function createNeonAuditSink(databaseUrl: string, pool?: Queryable): AuditSink {
  const db: Queryable = pool ?? new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
  });

  return {
    async append(entry: AuditEntry) {
      await db.query(
        `INSERT INTO audit_log
           (timestamp, session_id, machine_ip, user_id, request_id, tool, args,
            outcome, error_message, clio_user_id, matter_id, result_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [
          entry.timestamp,
          entry.session_id,
          entry.machine_ip ?? null,
          entry.user_id ?? null,
          entry.request_id ?? null,
          entry.tool,
          JSON.stringify(entry.args ?? {}),
          entry.outcome,
          entry.error_message ?? null,
          entry.clio_user_id ?? null,
          entry.matter_id ?? null,
          entry.result_count ?? null,
        ]
      );
    },

    async read(filter: AuditFilter & { limit: number; offset: number }) {
      const { sql, params } = buildWhere(filter);
      const countResult = await db.query(
        `SELECT count(*)::int AS n FROM audit_log ${sql}`,
        params
      );
      const total_matched = optionalNumber(countResult.rows[0]?.n) ?? 0;

      const pageParams = [...params, filter.limit, filter.offset];
      const limitPh = `$${pageParams.length - 1}`;
      const offsetPh = `$${pageParams.length}`;
      const rowsResult = await db.query(
        `SELECT timestamp, session_id, machine_ip, user_id, request_id, tool, args,
                outcome, error_message, clio_user_id, matter_id, result_count
           FROM audit_log ${sql}
          ORDER BY timestamp DESC
          LIMIT ${limitPh} OFFSET ${offsetPh}`,
        pageParams
      );

      return {
        total_matched,
        entries: rowsResult.rows.map(rowToEntry),
      };
    },
  };
}
