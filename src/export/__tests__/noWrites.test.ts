import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("the export contains no write calls", () => {
  it("never uses the client's write helpers, a write verb, or the MCP tool modules", async () => {
    const files = [...(await sourceFiles(path.join(srcRoot, "export"))), ...(await sourceFiles(path.join(srcRoot, "cli")))];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = await fs.readFile(file, "utf8");
      const name = path.relative(srcRoot, file);
      expect(text, `${name} uses a write helper`).not.toMatch(/\bclio(Post|Patch|Put)\b/);
      expect(text, `${name} sets a write method`).not.toMatch(/method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i);
      expect(text, `${name} imports an MCP tool module`).not.toMatch(/from\s+["'][./]+\/tools\//);
    }
  });

  it("only issues GET requests through fetch", async () => {
    const files = await sourceFiles(path.join(srcRoot, "export"));
    for (const file of files) {
      const text = await fs.readFile(file, "utf8");
      for (const call of text.matchAll(/\bfetch\(([^)]*)\)/g)) {
        expect(call[1], `${path.relative(srcRoot, file)} calls fetch with a non-GET method`).not.toMatch(/method\s*:\s*["'`](?!GET)/);
      }
    }
  });
});
