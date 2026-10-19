const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export const MAX_SEGMENT_BYTES = 255;
export const MAX_PATH_CHARS = 240;
const MIN_SHRUNK_SEGMENT = 12;

export class PathTooLongError extends Error {
  constructor() {
    super("The file path is too long for Windows even after shortening");
    this.name = "PathTooLongError";
  }
}

function truncateBytes(text: string, maxBytes: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

function stripTrailing(text: string): string {
  return text.replace(/[. ]+$/, "");
}

/** One path segment that is legal on Windows, macOS and Linux. Always applies the Windows rules. */
export function sanitizeSegment(raw: string, fallback = "_"): string {
  let text = (raw ?? "").normalize("NFC").replace(ILLEGAL, "_");
  text = stripTrailing(text).replace(/^ +/, "");
  if (text === "") return fallback;
  const firstDot = text.indexOf(".");
  const stem = firstDot === -1 ? text : text.slice(0, firstDot);
  if (RESERVED.test(stem.trimEnd())) text = `_${text}`;
  const cut = stripTrailing(truncateBytes(text, MAX_SEGMENT_BYTES));
  return cut === "" ? fallback : cut;
}

export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  const ext = name.slice(dot);
  if (ext.length > 16 || /\s/.test(ext)) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext };
}

/** `<original stem> [<id>]<ext>`, safe on Windows and within the per-name byte limit. */
export function buildFileName(originalName: string, id: number | string): string {
  const { stem, ext } = splitName((originalName ?? "").normalize("NFC"));
  const cleanExt = stripTrailing(ext.replace(ILLEGAL, "_"));
  const cleanStem = sanitizeSegment(stem, "document");
  const suffix = ` [${id}]`;
  const budget = Math.max(MAX_SEGMENT_BYTES - Buffer.byteLength(suffix) - Buffer.byteLength(cleanExt), 1);
  const shortStem = stripTrailing(truncateBytes(cleanStem, budget));
  return `${shortStem === "" ? "document" : shortStem}${suffix}${cleanExt}`;
}

export function buildMatterFolderName(displayNumber: string | null | undefined, clientName: string | null | undefined, matterId: number): string {
  const number = (displayNumber ?? "").trim();
  const client = (clientName ?? "").trim();
  const label = number !== "" && client !== "" ? `${number} - ${client}` : number !== "" ? number : client !== "" ? client : `matter ${matterId}`;
  return sanitizeSegment(label, `matter ${matterId}`);
}

function shorten(text: string, by: number): string {
  const chars = Array.from(text);
  return stripTrailing(chars.slice(0, Math.max(chars.length - by, MIN_SHRUNK_SEGMENT)).join(""));
}

function shortenFileName(fileName: string, by: number): string {
  const { stem, ext } = splitName(fileName);
  const match = /^(.*?)( \[[^\]]*\])$/.exec(stem);
  const base = match ? match[1] : stem;
  const tag = match ? match[2] : "";
  const shorter = shorten(base, by);
  return `${shorter === "" ? "document" : shorter}${tag}${ext}`;
}

/**
 * Keeps `outDir + segments + fileName` within the Windows path limit by shortening the longest
 * folders first and then the file stem. The id tag and extension of the file name always survive.
 */
export function fitRelativePath(
  outDir: string,
  segments: readonly string[],
  fileName: string,
  maxChars = MAX_PATH_CHARS
): { segments: string[]; fileName: string } {
  const dirs = [...segments];
  let name = fileName;
  const total = () => outDir.length + 1 + dirs.reduce((sum, s) => sum + s.length + 1, 0) + name.length;

  while (total() > maxChars) {
    const excess = total() - maxChars;
    let longest = -1;
    for (let i = 0; i < dirs.length; i++) {
      if (Array.from(dirs[i]).length > MIN_SHRUNK_SEGMENT && (longest === -1 || dirs[i].length > dirs[longest].length)) longest = i;
    }
    if (longest === -1) break;
    const before = dirs[longest];
    dirs[longest] = shorten(before, excess);
    if (dirs[longest] === before) break;
  }

  if (total() > maxChars) {
    const before = name;
    name = shortenFileName(name, total() - maxChars);
    if (name === before && total() > maxChars) throw new PathTooLongError();
  }
  if (total() > maxChars) throw new PathTooLongError();
  return { segments: dirs, fileName: name };
}
