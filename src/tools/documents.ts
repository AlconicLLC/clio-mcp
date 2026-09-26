import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
  clioGet,
  clioPost,
  clioPut,
  clioPatch,
  clioDownload,
  getClioBaseUrl,
  ClioApiError,
  DownloadTooLargeError,
  extractNextPageToken,
} from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { detectDocumentKind, extractDocumentText, UnsupportedDocumentError } from "../utils/documentText.js";

const DOCUMENT_LIST_FIELDS = "id,name,content_type,size,created_at,matter{id,display_number}";

const DOCUMENT_DETAIL_FIELDS =
  "id,name,content_type,size,created_at,matter{id,display_number},latest_document_version{uuid,created_at,size}";

// The whole file is held in memory while it is parsed, so this bounds memory per call.
export const MAX_TEXT_DOWNLOAD_BYTES = 25 * 1024 * 1024;
// Roughly 20k tokens: enough for most pleadings and contracts without crowding out the conversation.
export const MAX_TEXT_CHARS = 80_000;

const PART_SIZE = 10 * 1024 * 1024; // 10 MB — above S3's 5 MB minimum
const MAX_PARTS_PER_REQUEST = 50;

const MIME_MAP: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

async function partMd5(filePath: string, start: number, length: number): Promise<string> {
  const buf = Buffer.alloc(length);
  const fh = await fs.open(filePath, "r");
  try {
    await fh.read(buf, 0, length, start);
  } finally {
    await fh.close();
  }
  return crypto.createHash("md5").update(buf).digest("base64");
}

async function putPartToS3(
  filePath: string,
  offset: number,
  length: number,
  putUrl: string,
  headers: Array<{ name: string; value: string }>
): Promise<void> {
  const buf = Buffer.alloc(length);
  const fh = await fs.open(filePath, "r");
  try {
    await fh.read(buf, 0, length, offset);
  } finally {
    await fh.close();
  }
  const hdrs: Record<string, string> = {};
  for (const h of headers) hdrs[h.name] = h.value;
  const res = await fetch(putUrl, { method: "PUT", headers: hdrs, body: buf });
  if (!res.ok) {
    throw new Error(`S3 upload failed for part at offset ${offset}: HTTP ${res.status}`);
  }
}

