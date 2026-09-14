import { describe, it, expect, vi, beforeEach } from "vitest";
import { createNeonAuditSink } from "../neonAuditSink.js";
import type { AuditEntry } from "../../utils/auditLog.js";

function mockPool() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { query };
}

const sample: AuditEntry = {
  timestamp: "2026-09-14T12:00:00.000Z",
  session_id: "sess-1",
  tool: "get_matter",
  args: { matter_id: 4821, query: "[redacted]" },
  outcome: "success",
  clio_user_id: "10023",
  matter_id: 4821,
  result_count: 1,
};

describe("createNeonAuditSink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts an allowlisted audit row", async () => {
    const pool = mockPool();
    const sink = createNeonAuditSink("postgres://unused", pool);
    await sink.append(sample);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO audit_log/i);
    expect(params[0]).toBe(sample.timestamp);
    expect(params[1]).toBe("sess-1");
    expect(params[5]).toBe("get_matter");
    expect(params[6]).toBe(JSON.stringify(sample.args));
    expect(params[7]).toBe("success");
    expect(params[9]).toBe("10023");
    expect(params[10]).toBe(4821);
    expect(params[11]).toBe(1);
  });

  it("maps filters onto parameterized WHERE clauses", async () => {
    const pool = mockPool();
    pool.query
      .mockResolvedValueOnce({ rows: [{ n: 2 }] })
      .mockResolvedValueOnce({
        rows: [{
          timestamp: new Date("2026-09-14T12:00:00.000Z"),
          session_id: "sess-1",
          tool: "get_matter",
          args: { matter_id: 4821 },
          outcome: "success",
          matter_id: 4821,
          result_count: 1,
        }],
      });
    const sink = createNeonAuditSink("postgres://unused", pool);
    const result = await sink.read({
      date_from: "2026-09-01",
      date_to: "2026-09-30",
      matter_id: 4821,
      session_id: "sess-1",
      user_id: "host-user",
      limit: 50,
      offset: 10,
    });

    const [countSql, countParams] = pool.query.mock.calls[0];
    expect(countSql).toContain("WHERE");
    expect(countSql).toContain("timestamp >=");
    expect(countSql).toContain("matter_id =");
    expect(countSql).toContain("session_id =");
    expect(countSql).toContain("user_id =");
    expect(countParams).toEqual(["2026-09-01", "2026-09-30", 4821, "sess-1", "host-user"]);

    const [pageSql, pageParams] = pool.query.mock.calls[1];
    expect(pageSql).toMatch(/LIMIT \$6 OFFSET \$7/);
    expect(pageParams.slice(-2)).toEqual([50, 10]);

    expect(result.total_matched).toBe(2);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      session_id: "sess-1",
      tool: "get_matter",
      outcome: "success",
      matter_id: 4821,
      args: { matter_id: 4821 },
    });
    expect(result.entries[0].timestamp).toBe("2026-09-14T12:00:00.000Z");
  });

  it("maps tool and outcome onto WHERE clauses", async () => {
    const pool = mockPool();
    pool.query
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    const sink = createNeonAuditSink("postgres://unused", pool);
    await sink.read({
      tool: "get_matter",
      outcome: "error",
      limit: 10,
      offset: 0,
    });
    const [countSql, countParams] = pool.query.mock.calls[0];
    expect(countSql).toContain("tool =");
    expect(countSql).toContain("outcome =");
    expect(countParams).toEqual(["get_matter", "error"]);
  });

  it("reads with no filters", async () => {
    const pool = mockPool();
    pool.query
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    const sink = createNeonAuditSink("postgres://unused", pool);
    const result = await sink.read({ limit: 500, offset: 0 });
    expect(pool.query.mock.calls[0][0]).not.toContain("WHERE");
    expect(result).toEqual({ total_matched: 0, entries: [] });
  });
});
