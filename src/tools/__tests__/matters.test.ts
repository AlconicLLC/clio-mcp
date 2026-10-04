import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockClioPost, mockClioGet, mockClioPatch, mockClioGetAllPages, mockAppendAuditLog, MockClioApiError } = vi.hoisted(() => {
  class MockClioApiError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.name = "ClioApiError";
    }
  }
  return {
    mockClioPost: vi.fn(),
    mockClioGet: vi.fn(),
    mockClioPatch: vi.fn(),
    mockClioGetAllPages: vi.fn().mockResolvedValue([]),
    mockAppendAuditLog: vi.fn(),
    MockClioApiError,
  };
});

vi.mock("../../utils/clioClient.js", () => ({
  clioPost: mockClioPost,
  clioGet: mockClioGet,
  clioPatch: mockClioPatch,
  clioGetAllPages: mockClioGetAllPages,
  // Thin passthrough: the fallback path itself is covered in
  // utils/__tests__/clioClientFieldFallback.test.ts against the real helper.
  clioGetWithFieldFallback: async (path: string, params: any) => ({ body: await mockClioGet(path, params) }),
  ClioApiError: MockClioApiError,
  extractNextPageToken: (meta: any) => {
    const nextUrl = meta?.paging?.next;
    if (!nextUrl) return null;
    try { return new URL(nextUrl).searchParams.get("page_token"); }
    catch { return null; }
  },
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerMatterTools } from "../matters.js";

const handlers: Record<string, Function> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: Function) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerMatterTools(fakeServer as any);
});

// Minimal valid args with defaults applied (matching Zod defaults: status "open", billable true)
const MIN_ARGS = { client_id: 1, description: "Test matter", status: "open" as const, billable: true };

const MOCK_MATTER = {
  id: 42,
  display_number: "00042-001",
  description: "Test matter",
  status: "open",
  billable: true,
  client: { id: 1, name: "Acme Corp" },
  practice_area: null,
  responsible_attorney: null,
  originating_attorney: null,
  client_reference: null,
  open_date: "2026-05-21",
};

describe("list_matters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a JSON result with has_more: false when the page is empty, not a plain-text sentinel", async () => {
    mockClioGet.mockResolvedValue({ data: [], meta: { records: 0, paging: {} } });
    const result = await handlers["list_matters"]({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matters).toEqual([]);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
  });
});

