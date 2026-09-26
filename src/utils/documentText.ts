/**
 * Text extraction for Clio documents. Only formats with a real parser are
 * accepted: decoding an arbitrary binary as UTF-8 would hand the model noise
 * and make an unreadable file look like a readable one.
 *
 * Parsers are imported lazily so the connector does not load pdf.js at startup.
 */

import { rtfToText } from "./rtf.js";

export type DocumentKind = "pdf" | "docx" | "doc" | "rtf" | "text";

const KIND_BY_MIME: Record<string, DocumentKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/rtf": "rtf",
  "application/x-rtf": "rtf",
  "text/rtf": "rtf",
  "text/richtext": "rtf",
  "text/plain": "text",
  "text/csv": "text",
  "text/markdown": "text",
  "text/tab-separated-values": "text",
};

const KIND_BY_EXTENSION: Record<string, DocumentKind> = {
  pdf: "pdf",
  docx: "docx",
  doc: "doc",
  rtf: "rtf",
  txt: "text",
  csv: "text",
  md: "text",
  tsv: "text",
};

export const SUPPORTED_FORMATS = "PDF, Word (.docx, .doc), RTF and plain text (.txt, .csv, .md)";

export class UnsupportedDocumentError extends Error {
  constructor(description: string) {
    super(`Cannot extract text from ${description}. Supported formats: ${SUPPORTED_FORMATS}.`);
    this.name = "UnsupportedDocumentError";
  }
}

/** Clio's content_type wins; the extension is used only when the type is missing or generic. */
export function detectDocumentKind(contentType: string | null | undefined, name: string | null | undefined): DocumentKind | null {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (KIND_BY_MIME[mime]) return KIND_BY_MIME[mime];
  if (mime !== "" && mime !== "application/octet-stream") return null;
  const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
  return KIND_BY_EXTENSION[ext] ?? null;
}

export async function extractDocumentText(buffer: Buffer, kind: DocumentKind): Promise<string> {
  switch (kind) {
    case "pdf": {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        return (await parser.getText()).text;
      } catch (err: any) {
        if (err?.name === "PasswordException") {
          throw new UnsupportedDocumentError("a password-protected PDF");
        }
        throw err;
      } finally {
        await parser.destroy();
      }
    }
    case "docx": {
      const mammoth = (await import("mammoth")).default;
      return (await mammoth.extractRawText({ buffer })).value;
    }
    case "doc": {
      const WordExtractor = (await import("word-extractor")).default;
      return (await new WordExtractor().extract(buffer)).getBody();
    }
    case "rtf":
      return rtfToText(buffer.toString("latin1"));
    case "text":
      return buffer.toString("utf8").replace(/^\uFEFF/, "");
  }
}
