import { describe, it, expect } from "vitest";
import { detectDocumentKind, extractDocumentText } from "../documentText.js";
import { rtfToText } from "../rtf.js";

/** Smallest well-formed PDF with one line of text, built so the test needs no fixture file. */
function buildPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("detectDocumentKind", () => {
  it.each([
    ["application/pdf", "x", "pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x", "docx"],
    ["application/msword", "x", "doc"],
    ["application/rtf", "x", "rtf"],
    ["text/rtf", "x", "rtf"],
    ["text/plain; charset=utf-8", "x", "text"],
  ])("maps %s to %s", (mime, name, kind) => {
    expect(detectDocumentKind(mime, name)).toBe(kind);
  });

  it("falls back to the extension only when the content type is missing or generic", () => {
    expect(detectDocumentKind(null, "Retainer.DOCX")).toBe("docx");
    expect(detectDocumentKind("application/octet-stream", "letter.rtf")).toBe("rtf");
    expect(detectDocumentKind("", "notes.txt")).toBe("text");
  });

  it("trusts a specific content type over a misleading extension", () => {
    expect(detectDocumentKind("image/png", "scan.pdf")).toBeNull();
  });

  it("rejects spreadsheets, images and unknown files", () => {
    expect(detectDocumentKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx")).toBeNull();
    expect(detectDocumentKind("application/vnd.ms-excel", "a.xls")).toBeNull();
    expect(detectDocumentKind("image/jpeg", "photo.jpg")).toBeNull();
    expect(detectDocumentKind(null, "no-extension")).toBeNull();
    expect(detectDocumentKind(null, "a.xlsx")).toBeNull();
  });
});

describe("extractDocumentText", () => {
  it("reads the text layer of a PDF", async () => {
    const text = await extractDocumentText(buildPdf("Motion to Compel Discovery"), "pdf");
    expect(text).toContain("Motion to Compel Discovery");
  });

  it("decodes UTF-8 text and drops a byte-order mark", async () => {
    const text = await extractDocumentText(Buffer.from("\uFEFFSection 2 \u2014 Indemnification", "utf8"), "text");
    expect(text).toBe("Section 2 \u2014 Indemnification");
  });

  it("routes RTF through the RTF converter", async () => {
    const text = await extractDocumentText(Buffer.from("{\\rtf1\\ansi Dear Counsel,\\par}", "latin1"), "rtf");
    expect(text).toBe("Dear Counsel,\n");
  });
});

describe("rtfToText", () => {
  it("keeps body text and drops font, color and info tables", () => {
    const rtf =
      "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Helvetica;}}{\\colortbl;\\red255\\green0\\blue0;}" +
      "{\\info{\\author Jane Attorney}}\\f0\\fs24 Dear Counsel,\\par\\par Please find {\\b enclosed} the motion.\\par}";
    expect(rtfToText(rtf)).toBe("Dear Counsel,\n\nPlease find enclosed the motion.\n");
  });

  it("decodes Windows-1252 hex escapes and Unicode escapes without their fallback characters", () => {
    expect(rtfToText("{\\rtf1 Caf\\'e9 \\u8212? done}")).toBe("Caf\u00E9 \u2014 done");
    expect(rtfToText("{\\rtf1 \\u8212\\'97 done}")).toBe("\u2014 done");
    expect(rtfToText("{\\rtf1\\uc2 A\\u8364??B}")).toBe("A\u20ACB");
  });

  it("skips ignorable destinations and embedded pictures", () => {
    const rtf = "{\\rtf1 before{\\*\\generator Word;}{\\pict\\pngblip 89504e47}{\\*\\themedata abc} after}";
    expect(rtfToText(rtf)).toBe("before after");
  });

  it("keeps the visible result of a field but not its instruction", () => {
    const rtf = '{\\rtf1 See {\\field{\\*\\fldinst HYPERLINK "https://x"}{\\fldrslt the docket}}.}';
    expect(rtfToText(rtf)).toBe("See the docket.");
  });

  it("turns table cells and rows into tabs and lines", () => {
    const rtf = "{\\rtf1\\trowd A1\\cell B1\\cell\\row A2\\cell B2\\cell\\row}";
    expect(rtfToText(rtf)).toBe("A1\tB1\nA2\tB2\n");
  });

  it("unescapes literal braces and backslashes", () => {
    expect(rtfToText("{\\rtf1 a \\{b\\} c\\\\d}")).toBe("a {b} c\\d");
  });
});