describe("create_matter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClioPost.mockResolvedValue({ data: MOCK_MATTER });
  });

  // ─── Request body mapping ─────────────────────────────────────────────────

  describe("request body mapping", () => {
    it("sends client, description, status, billable, and open_date for minimal input", async () => {
      const _d = new Date();
      const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
      await handlers["create_matter"](MIN_ARGS);
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data).toMatchObject({
        client: { id: 1 },
        description: "Test matter",
        status: "open",
        billable: true,
        open_date: today,
      });
    });

    it("sends client as nested object with id", async () => {
      await handlers["create_matter"]({ ...MIN_ARGS, client_id: 99 });
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data.client).toEqual({ id: 99 });
    });

    it("sends practice_area as nested object when practice_area_id is provided", async () => {
      await handlers["create_matter"]({ ...MIN_ARGS, practice_area_id: 5 });
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data.practice_area).toEqual({ id: 5 });
    });

    it("sends responsible_attorney as nested object when responsible_attorney_id is provided", async () => {
      await handlers["create_matter"]({ ...MIN_ARGS, responsible_attorney_id: 7 });
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data.responsible_attorney).toEqual({ id: 7 });
    });

    it("sends originating_attorney as nested object when originating_attorney_id is provided", async () => {
      await handlers["create_matter"]({ ...MIN_ARGS, originating_attorney_id: 8 });
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data.originating_attorney).toEqual({ id: 8 });
    });

    it("sends the provided open_date instead of today", async () => {
      await handlers["create_matter"]({ ...MIN_ARGS, open_date: "2025-01-15" });
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data.open_date).toBe("2025-01-15");
    });

    it("sends today's date for open_date when omitted", async () => {
      const _d = new Date();
      const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
      await handlers["create_matter"](MIN_ARGS);
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data.open_date).toBe(today);
    });

    it("sends client_reference when provided", async () => {
      await handlers["create_matter"]({ ...MIN_ARGS, client_reference: "EXT-001" });
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data.client_reference).toBe("EXT-001");
    });

    it("sends custom fields in Clio's create shape", async () => {
      const cfv = [{ custom_field_id: 10, value: "Referral" }];
      await handlers["create_matter"]({ ...MIN_ARGS, custom_field_values: cfv });
      const body = mockClioPost.mock.calls[0][1] as any;
      // A matter being created has no existing values, so every write addresses
      // the field definition rather than a value-instance id.
      expect(body.data.custom_field_values).toEqual([{ custom_field: { id: 10 }, value: "Referral" }]);
    });
  });

  // ─── Optional field omission ──────────────────────────────────────────────

  describe("optional field omission", () => {
    it("omits practice_area when practice_area_id is not provided", async () => {
      await handlers["create_matter"](MIN_ARGS);
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data).not.toHaveProperty("practice_area");
    });

    it("omits responsible_attorney when responsible_attorney_id is not provided", async () => {
      await handlers["create_matter"](MIN_ARGS);
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data).not.toHaveProperty("responsible_attorney");
    });

    it("omits originating_attorney when originating_attorney_id is not provided", async () => {
      await handlers["create_matter"](MIN_ARGS);
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data).not.toHaveProperty("originating_attorney");
    });

    it("omits client_reference when not provided", async () => {
      await handlers["create_matter"](MIN_ARGS);
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data).not.toHaveProperty("client_reference");
    });

    it("omits custom_field_values when not provided", async () => {
      await handlers["create_matter"](MIN_ARGS);
      const body = mockClioPost.mock.calls[0][1] as any;
      expect(body.data).not.toHaveProperty("custom_field_values");
    });
  });

  // ─── Response mapping ──────────────────────────────────────────────────────

  describe("response mapping", () => {
    it("maps custom fields from the API response into the returned matter", async () => {
      mockClioPost.mockResolvedValue({
        data: {
          ...MOCK_MATTER,
          custom_field_values: [
            { id: "text_line-10", field_name: "Referral Source", field_type: "text_line", value: "Web", custom_field: { id: 10 } },
          ],
        },
      });
      const result = await handlers["create_matter"](MIN_ARGS) as any;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.matter.custom_fields).toEqual([
        { id: "text_line-10", field_id: 10, name: "Referral Source", type: "text_line", value: "Web", display_value: "Web" },
      ]);
    });

    it("falls back to an empty array when the API response omits custom fields", async () => {
      const result = await handlers["create_matter"](MIN_ARGS) as any;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.matter.custom_fields).toEqual([]);
    });
  });

  // ─── Audit log ───────────────────────────────────────────────────────────

  describe("audit log", () => {
    it("logs success with matter_id on successful creation", async () => {
      await handlers["create_matter"](MIN_ARGS);
      expect(mockAppendAuditLog).toHaveBeenCalledOnce();
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "success", matter_id: 42 }),
      );
    });

    it("logs error with error_message on generic failure", async () => {
      mockClioPost.mockRejectedValue(new Error("network failure"));
      await handlers["create_matter"](MIN_ARGS);
      expect(mockAppendAuditLog).toHaveBeenCalledOnce();
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "error", error_message: "network failure" }),
      );
    });

    it("logs error with error_message on ClioApiError 422", async () => {
      mockClioPost.mockRejectedValue(new MockClioApiError(422, "Client does not exist"));
      await handlers["create_matter"](MIN_ARGS);
      expect(mockAppendAuditLog).toHaveBeenCalledOnce();
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "error", error_message: "Client does not exist" }),
      );
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns Validation error prefix and isError for ClioApiError 422", async () => {
      mockClioPost.mockRejectedValue(new MockClioApiError(422, "Client does not exist"));
      const result = await handlers["create_matter"](MIN_ARGS) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^Validation error:/);
    });

    it("returns Error prefix and isError for generic errors", async () => {
      mockClioPost.mockRejectedValue(new Error("network failure"));
      const result = await handlers["create_matter"](MIN_ARGS) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^Error:/);
    });

    it("returns Error prefix and isError for non-422 ClioApiError", async () => {
      mockClioPost.mockRejectedValue(new MockClioApiError(500, "Internal server error"));
      const result = await handlers["create_matter"](MIN_ARGS) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^Error:/);
    });
  });
});

