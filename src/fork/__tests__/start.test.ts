import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfigureAudit, mockCreateNeon } = vi.hoisted(() => ({
  mockConfigureAudit: vi.fn(),
  mockCreateNeon: vi.fn(() => ({ append: vi.fn(), read: vi.fn() })),
}));

vi.mock("../../utils/auditLog.js", () => ({
  configureAudit: mockConfigureAudit,
}));

vi.mock("../neonAuditSink.js", () => ({
  createNeonAuditSink: mockCreateNeon,
}));

import { applyNeonAuditFromEnv } from "../start.js";

describe("applyNeonAuditFromEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leaves the file sink when DATABASE_URL is unset", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(applyNeonAuditFromEnv({})).toBe(false);
    expect(mockConfigureAudit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("~/.clio-mcp/audit.log"));
    log.mockRestore();
  });

  it("configures the Neon sink when DATABASE_URL is set", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = { append: vi.fn(), read: vi.fn() };
    mockCreateNeon.mockReturnValueOnce(sink);
    expect(applyNeonAuditFromEnv({ DATABASE_URL: "  postgres://neon/db  " })).toBe(true);
    expect(mockCreateNeon).toHaveBeenCalledWith("postgres://neon/db");
    expect(mockConfigureAudit).toHaveBeenCalledWith({ sink });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Neon"));
    log.mockRestore();
  });
});
