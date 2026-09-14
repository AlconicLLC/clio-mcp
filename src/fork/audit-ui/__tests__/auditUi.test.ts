import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import type express from "express";
import { vi } from "vitest";

vi.mock("@napi-rs/keyring", () => ({
  Entry: vi.fn().mockImplementation(function () {
    return { getPassword: () => null, setPassword: () => {} };
  }),
}));

import { createApp } from "../../../server/http.js";
import { configureAudit, resetAudit } from "../../../utils/auditLog.js";
import type { AuditEntry, AuditSink } from "../../../utils/auditLog.js";
import {
  parseAuditQuery,
  AuditQueryError,
  csvCell,
  entriesToCsv,
} from "../mount.js";

const KEY = "k".repeat(32);

function memorySink(seed: AuditEntry[] = []) {
  const entries = [...seed];
  const sink: AuditSink = {
    async append(e) { entries.push(e); },
    async read(filter) {
      const matched = entries.filter((e) => {
        if (filter.date_from && e.timestamp.slice(0, 10) < filter.date_from) return false;
        if (filter.date_to && e.timestamp.slice(0, 10) > filter.date_to) return false;
        if (filter.matter_id !== undefined && e.matter_id !== filter.matter_id) return false;
        if (filter.tool && e.tool !== filter.tool) return false;
        if (filter.outcome && e.outcome !== filter.outcome) return false;
        return true;
      });
      return {
        entries: matched.slice(filter.offset, filter.offset + filter.limit),
        total_matched: matched.length,
      };
    },
  };
  return sink;
}

function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const sample: AuditEntry[] = [
  {
    timestamp: "2026-09-14T12:00:00.000Z",
    session_id: "sess-aaaa",
    tool: "get_matter",
    args: { matter_id: 4821 },
    outcome: "success",
    matter_id: 4821,
    result_count: 1,
  },
  {
    timestamp: "2026-09-14T13:00:00.000Z",
    session_id: "sess-bbbb",
    tool: "create_note",
    args: { matter_id: 4821, subject: "[redacted]" },
    outcome: "error",
    error_message: "Clio 422",
    matter_id: 4821,
  },
  {
    timestamp: "2026-09-13T09:00:00.000Z",
    session_id: "sess-cccc",
    tool: "list_matters",
    args: { status: "open", limit: 10 },
    outcome: "success",
    result_count: 10,
  },
];

describe("parseAuditQuery", () => {
  it("accepts allowlisted filters and defaults pagination", () => {
    expect(parseAuditQuery({
      date_from: "2026-09-01",
      date_to: "2026-09-30",
      matter_id: "4821",
      tool: "get_matter",
      outcome: "error",
    })).toEqual({
      date_from: "2026-09-01",
      date_to: "2026-09-30",
      matter_id: 4821,
      tool: "get_matter",
      outcome: "error",
      limit: 100,
      offset: 0,
    });
  });

  it("rejects malformed values", () => {
    expect(() => parseAuditQuery({ date_from: "09/14/2026" })).toThrow(AuditQueryError);
    expect(() => parseAuditQuery({ matter_id: "0" })).toThrow(/positive integer/);
    expect(() => parseAuditQuery({ outcome: "ok" })).toThrow(/outcome/);
    expect(() => parseAuditQuery({ tool: "../etc/passwd" })).toThrow(/tool/);
    expect(() => parseAuditQuery({ limit: "0" })).toThrow(/limit/);
  });
});

describe("CSV helpers", () => {
  it("quotes commas and quotes", () => {
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell(null)).toBe("");
  });

  it("emits a header row and JSON args", () => {
    const csv = entriesToCsv([sample[1]]);
    expect(csv).toContain("timestamp,tool,outcome");
    expect(csv).toContain("create_note");
    expect(csv).toContain("Clio 422");
    expect(csv).toContain("subject");
  });
});

describe("audit UI HTTP API", () => {
  let srv: { base: string; close: () => Promise<void> };

  beforeAll(async () => {
    configureAudit({ sink: memorySink(sample) });
    srv = await listen(createApp({ apiKey: KEY }));
  });
  afterAll(async () => {
    await srv.close();
    resetAudit();
  });

  it("returns newest-first entries with page stats when authorized", async () => {
    const res = await fetch(`${srv.base}/audit/api/entries?limit=10`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total_matched).toBe(3);
    expect(body.entries.map((e: AuditEntry) => e.tool)).toEqual([
      "create_note",
      "get_matter",
      "list_matters",
    ]);
    expect(body.page_stats).toEqual({ success: 2, error: 1, not_found: 0, writes: 1 });
  });

  it("filters by tool", async () => {
    const res = await fetch(`${srv.base}/audit/api/entries?tool=get_matter`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const body = await res.json();
    expect(body.total_matched).toBe(1);
    expect(body.entries[0].tool).toBe("get_matter");
  });

  it("rejects a bad date with 400", async () => {
    const res = await fetch(`${srv.base}/audit/api/entries?date_from=yesterday`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "date_from must be YYYY-MM-DD" });
  });

  it("exports JSONL and CSV", async () => {
    const jsonl = await fetch(`${srv.base}/audit/api/export?format=jsonl`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(jsonl.status).toBe(200);
    expect(jsonl.headers.get("content-disposition")).toMatch(/clio-mcp-audit/);
    const lines = (await jsonl.text()).trim().split("\n");
    expect(lines).toHaveLength(3);

    const csv = await fetch(`${srv.base}/audit/api/export?format=csv`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(csv.headers.get("content-type")).toMatch(/csv/);
    const text = await csv.text();
    expect(text.split("\n")[0]).toContain("timestamp,tool,outcome");
    expect(text).toContain("create_note");
  });
});