describe("list_matters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a picklist to its label rather than the option id", async () => {
    mockClioGet.mockResolvedValue({
      data: [{ ...MOCK_MATTER, custom_field_values: [
        { id: "picklist-9", field_name: "Case Type", field_type: "picklist", value: "9002", custom_field: { id: 9 }, picklist_option: { id: 9002, option: "Identity Theft" } },
      ] }],
    });
    const result = await handlers["list_matters"]({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matters[0].custom_fields[0]).toEqual({
      id: "picklist-9", field_id: 9, name: "Case Type", type: "picklist",
      value: "9002", display_value: "Identity Theft",
    });
  });

  it("falls back to an empty array when a matter has no custom fields", async () => {
    mockClioGet.mockResolvedValue({ data: [MOCK_MATTER] });
    const result = await handlers["list_matters"]({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matters[0].custom_fields).toEqual([]);
  });
});

describe("get_matter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps custom fields in the returned matter detail", async () => {
    mockClioGet.mockResolvedValue({
      data: { ...MOCK_MATTER, custom_field_values: [
        { id: "checkbox-2", field_name: "Police Report Filed", field_type: "checkbox", value: true, custom_field: { id: 2 } },
      ] },
    });
    const result = await handlers["get_matter"]({ matter_id: 42 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.custom_fields).toEqual([
      { id: "checkbox-2", field_id: 2, name: "Police Report Filed", type: "checkbox", value: true, display_value: true },
    ]);
  });
});

