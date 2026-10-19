import fs from "fs/promises";
import { createReadStream } from "fs";
import crypto from "crypto";
import path from "path";

export class ExportCorruptionError extends Error {
  constructor(what: string) {
    super(`Export data is inconsistent: ${what}`);
    this.name = "ExportCorruptionError";
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function atomicWriteFile(file: string, content: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value));
}

export async function readJsonIfExists<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ExportCorruptionError("a checkpoint file is not valid JSON");
  }
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function removeIfExists(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Append-only output file that tracks how many bytes it holds, so a checkpoint can record an exact offset. */
export class AppendFile {
  private constructor(
    private readonly handle: fs.FileHandle,
    public bytes: number
  ) {}

  /** `startAt` null starts an empty file; a number truncates an existing file back to that offset. */
  static async open(file: string, startAt: number | null): Promise<AppendFile> {
    await ensureDir(path.dirname(file));
    if (startAt === null) {
      return new AppendFile(await fs.open(file, "w"), 0);
    }
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ExportCorruptionError("an output file is missing");
      throw err;
    }
    if (size < startAt) throw new ExportCorruptionError("an output file is shorter than its checkpoint");
    await fs.truncate(file, startAt);
    return new AppendFile(await fs.open(file, "a"), startAt);
  }

  async write(text: string): Promise<void> {
    if (text.length === 0) return;
    await this.handle.appendFile(text);
    this.bytes += Buffer.byteLength(text);
  }

  async sync(): Promise<void> {
    await this.handle.sync();
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buf = chunk as Buffer;
    hash.update(buf);
    bytes += buf.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export interface LineWithOffset {
  offset: number;
  nextOffset: number;
  text: string;
}

/** Streams complete lines of a file starting at a byte offset, reporting exact byte offsets. */
export async function* readLinesFrom(file: string, startOffset: number): AsyncGenerator<LineWithOffset> {
  let position = startOffset;
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { start: startOffset })) {
    let buffer: Buffer = carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let from = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, from);
      if (newline === -1) break;
      const lineLength = newline + 1 - from;
      yield { offset: position, nextOffset: position + lineLength, text: buffer.subarray(from, newline).toString("utf8") };
      position += lineLength;
      from = newline + 1;
    }
    carry = buffer.subarray(from);
  }
}

export async function removeFilesWithSuffix(root: string, suffix: string): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      removed += await removeFilesWithSuffix(full, suffix);
    } else if (entry.name.endsWith(suffix)) {
      await removeIfExists(full);
      removed++;
    }
  }
  return removed;
}
