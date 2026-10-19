import { appendAuditLog } from "../utils/auditLog.js";
import type { AuditInput } from "./env.js";

export function createAuditor(opts: { clioUserId: string | null; since: string | null; dryRun: boolean }) {
  return async (entry: AuditInput): Promise<void> => {
    await appendAuditLog({
      tool: "export",
      args: {
        type: entry.type,
        phase: entry.phase,
        pages: entry.pages,
        files: entry.files,
        bytes: entry.bytes,
        since: opts.since ?? undefined,
        dry_run: opts.dryRun,
      },
      outcome: entry.outcome,
      result_count: entry.rows,
      ...(entry.errorText ? { error_message: entry.errorText } : {}),
      ...(opts.clioUserId ? { clio_user_id: opts.clioUserId } : {}),
    });
  };
}
