import fs from "fs/promises";
import path from "path";

export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_TOOL = "clio-mcp-export";

export type OutputFolderState = "new" | "empty" | "previous_export";
export type OutputFolderCheck = { ok: true; state: OutputFolderState } | { ok: false; message: string };

function errorCode(err: unknown): string {
  return typeof (err as NodeJS.ErrnoException)?.code === "string" ? (err as NodeJS.ErrnoException).code! : "unknown";
}

async function isPreviousExport(folder: string): Promise<boolean | string> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(folder, MANIFEST_FILE), "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    return `Cannot read the output folder (${errorCode(err)}).`;
  }
  try {
    return JSON.parse(raw)?.tool === MANIFEST_TOOL;
  } catch {
    return false;
  }
}

export async function checkOutputFolder(folder: string, opts: { resume: boolean }): Promise<OutputFolderCheck> {
  let state: OutputFolderState;

  let stat;
  try {
    stat = await fs.stat(folder);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") return { ok: false, message: `Cannot read the output folder (${errorCode(err)}).` };
    stat = null;
  }

  if (stat === null) {
    state = "new";
  } else if (!stat.isDirectory()) {
    return { ok: false, message: "The --out path exists and is not a folder." };
  } else {
    let entries: string[];
    try {
      entries = await fs.readdir(folder);
    } catch (err) {
      return { ok: false, message: `Cannot read the output folder (${errorCode(err)}).` };
    }
    if (entries.length === 0) {
      state = "empty";
    } else {
      const previous = await isPreviousExport(folder);
      if (typeof previous === "string") return { ok: false, message: previous };
      if (!previous) {
        return {
          ok: false,
          message: "The output folder is not empty and is not a previous export. Choose an empty folder or a new path.",
        };
      }
      state = "previous_export";
    }
  }

  if (opts.resume && state !== "previous_export") {
    return { ok: false, message: "Nothing to resume: the output folder does not contain a previous export." };
  }
  return { ok: true, state };
}
