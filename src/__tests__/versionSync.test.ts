import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

describe("release version", () => {
  const pkg = readJson("package.json");
  const server = readJson("server.json");

  it("is the same in package.json and everywhere server.json states it", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages.length).toBeGreaterThan(0);
    for (const entry of server.packages) expect(entry.version).toBe(pkg.version);
  });

  it("matches the newest released heading in the changelog", () => {
    const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    const heading = /^## \[(\d+\.\d+\.\d+(?:-alconic\.\d+)?)\]/m.exec(changelog);
    expect(heading?.[1]).toBe(pkg.version);
  });
});