describe("update_matter", () => {
  const MIN_UPDATE_ARGS = { matter_id: 42 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClioPatch.mockResolvedValue({ data: MOCK_MATTER });
  });

  describe("guard clause", () => {
    it("returns an error and does not call clioPatch when no fields are provided", async () => {
      const result = await handlers["update_matter"](MIN_UPDATE_ARGS) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: at least one field to update must be provided");
      expect(mockClioPatch).not.toHaveBeenCalled();
    });
  });

  describe("request body mapping", () => {
    it("sends client as a nested object when client_id is provided", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, client_id: 5 });
      const body = mockClioPatch.mock.calls[0][1] as any;
      expect(body.data).toEqual({ client: { id: 5 } });
    });

    it("sends description when provided", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, description: "Updated desc" });
      expect(mockClioPatch.mock.calls[0][1].data).toEqual({ description: "Updated desc" });
    });

    it("sends practice_area as a nested object when practice_area_id is provided", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, practice_area_id: 9 });
      expect(mockClioPatch.mock.calls[0][1].data).toEqual({ practice_area: { id: 9 } });
    });

    it("sends status when provided", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, status: "closed" });
      expect(mockClioPatch.mock.calls[0][1].data).toEqual({ status: "closed" });
    });

    it("sends open_date when provided", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, open_date: "2025-02-01" });
      expect(mockClioPatch.mock.calls[0][1].data).toEqual({ open_date: "2025-02-01" });
    });

    it("sends billable: false explicitly (falsy value still sent)", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, billable: false });
      expect(mockClioPatch.mock.calls[0][1].data).toEqual({ billable: false });
    });

    it("sends responsible_attorney as a nested object when responsible_attorney_id is provided", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, responsible_attorney_id: 3 });
      expect(mockClioPatch.mock.calls[0][1].data).toEqual({ responsible_attorney: { id: 3 } });
    });

    it("sends originating_attorney as a nested object when originating_attorney_id is provided", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, originating_attorney_id: 4 });
      expect(mockClioPatch.mock.calls[0][1].data).toEqual({ originating_attorney: { id: 4 } });
    });

    it("sends client_reference when provided", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, client_reference: "EXT-2" });
      expect(mockClioPatch.mock.calls[0][1].data).toEqual({ client_reference: "EXT-2" });
    });

    // Clio addresses an existing custom field value by its own composite id and a
    // brand-new one by the field definition id. Sending the wrong shape is the
    // difference between updating a value and duplicating it, so update_matter
    // reads the record first rather than guessing.
    describe("custom fields", () => {
      it("addresses an existing value by its composite id and omits custom_field", async () => {
        mockClioGet.mockResolvedValue({
          data: { id: 42, custom_field_values: [
            { id: "text_line-55001", field_name: "Docket Number", field_type: "text_line", value: "old", custom_field: { id: 55001 } },
          ] },
        });
        await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, custom_field_values: [{ custom_field_id: 55001, value: "24-cv-1234" }] });
        expect(mockClioPatch.mock.calls[0][1].data).toEqual({
          custom_field_values: [{ id: "text_line-55001", value: "24-cv-1234" }],
        });
      });

      it("addresses a field with no value yet by its definition id", async () => {
        mockClioGet.mockResolvedValue({ data: { id: 42, custom_field_values: [] } });
        await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, custom_field_values: [{ custom_field_id: 55001, value: "24-cv-1234" }] });
        expect(mockClioPatch.mock.calls[0][1].data).toEqual({
          custom_field_values: [{ custom_field: { id: 55001 }, value: "24-cv-1234" }],
        });
      });

      it("reads the matter before writing so the shape is decided from the record", async () => {
        mockClioGet.mockResolvedValue({ data: { id: 42, custom_field_values: [] } });
        await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, custom_field_values: [{ custom_field_id: 7, value: "x" }] });
        expect(mockClioGet).toHaveBeenCalledWith("/matters/42.json", expect.objectContaining({
          fields: expect.stringContaining("custom_field_values"),
        }));
      });

      it("does not read the matter when no custom fields are being written", async () => {
        await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, status: "pending" });
        expect(mockClioGet).not.toHaveBeenCalled();
      });

      it("clears a value with _destroy against its composite id", async () => {
        mockClioGet.mockResolvedValue({
          data: { id: 42, custom_field_values: [
            { id: "date-77", field_name: "Incident Date", field_type: "date", value: "2026-01-01", custom_field: { id: 77 } },
          ] },
        });
        await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, custom_field_values: [{ custom_field_id: 77, clear: true }] });
        expect(mockClioPatch.mock.calls[0][1].data).toEqual({
          custom_field_values: [{ id: "date-77", _destroy: true }],
        });
      });

      it("errors rather than silently doing nothing when clearing a field that has no value", async () => {
        mockClioGet.mockResolvedValue({ data: { id: 42, custom_field_values: [] } });
        const result = await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, custom_field_values: [{ custom_field_id: 77, clear: true }] }) as any;
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("no value on this record");
        expect(mockClioPatch).not.toHaveBeenCalled();
      });
    });

    it("sends only the field(s) provided, omitting all others", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, status: "pending" });
      expect(mockClioPatch.mock.calls[0][1].data).toEqual({ status: "pending" });
    });

    it("calls clioPatch with the correct matter path", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, status: "pending" });
      expect(mockClioPatch.mock.calls[0][0]).toBe("/matters/42.json");
    });
  });

  describe("response mapping", () => {
    it("returns the updated matter fields including custom fields", async () => {
      mockClioPatch.mockResolvedValue({
        data: { ...MOCK_MATTER, custom_field_values: [
          { id: "text_line-1", field_name: "X", field_type: "text_line", value: "Y", custom_field: { id: 1 } },
        ] },
      });
      const result = await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, status: "closed" }) as any;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.matter.id).toBe(42);
      expect(parsed.matter.custom_fields).toEqual([
        { id: "text_line-1", field_id: 1, name: "X", type: "text_line", value: "Y", display_value: "Y" },
      ]);
    });
  });

  describe("audit log", () => {
    it("logs success with matter_id", async () => {
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, status: "closed" });
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "update_matter", outcome: "success", matter_id: 42 }),
      );
    });

    it("logs error with error_message and matter_id on failure", async () => {
      mockClioPatch.mockRejectedValue(new Error("network failure"));
      await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, status: "closed" });
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "update_matter", outcome: "error", error_message: "network failure", matter_id: 42 }),
      );
    });
  });

  describe("error handling", () => {
    it("returns Validation error prefix and isError for ClioApiError 422", async () => {
      mockClioPatch.mockRejectedValue(new MockClioApiError(422, "Invalid status"));
      const result = await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, status: "closed" }) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^Validation error:/);
    });

    it("returns Error prefix and isError for a 404 ClioApiError", async () => {
      mockClioPatch.mockRejectedValue(new MockClioApiError(404, "Matter not found"));
      const result = await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, status: "closed" }) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^Error:/);
    });

    it("returns Error prefix and isError for generic errors", async () => {
      mockClioPatch.mockRejectedValue(new Error("network failure"));
      const result = await handlers["update_matter"]({ ...MIN_UPDATE_ARGS, status: "closed" }) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^Error:/);
    });
  });
});


