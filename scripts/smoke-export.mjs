#!/usr/bin/env node
// Smoke test for "clio-mcp export" against a local fake Clio (synthetic data only).
//   npm run build && node scripts/smoke-export.mjs
// It never touches the OS keychain or a real Clio account: the engine runs inside a library
// session context that supplies a dummy token, and the CLI checks use an empty temporary HOME.
import { spawn, spawnSync } from "child_process";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { startFakeClio } from "./fake-clio.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = (rel) => pathToFileURL(path.join(root, "build", rel)).href;

async function runChild(out, apiBase, resume) {
  process.env.CLIO_API_BASE = apiBase;
  const { runExportEngine } = await import(build("export/engine.js"));
  const { runWithSessionContext } = await import(build("utils/sessionContext.js"));
  const args = { out, since: null, only: null, notExported: [], documents: true, rate: 1000, concurrency: 3, resume, dryRun: false };
  const context = {
    sessionId: "smoke",
    getAccessToken: async () => "smoke-token",
    getTokens: async () => null,
    storeTokens: async () => {},
    clearTokens: async () => {},
  };
  const code = await runWithSessionContext(context, () =>
    runExportEngine({ args, clioUserId: "1" }, { handleSignals: false, retryBaseDelayMs: 1 })
  );
  process.exit(code);
}

function child(out, apiBase, resume) {
  const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", out, apiBase, resume ? "1" : "0"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, stderr })));
  return { proc, done };
}

async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  }
  await walk(dir);
  return out.sort();
}

const readJsonl = async (file) =>
  (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

function step(name) {
  console.log(`smoke: ${name}`);
}

async function expectExit(promise, expected, label) {
  const result = await promise;
  assert.equal(result.code, expected, `${label}: exit ${result.code} (${result.signal ?? "no signal"})\n${result.stderr}`);
  return result;
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clio-smoke-"));
  const fakes = [];
  try {
    step("full export");
    const fake = await startFakeClio();
    fakes.push(fake);
    const outA = path.join(tmp, "a");
    await expectExit(child(outA, fake.apiBase, false).done, 0, "full export");
    const docs = await readJsonl(path.join(outA, "data/documents.jsonl"));
    assert.equal(docs.length, 24);
    assert.equal(fake.stats.storage.length, 18);
    assert.equal(fake.stats.nonGet, 0, "the export sent a write request");
    assert.ok(fake.stats.storage.every((s) => !s.hasAuthorization), "the login reached the storage host");
    const files = await listFiles(outA);
    assert.ok(files.includes("REPORT.md") && files.includes("manifest.json"));
    assert.ok(!files.some((f) => f.endsWith(".part")));
    assert.match(await fs.readFile(path.join(outA, "REPORT.md"), "utf8"), /Result: \*\*COMPLETE\*\*/);

    step("--resume on a finished export downloads nothing");
    const requestsBefore = fake.stats.requests.length;
    await expectExit(child(outA, fake.apiBase, true).done, 0, "resume");
    assert.equal(fake.stats.storage.length, 18, "resume downloaded files again");
    assert.equal(fake.stats.requests.length, requestsBefore, "resume of a finished export made requests");

    step("a second run (refresh) skips every file already downloaded");
    await expectExit(child(outA, fake.apiBase, false).done, 0, "refresh");
    assert.equal(fake.stats.storage.length, 18, "refresh downloaded files again");
    const refreshed = await readJsonl(path.join(outA, "data/documents.jsonl"));
    assert.equal(refreshed.filter((d) => d.export.status === "unchanged").length, 18);

    step("kill -9 in the middle of the downloads, then --resume");
    const slow = await startFakeClio({ matterCount: 20, downloadDelayMs: 40 });
    fakes.push(slow);
    const outB = path.join(tmp, "b");
    const running = child(outB, slow.apiBase, false);
    const started = Date.now();
    while (slow.stats.downloadsStarted < 8 && Date.now() - started < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(slow.stats.downloadsStarted >= 8, "the export never reached the downloads");
    running.proc.kill("SIGKILL");
    const killed = await running.done;
    assert.equal(killed.signal, "SIGKILL");
    const afterKill = slow.stats.downloadsStarted;

    await expectExit(child(outB, slow.apiBase, true).done, 0, "resume after kill");
    const resumed = await readJsonl(path.join(outB, "data/documents.jsonl"));
    assert.equal(resumed.length, 80);
    assert.equal(new Set(resumed.map((d) => d.id)).size, 80, "duplicate rows after resume");
    const resumedFiles = await listFiles(outB);
    assert.ok(!resumedFiles.some((f) => f.endsWith(".part")), "a .part file survived the resume");
    assert.equal(resumedFiles.filter((f) => f.startsWith("matters/")).length, 60);
    assert.ok(slow.stats.downloadsStarted - afterKill <= 60, "the resume downloaded far more than the remaining files");
    assert.equal(slow.stats.nonGet, 0);

    step("command line checks");
    const home = path.join(tmp, "home");
    await fs.mkdir(home);
    const cliEnv = { ...process.env, HOME: home, USERPROFILE: home, CLIO_CLIENT_ID: "x", CLIO_CLIENT_SECRET: "y" };
    delete cliEnv.ENCRYPTION_KEY;
    const cli = (...argv) => spawnSync(process.execPath, [path.join(root, "build/index.js"), ...argv], { env: cliEnv, encoding: "utf8" });
    assert.equal(cli("export").status, 2, "missing --out must print usage and exit 2");
    assert.equal(cli("export", "--out", path.join(tmp, "c"), "--bogus").status, 2);
    assert.equal(cli("export", "--help").status, 0);
    const notLoggedIn = cli("export", "--out", path.join(tmp, "c"));
    assert.equal(notLoggedIn.status, 3);
    assert.match(notLoggedIn.stderr, /run auth first/);
    await fs.mkdir(path.join(tmp, "d"));
    await fs.writeFile(path.join(tmp, "d", "something.txt"), "x");
    assert.equal(cli("export", "--out", path.join(tmp, "d")).status, 3, "login is checked before the folder");

    console.log("smoke: all checks passed");
  } finally {
    for (const fake of fakes) await fake.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--child") {
  await runChild(process.argv[3], process.argv[4], process.argv[5] === "1");
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