export function registerDocumentTools(server: McpServer): void {
  server.registerTool(
    "list_documents",
    {
      description: "List documents in Clio, filtered by matter or folder",
      inputSchema: {
        matter_id: z.number().int().positive().optional().describe("Filter documents by matter ID"),
        parent_id: z.number().int().positive().optional().describe("Filter documents by parent ID (folder)"),
        query: z.string().optional().describe("Full-text search string for document names"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_documents response to fetch the next page"),
      },
    },
    async ({ matter_id, parent_id, query, limit, page_token }) => {
      if (!matter_id && !parent_id && !query) {
        return {
          content: [{ type: "text", text: "Error: provide at least one of matter_id, parent_id, or query" }],
          isError: true,
        };
      }

      try {
        const params: Record<string, string> = { fields: DOCUMENT_LIST_FIELDS, limit: String(limit) };
        if (matter_id) params["matter_id"] = String(matter_id);
        if (parent_id) params["parent_id"] = String(parent_id);
        if (query) params["query"] = query;
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/documents.json", params);
        const docs = data.data as any[];
        const nextPageToken = docs.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_documents",
          args: { matter_id, parent_id, query, limit, page_token },
          outcome: "success",
          result_count: docs?.length ?? 0,
          ...(matter_id && { matter_id }),
        });

        if (!docs || docs.length === 0) {
          return { content: [{ type: "text", text: "No documents found." }] };
        }

        const result = {
          documents: docs.map((d) => ({
            id: d.id,
            name: d.name,
            content_type: d.content_type,
            size: d.size,
            created_at: d.created_at,
            matter: d.matter ? { id: d.matter.id, display_number: d.matter.display_number } : null,
          })),
          total_count: data.meta?.records ?? docs.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_documents",
          args: { matter_id, parent_id, query, limit, page_token },
          outcome: "error",
          error_message: err.message,
          ...(matter_id && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_document",
    {
      description: "Get metadata and download URL for a single Clio document",
      inputSchema: {
        document_id: z.number().int().positive().describe("The Clio document ID"),
      },
    },
    async ({ document_id }) => {
      try {
        const data = await clioGet(`/documents/${document_id}.json`, { fields: DOCUMENT_DETAIL_FIELDS });
        const doc = data.data;

        const versionUuid = doc.latest_document_version?.uuid ?? null;
        const download_url = versionUuid
          ? `${getClioBaseUrl()}/documents/${doc.id}/download?version_uuid=${versionUuid}`
          : null;

        const result = {
          id: doc.id,
          name: doc.name,
          content_type: doc.content_type,
          size: doc.size,
          created_at: doc.created_at,
          matter: doc.matter ? { id: doc.matter.id, display_number: doc.matter.display_number } : null,
          latest_version_uuid: versionUuid,
          download_url,
        };

        await appendAuditLog({ tool: "get_document", args: { document_id }, outcome: "success" });

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "get_document", args: { document_id }, outcome: "success" });
          return { content: [{ type: "text", text: `Document ${document_id} not found.` }] };
        }
        await appendAuditLog({ tool: "get_document", args: { document_id }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_document_text",
    {
      description:
        "Download a Clio document and return its text so it can be read, summarized or quoted. " +
        "Supports PDF, Word (.docx, .doc), RTF and plain text files; spreadsheets and images are not supported. Scanned PDFs without a text layer return no text. " +
        `Returns at most ${MAX_TEXT_CHARS.toLocaleString("en-US")} characters per call; when the result says ` +
        "truncated, call again with start_char set to next_start_char to read the rest.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The Clio document ID"),
        start_char: z.number().int().min(0).default(0)
          .describe("Character offset to start from; use next_start_char from a previous call to continue"),
      },
    },
    async ({ document_id, start_char }) => {
      let matterId: number | undefined;
      const auditArgs = { document_id, start_char };
      try {
        const meta = await clioGet(`/documents/${document_id}.json`, { fields: DOCUMENT_DETAIL_FIELDS });
        const doc = meta.data;
        matterId = doc.matter?.id;

        const kind = detectDocumentKind(doc.content_type, doc.name);
        if (!kind) {
          throw new UnsupportedDocumentError(`this file type (${doc.content_type || "unknown"})`);
        }
        if (typeof doc.size === "number" && doc.size > MAX_TEXT_DOWNLOAD_BYTES) {
          throw new DownloadTooLargeError(MAX_TEXT_DOWNLOAD_BYTES);
        }

        const versionUuid = doc.latest_document_version?.uuid;
        const buffer = await clioDownload(
          `/documents/${document_id}/download`,
          versionUuid ? { version_uuid: versionUuid } : undefined,
          { maxBytes: MAX_TEXT_DOWNLOAD_BYTES }
        );
        const fullText = (await extractDocumentText(buffer, kind)).trim();

        const end = Math.min(start_char + MAX_TEXT_CHARS, fullText.length);
        const text = fullText.slice(start_char, end);
        const truncated = end < fullText.length;

        await appendAuditLog({
          tool: "get_document_text",
          args: auditArgs,
          outcome: "success",
          result_count: text.length,
          ...(matterId && { matter_id: matterId }),
        });

        const header = {
          id: doc.id,
          name: doc.name,
          content_type: doc.content_type,
          matter: doc.matter ? { id: doc.matter.id, display_number: doc.matter.display_number } : null,
          total_characters: fullText.length,
          start_char,
          end_char: end,
          truncated,
          next_start_char: truncated ? end : null,
        };

        let body: string;
        if (fullText.length === 0) {
          body = kind === "pdf"
            ? "No extractable text. This PDF is probably a scan or image; it needs OCR before it can be read."
            : "The document contains no text.";
        } else if (start_char >= fullText.length) {
          body = `start_char ${start_char} is past the end of the document (${fullText.length} characters).`;
        } else {
          body = text;
        }

        return { content: [{ type: "text", text: `${JSON.stringify(header, null, 2)}\n\n${body}` }] };
      } catch (err: any) {
        const notFound = err instanceof ClioApiError && err.statusCode === 404;
        await appendAuditLog({
          tool: "get_document_text",
          args: auditArgs,
          outcome: notFound ? "success" : "error",
          ...(!notFound && { error_message: err.message }),
          ...(matterId && { matter_id: matterId }),
        });
        if (notFound) {
          return { content: [{ type: "text", text: `Document ${document_id} not found.` }] };
        }
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "upload_document",
    {
      description: "Upload a local file to a Clio matter as a document",
      inputSchema: {
        file_path: z.string().describe("Absolute path to the local file to upload"),
        matter_id: z.number().int().positive().describe("Clio matter ID to attach the document to"),
        name: z.string().optional().describe("Document name in Clio; defaults to the file's basename"),
        content_type: z.string().optional().describe("MIME type; auto-detected from extension if omitted"),
      },
    },
    async ({ file_path, matter_id, name, content_type }) => {
      try {
        const stats = await fs.stat(file_path);
        const totalSize = stats.size;
        const originalExt = path.extname(file_path);
        const docName = name
          ? (path.extname(name) ? name : name + originalExt)
          : path.basename(file_path);
        const mime = content_type ?? guessMime(docName);

        type PartDescriptor = { part_number: number; content_length: number; content_md5: string; offset: number };
        const allParts: PartDescriptor[] = [];
        let offset = 0;
        let partNumber = 1;
        while (offset < totalSize) {
          const length = Math.min(PART_SIZE, totalSize - offset);
          const md5 = await partMd5(file_path, offset, length);
          allParts.push({ part_number: partNumber, content_length: length, content_md5: md5, offset });
          offset += length;
          partNumber++;
        }

        const firstBatch = allParts.slice(0, MAX_PARTS_PER_REQUEST);
        const createResp = await clioPost(
          "/documents.json?fields=id,latest_document_version{uuid,put_headers,multiparts}",
          {
            data: {
              name: docName,
              parent: { id: matter_id, type: "Matter" },
              content_type: mime,
              multiparts: firstBatch.map(({ part_number, content_length, content_md5 }) => ({
                part_number, content_length, content_md5,
              })),
            },
          }
        );

        const docId: number = createResp.data.id;
        const version = createResp.data.latest_document_version;
        const uuid: string = version.uuid;

        for (const multipart of version.multiparts as any[]) {
          const desc = firstBatch.find((p) => p.part_number === multipart.part_number)!;
          const partHeaders = multipart.put_headers ?? [];
          await putPartToS3(file_path, desc.offset, desc.content_length, multipart.put_url, partHeaders);
        }

        let batchStart = MAX_PARTS_PER_REQUEST;
        while (batchStart < allParts.length) {
          const batch = allParts.slice(batchStart, batchStart + MAX_PARTS_PER_REQUEST);
          const batchResp = await clioPut(
            `/document_versions/${uuid}.json?fields=uuid,put_headers,multiparts`,
            {
              data: {
                uuid,
                fully_uploaded: false,
                multiparts: batch.map(({ part_number, content_length, content_md5 }) => ({
                  part_number, content_length, content_md5,
                })),
              },
            }
          );
          for (const multipart of batchResp.data.multiparts as any[]) {
            const desc = batch.find((p) => p.part_number === multipart.part_number)!;
            const partHeaders = multipart.put_headers ?? [];
            await putPartToS3(file_path, desc.offset, desc.content_length, multipart.put_url, partHeaders);
          }
          batchStart += MAX_PARTS_PER_REQUEST;
        }

        await clioPatch(`/documents/${docId}.json?fields=id,latest_document_version{fully_uploaded}`, {
          data: { uuid, fully_uploaded: "true" },
        });

        await appendAuditLog({
          tool: "upload_document",
          args: { file_path, matter_id, name: docName },
          outcome: "success",
          matter_id,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ document_id: docId, name: docName, uuid, parts: allParts.length }, null, 2),
          }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "upload_document",
          args: { file_path, matter_id },
          outcome: "error",
          error_message: err.message,
          matter_id,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