describe("custom field warnings", () => {
  const STRIPPED = { custom_field_values: [{ id: "text_line-10422772625" }] };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClioGetAllPages.mockResolvedValue([]);
  });

  it("list_matters warns when Clio returned values with no name, type or value", async () => {
    mockClioGet.mockResolvedValue({ data: [{ ...MOCK_MATTER, ...STRIPPED }] });
    const result = await handlers["list_matters"]({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.custom_fields_warning).toMatch(/not yet confirmed/);
    // The distinction that matters to a model reading this: unread, not empty.
    expect(parsed.custom_fields_warning).toMatch(/unread, not as empty/);
  });

  it("list_matters says nothing when the values came back normally", async () => {
    mockClioGet.mockResolvedValue({ data: [MOCK_MATTER] });
    const result = await handlers["list_matters"]({ limit: 25 }) as any;
    expect(JSON.parse(result.content[0].text).custom_fields_warning).toBeUndefined();
  });

  it("get_matter warns on the same shape", async () => {
    mockClioGet.mockResolvedValue({ data: { ...MOCK_MATTER, ...STRIPPED } });
    const result = await handlers["get_matter"]({ matter_id: 42 }) as any;
    expect(JSON.parse(result.content[0].text).custom_fields_warning).toBeDefined();
  });

  it("resolves an unlabelled picklist from the field definitions", async () => {
    mockClioGet.mockResolvedValue({
      data: { ...MOCK_MATTER, custom_field_values: [
        { id: "picklist-9", field_name: "Case Type", field_type: "picklist", value: "9002", custom_field: { id: 9 } },
      ] },
    });
    mockClioGetAllPages.mockResolvedValue([
      { id: 9, name: "Case Type", field_type: "picklist", picklist_options: [{ id: 9002, option: "Identity Theft" }] },
    ]);

    const result = await handlers["get_matter"]({ matter_id: 42 }) as any;
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.custom_fields[0].display_value).toBe("Identity Theft");
    expect(parsed.custom_fields[0].value).toBe("9002");
  });

  it("shows no label rather than the option id when the definitions are refused", async () => {
    mockClioGet.mockResolvedValue({
      data: { ...MOCK_MATTER, custom_field_values: [
        { id: "picklist-9", field_name: "Case Type", field_type: "picklist", value: "9002", custom_field: { id: 9 } },
      ] },
    });
    mockClioGetAllPages.mockRejectedValue(new MockClioApiError(403, "User is forbidden from taking that action"));

    const result = await handlers["get_matter"]({ matter_id: 42 }) as any;
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.custom_fields[0].display_value).toBeNull();
    expect(parsed.custom_fields[0].label_unresolved).toBe(true);
    expect(result.isError).toBeUndefined();
  });
});


