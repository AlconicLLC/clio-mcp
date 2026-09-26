import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockClioGet, mockClioDownload, mockAppendAuditLog, MockClioApiError, MockDownloadTooLargeError } = vi.hoisted(() => {
  class MockClioApiError extends Error {
    constructor(public statusCode: number, message: string) {
      super(message);
      this.name = "ClioApiError";
    }
  }
  class MockDownloadTooLargeError extends Error {
    constructor(public maxBytes: number) {
      super(`File exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB download limit.`);
    }
  }
  return {
    mockClioGet: vi.fn(),
    mockClioDownload: vi.fn(),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
    MockClioApiError,
    MockDownloadTooLargeError,
  };
});

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: vi.fn(),
  clioPut: vi.fn(),
  clioPatch: vi.fn(),
  clioDownload: mockClioDownload,
  getClioBaseUrl: () => "https://app.clio.com/api/v4",
  ClioApiError: MockClioApiError,
  DownloadTooLargeError: MockDownloadTooLargeError,
  extractNextPageToken: () => null,
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerDocumentTools, MAX_TEXT_CHARS, MAX_TEXT_DOWNLOAD_BYTES } from "../documents.js";

const handlers: Record<string, Function> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: Function) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerDocumentTools(fakeServer as any);
});

const SECRET = "PRIVILEGEDCONTENTCANARY";

function doc(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 9,
      name: "Settlement memo.txt",
      content_type: "text/plain",
      size: 2048,
      matter: { id: 42, display_number: "00042-001" },
      latest_document_version: { uuid: "v-uuid" },
      ...overrides,
    },
  };
}

function call(args: Record<string, unknown>) {
  return handlers["get_document_text"]({ start_char: 0, ...args }) as Promise<any>;
}

function parse(result: any) {
  const text: string = result.content[0].text;
  const split = text.indexOf("\n\n");
  return { header: JSON.parse(text.slice(0, split)), body: text.slice(split + 2) };
}

describe("get_document_text", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("downloads the latest version and returns its text with a header", async () => {
    mockClioGet.mockResolvedValue(doc());
    mockClioDownload.mockResolvedValue(Buffer.from(`The parties agree ${SECRET}.`));

    const result = await call({ document_id: 9 });
    expect(result.isError).toBeUndefined();

    const [path, params, opts] = mockClioDownload.mock.calls[0];
    expect(path).toBe("/documents/9/download");
    expect(params).toEqual({ version_uuid: "v-uuid" });
    expect(opts.maxBytes).toBe(MAX_TEXT_DOWNLOAD_BYTES);

    const { header, body } = parse(result);
    expect(body).toBe(`The parties agree ${SECRET}.`);
    expect(header).toMatchObject({ id: 9, matter: { id: 42 }, truncated: false, next_start_char: null });
  });

  it("audits ids only, never the document text or name", async () => {
    mockClioGet.mockResolvedValue(doc({ name: `${SECRET}.txt` }));
    mockClioDownload.mockResolvedValue(Buffer.from(SECRET));

    await call({ document_id: 9 });
    const entry = mockAppendAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({ tool: "get_document_text", outcome: "success", matter_id: 42 });
    expect(entry.args).toEqual({ document_id: 9, start_char: 0 });
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  it("refuses unsupported formats before downloading", async () => {
    mockClioGet.mockResolvedValue(doc({
      name: "damages.xlsx",
      content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));

    const result = await call({ document_id: 9 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot extract text");
    expect(mockClioDownload).not.toHaveBeenCalled();
    expect(mockAppendAuditLog.mock.calls[0][0].outcome).toBe("error");
  });

  it("refuses files over the size limit before downloading", async () => {
    mockClioGet.mockResolvedValue(doc({ size: MAX_TEXT_DOWNLOAD_BYTES + 1 }));

    const result = await call({ document_id: 9 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("MB download limit");
    expect(mockClioDownload).not.toHaveBeenCalled();
  });

  it("truncates long documents and lets the caller continue from next_start_char", async () => {
    const full = "a".repeat(MAX_TEXT_CHARS) + "b".repeat(10);
    mockClioGet.mockResolvedValue(doc());
    mockClioDownload.mockResolvedValue(Buffer.from(full));

    const first = parse(await call({ document_id: 9 }));
    expect(first.header).toMatchObject({ truncated: true, next_start_char: MAX_TEXT_CHARS, total_characters: full.length });
    expect(first.body).toHaveLength(MAX_TEXT_CHARS);

    const second = parse(await call({ document_id: 9, start_char: MAX_TEXT_CHARS }));
    expect(second.header).toMatchObject({ truncated: false, next_start_char: null, end_char: full.length });
    expect(second.body).toBe("b".repeat(10));
  });

  it("explains an empty PDF as a probable scan", async () => {
    mockClioGet.mockResolvedValue(doc({ name: "exhibit.pdf", content_type: "application/pdf" }));
    const { PDFParse } = await import("pdf-parse");
    vi.spyOn(PDFParse.prototype, "getText").mockResolvedValue({ text: "  \n" } as any);
    vi.spyOn(PDFParse.prototype, "destroy").mockResolvedValue();
    mockClioDownload.mockResolvedValue(Buffer.from("%PDF-1.4"));

    const { header, body } = parse(await call({ document_id: 9 }));
    expect(header.total_characters).toBe(0);
    expect(body).toContain("needs OCR");
  });

  it("omits version_uuid when Clio reports no version", async () => {
    mockClioGet.mockResolvedValue(doc({ latest_document_version: null }));
    mockClioDownload.mockResolvedValue(Buffer.from("x"));
    await call({ document_id: 9 });
    expect(mockClioDownload.mock.calls[0][1]).toBeUndefined();
  });

  it("reports a missing document without marking the call as failed", async () => {
    mockClioGet.mockRejectedValue(new MockClioApiError(404, "not found"));
    const result = await call({ document_id: 9 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Document 9 not found.");
  });

  it("returns download failures as tool errors", async () => {
    mockClioGet.mockResolvedValue(doc());
    mockClioDownload.mockRejectedValue(new MockClioApiError(403, "Clio API error 403"));
    const result = await call({ document_id: 9 });
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog.mock.calls[0][0]).toMatchObject({ outcome: "error", matter_id: 42 });
  });
});
