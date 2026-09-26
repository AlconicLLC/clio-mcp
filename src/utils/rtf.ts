/**
 * Minimal RTF-to-text conversion: keeps the document body, drops formatting,
 * font/color/style tables, metadata and embedded objects. Tables come out as
 * tab-separated rows. Good enough for reading a letter or pleading; not a
 * layout-preserving converter.
 */

/** Destinations whose content is never document text. */
const SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "objdata", "themedata",
  "colorschememapping", "datastore", "latentstyles", "listtable", "listoverridetable",
  "rsidtbl", "generator", "xmlnstbl", "mmathPr", "fldinst", "header", "headerl", "headerr",
  "headerf", "footer", "footerl", "footerr", "footerf", "filetbl", "revtbl", "pgdsctbl",
  "bkmkstart", "bkmkend", "nonshppict", "shppict", "footnote", "annotation", "atnid", "atnauthor",
]);

const WORD_TEXT: Record<string, string> = {
  par: "\n", line: "\n", sect: "\n\n", page: "\n\n", row: "\n", cell: "\t", tab: "\t",
  emdash: "\u2014", endash: "\u2013", bullet: "\u2022", lquote: "\u2018", rquote: "\u2019",
  ldblquote: "\u201C", rdblquote: "\u201D", emspace: " ", enspace: " ", qmspace: " ",
};

const cp1252 = new TextDecoder("windows-1252");

interface GroupState {
  skip: boolean;
  /** Fallback characters to drop after each \uN (set by \ucN). */
  uc: number;
}

export function rtfToText(rtf: string): string {
  const out: string[] = [];
  const stack: GroupState[] = [];
  let state: GroupState = { skip: false, uc: 1 };
  let pendingSkip = 0;
  let i = 0;

  const emit = (s: string) => {
    if (state.skip) return;
    if (pendingSkip > 0) { pendingSkip--; return; }
    out.push(s);
  };

  while (i < rtf.length) {
    const ch = rtf[i];

    if (ch === "{") {
      stack.push(state);
      state = { ...state };
      i++;
      continue;
    }
    if (ch === "}") {
      state = stack.pop() ?? { skip: false, uc: 1 };
      pendingSkip = 0;
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") { i++; continue; }

    if (ch !== "\\") {
      emit(ch);
      i++;
      continue;
    }

    const next = rtf[i + 1];
    if (next === undefined) break;

    if (next === "'") {
      const byte = parseInt(rtf.slice(i + 2, i + 4), 16);
      if (!Number.isNaN(byte)) emit(cp1252.decode(Uint8Array.of(byte)));
      i += 4;
      continue;
    }
    if (next === "*") {
      state.skip = true;
      i += 2;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      if (next === "~") emit("\u00A0");
      else if (next === "_") emit("-");
      else if (next === "\\" || next === "{" || next === "}") emit(next);
      else if (next === "\n" || next === "\r") emit("\n");
      i += 2;
      continue;
    }

    const match = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1, i + 40));
    if (!match) { i++; continue; }
    const [whole, word, numText] = match;
    i += 1 + whole.length;
    const num = numText === undefined ? undefined : parseInt(numText, 10);

    if (SKIP_DESTINATIONS.has(word)) {
      state.skip = true;
    } else if (word === "uc" && num !== undefined) {
      state.uc = num;
    } else if (word === "u" && num !== undefined) {
      emit(String.fromCharCode(num < 0 ? num + 65536 : num));
      if (!state.skip) pendingSkip = state.uc;
    } else if (WORD_TEXT[word]) {
      emit(WORD_TEXT[word]);
    }
  }

  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}
