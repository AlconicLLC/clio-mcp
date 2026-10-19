import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { checkOutputFolder, MANIFEST_FILE, MANIFEST_TOOL } from "../outputFolder.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clio-export-folder-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("checkOutputFolder", () => {
  it("accepts a folder that does not exist yet", async () => {
    expect(await checkOutputFolder(path.join(root, "new"), { resume: false })).toEqual({ ok: true, state: "new" });
  });

  it("accepts an empty folder", async () => {
    expect(await checkOutputFolder(root, { resume: false })).toEqual({ ok: true, state: "empty" });
  });

  it("accepts a previous export, with or without --resume", async () => {
    await fs.writeFile(path.join(root, MANIFEST_FILE), JSON.stringify({ tool: MANIFEST_TOOL }));
    await fs.writeFile(path.join(root, "other.txt"), "x");
    expect(await checkOutputFolder(root, { resume: false })).toEqual({ ok: true, state: "previous_export" });
    expect(await checkOutputFolder(root, { resume: true })).toEqual({ ok: true, state: "previous_export" });
  });

  it("refuses a non-empty folder that is not a previous export", async () => {
    await fs.writeFile(path.join(root, "notes.txt"), "x");
    const result = await checkOutputFolder(root, { resume: false });
    expect(result.ok).toBe(false);
  });

  it("refuses a folder whose manifest belongs to something else or is unreadable JSON", async () => {
    await fs.writeFile(path.join(root, MANIFEST_FILE), JSON.stringify({ tool: "another-tool" }));
    expect((await checkOutputFolder(root, { resume: false })).ok).toBe(false);
    await fs.writeFile(path.join(root, MANIFEST_FILE), "{not json");
    expect((await checkOutputFolder(root, { resume: false })).ok).toBe(false);
  });

  it("refuses a path that is a file", async () => {
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "x");
    expect((await checkOutputFolder(file, { resume: false })).ok).toBe(false);
  });

  it("refuses --resume without a previous export", async () => {
    expect((await checkOutputFolder(path.join(root, "missing"), { resume: true })).ok).toBe(false);
    expect((await checkOutputFolder(root, { resume: true })).ok).toBe(false);
  });
});
