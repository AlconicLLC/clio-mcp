import { describe, it, expect } from "vitest";
import {
  sanitizeSegment,
  buildFileName,
  buildMatterFolderName,
  fitRelativePath,
  splitName,
  PathTooLongError,
  MAX_SEGMENT_BYTES,
} from "../fsnames.js";

describe("sanitizeSegment applies the Windows rules on every platform", () => {
  it.each([
    ["a<b>c:d\"e/f\\g|h?i*j", "a_b_c_d_e_f_g_h_i_j"],
    ["tab\there", "tab_here"],
    ["null\u0000byte", "null_byte"],
    ["delete\u007fchar", "delete_char"],
    ["trailing dots...", "trailing dots"],
    ["trailing spaces   ", "trailing spaces"],
    ["   leading spaces", "leading spaces"],
    ["mixed. . .", "mixed"],
  ])("cleans %j", (input, expected) => {
    expect(sanitizeSegment(input)).toBe(expected);
  });

  it.each(["CON", "con", "PRN", "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9", "CON.txt", "nul.tar.gz", "Aux.pdf"])(
    "prefixes the reserved name %j",
    (input) => {
      expect(sanitizeSegment(input)).toBe(`_${input}`);
    }
  );

  it.each(["CONSOLE", "COM10", "LPT0", "CONNECT.txt", "my CON.txt", "AUXILIARY"])("keeps the non-reserved name %j", (input) => {
    expect(sanitizeSegment(input)).toBe(input);
  });

  it.each([".", "..", "...", "", "   ", "<<<"])("never returns an empty or dot-only segment for %j", (input) => {
    const out = sanitizeSegment(input, "fallback");
    expect(out).not.toBe("");
    expect(out).not.toMatch(/^\.+$/);
  });

  it("turns '..' into the fallback so a name can never climb out of a folder", () => {
    expect(sanitizeSegment("..", "fallback")).toBe("fallback");
    expect(sanitizeSegment("../etc")).toBe(".._etc");
  });

  it("limits a segment to 255 bytes without splitting a character", () => {
    const long = "é".repeat(300);
    const out = sanitizeSegment(long);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
    expect(out).toMatch(/^é+$/);
    const emoji = sanitizeSegment("😀".repeat(100));
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
  });

  it("normalises Unicode to NFC", () => {
    expect(sanitizeSegment("e\u0301")).toBe("\u00e9");
  });
});

describe("buildFileName", () => {
  it("adds the document id before the extension", () => {
    expect(buildFileName("Engagement letter.pdf", 5000)).toBe("Engagement letter [5000].pdf");
    expect(buildFileName("archive.tar.gz", 7)).toBe("archive.tar [7].gz");
    expect(buildFileName("no extension", 8)).toBe("no extension [8]");
  });

  it("keeps the id and extension when the name is very long", () => {
    const name = buildFileName(`${"x".repeat(400)}.docx`, 123456);
    expect(name.endsWith(" [123456].docx")).toBe(true);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
  });

  it("makes illegal and reserved names safe", () => {
    expect(buildFileName("Motion: draft?.docx", 2)).toBe("Motion_ draft_ [2].docx");
    expect(buildFileName("CON.txt", 3)).toBe("_CON [3].txt");
    expect(buildFileName("", 4)).toBe("document [4]");
    expect(buildFileName("...", 5)).toBe("document [5]");
  });

  it("gives two documents with the same name different files", () => {
    expect(buildFileName("Same.pdf", 1)).not.toBe(buildFileName("Same.pdf", 2));
  });

  it("does not treat a dotfile or a long suffix as an extension", () => {
    expect(splitName(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
    expect(splitName("notes.this is not an extension")).toEqual({ stem: "notes.this is not an extension", ext: "" });
  });
});

describe("buildMatterFolderName", () => {
  it("joins number and client", () => {
    expect(buildMatterFolderName("2025-0001", "Acme Corp", 1)).toBe("2025-0001 - Acme Corp");
  });

  it("copes with missing parts and illegal characters", () => {
    expect(buildMatterFolderName("2025-0001", null, 1)).toBe("2025-0001");
    expect(buildMatterFolderName(null, "Acme", 1)).toBe("Acme");
    expect(buildMatterFolderName(null, null, 77)).toBe("matter 77");
    expect(buildMatterFolderName("A/B", "C:D", 1)).toBe("A_B - C_D");
  });
});

describe("fitRelativePath", () => {
  const out = "C:\\exports\\firm";

  it("leaves a short path alone", () => {
    expect(fitRelativePath(out, ["matters", "m", "sub"], "file [1].pdf")).toEqual({
      segments: ["matters", "m", "sub"],
      fileName: "file [1].pdf",
    });
  });

  it("shortens folders and then the file stem until the path fits, keeping id and extension", () => {
    const segments = ["matters", "m".repeat(120), "s".repeat(120)];
    const fileName = `${"f".repeat(150)} [999].pdf`;
    const fitted = fitRelativePath(out, segments, fileName);
    const total = out.length + 1 + fitted.segments.reduce((n, s) => n + s.length + 1, 0) + fitted.fileName.length;
    expect(total).toBeLessThanOrEqual(240);
    expect(fitted.fileName.endsWith(" [999].pdf")).toBe(true);
    expect(fitted.segments[0]).toBe("matters");
  });

  it("throws when even the shortest form cannot fit", () => {
    const longOut = "C:\\" + "o".repeat(230);
    expect(() => fitRelativePath(longOut, ["matters", "m"], "f [1].pdf")).toThrow(PathTooLongError);
  });
});