describe("matter stages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClioGetAllPages.mockResolvedValue([]);
  });

  it("reports the stage name on list_matters and the id and name on get_matter", async () => {
    const staged = { ...MOCK_MATTER, matter_stage: { id: 7, name: "Discovery" } };

    mockClioGet.mockResolvedValue({ data: [staged] });
    const list = JSON.parse(((await handlers["list_matters"]({ limit: 25 })) as any).content[0].text);
    expect(list.matters[0].matter_stage).toBe("Discovery");

    mockClioGet.mockResolvedValue({ data: staged });
    const detail = JSON.parse(((await handlers["get_matter"]({ matter_id: 42 })) as any).content[0].text);
    expect(detail.matter_stage).toEqual({ id: 7, name: "Discovery" });
  });

  it("reports null rather than failing when a matter is in no stage", async () => {
    mockClioGet.mockResolvedValue({ data: MOCK_MATTER });
    const detail = JSON.parse(((await handlers["get_matter"]({ matter_id: 42 })) as any).content[0].text);
    expect(detail.matter_stage).toBeNull();
  });

  it("asks for the stage only in the full selection, so a wrong name can fall back", async () => {
    // matter_stage has not been exercised against a live account. If Clio does
    // not know the association, clioGetWithFieldFallback has to have a selection
    // left that Clio does know, which means the base set cannot contain it.
    mockClioGet.mockResolvedValue({ data: [] });
    await handlers["list_matters"]({ limit: 25 });
    expect(mockClioGet.mock.calls[0][1].fields).toContain("matter_stage{id,name}");
  });

  it("sends the stage as an association on create_matter", async () => {
    mockClioPost.mockResolvedValue({ data: MOCK_MATTER });
    await handlers["create_matter"]({ ...MIN_ARGS, matter_stage_id: 7 });
    expect(mockClioPost.mock.calls[0][1].data.matter_stage).toEqual({ id: 7 });
  });

  it("moves a matter between stages through update_matter", async () => {
    mockClioPatch.mockResolvedValue({ data: MOCK_MATTER });
    await handlers["update_matter"]({ matter_id: 42, matter_stage_id: 9 });
    expect(mockClioPatch.mock.calls[0][1].data.matter_stage).toEqual({ id: 9 });
  });

  it("counts a stage change as a real update rather than an empty one", async () => {
    mockClioPatch.mockResolvedValue({ data: MOCK_MATTER });
    const result = await handlers["update_matter"]({ matter_id: 42, matter_stage_id: 9 }) as any;
    expect(result.isError).toBeUndefined();
  });

  it("logs which stage a matter was moved to, since that is an auditable action", async () => {
    mockClioPatch.mockResolvedValue({ data: MOCK_MATTER });
    await handlers["update_matter"]({ matter_id: 42, matter_stage_id: 9 });
    const entry = mockAppendAuditLog.mock.calls.at(-1)![0];
    expect(entry.args.matter_stage_id).toBe(9);
  });
});

// ─── who owns a matter ────────────────────────────────────────────────────────

describe("matter people fields", () => {
  const OWNED = {
    id: 42, display_number: "00042", description: "Bank dispute", status: "Open",
    client: { id: 1, name: "Client" }, practice_area: null, open_date: "2026-09-01",
    responsible_attorney: { id: 10, name: "Daniel" },
    responsible_staff: { id: 11, name: "Alan" },
    originating_attorney: null,
    custom_field_values: [],
  };

  it("asks for responsible attorney, responsible staff and originating attorney on list and get", async () => {
    mockClioGet.mockResolvedValue({ data: [OWNED], meta: { records: 1, paging: {} } });
    await handlers["list_matters"]({ limit: 25 });
    const listFields = mockClioGet.mock.calls.find((c: any[]) => c[0] === "/matters.json")![1].fields;
    expect(listFields).toContain("responsible_staff{id,name}");
    expect(listFields).toContain("responsible_attorney{id,name}");

    mockClioGet.mockResolvedValue({ data: OWNED });
    await handlers["get_matter"]({ matter_id: 42 });
    const getFields = mockClioGet.mock.calls.find((c: any[]) => c[0] === "/matters/42.json")![1].fields;
    expect(getFields).toContain("responsible_staff{id,name}");
  });

  it("returns each role as {id, name}, or null when unassigned", async () => {
    mockClioGet.mockResolvedValue({ data: [OWNED], meta: { records: 1, paging: {} } });
    const result = await handlers["list_matters"]({ limit: 25 }) as any;
    const m = JSON.parse(result.content[0].text).matters[0];
    expect(m.responsible_attorney).toEqual({ id: 10, name: "Daniel" });
    expect(m.responsible_staff).toEqual({ id: 11, name: "Alan" });
    expect(m.originating_attorney).toBeNull();
  });
});
