/**
 * Hosted entrypoint: configure a Neon/Postgres audit sink, then start the
 * normal server. Railway (or similar) should run:
 *
 *   node build/fork/start.js
 *
 * with DATABASE_URL set. The default `npm start` / `build/index.js` path is
 * unchanged, so merging upstream cannot reset the audit destination.
 */
import { pathToFileURL } from "node:url";
import { configureAudit } from "../utils/auditLog.js";
import { createNeonAuditSink } from "./neonAuditSink.js";

/** Wire DATABASE_URL to the audit sink. Returns true when Neon is in use. */
export function applyNeonAuditFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = (env.DATABASE_URL ?? "").trim();
  if (!url) {
    console.error("[startup] Audit sink: file (~/.clio-mcp/audit.log). Set DATABASE_URL to use Neon.");
    return false;
  }
  configureAudit({ sink: createNeonAuditSink(url) });
  console.error("[startup] Audit sink: Neon (DATABASE_URL)");
  return true;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  applyNeonAuditFromEnv();
  await import("../index.js");
}
