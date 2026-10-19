import crypto from "crypto";
import { readFileSync } from "fs";
import path from "path";
import type { ExportArgs } from "../cli/args.js";
import { MANIFEST_FILE, MANIFEST_TOOL } from "../cli/outputFolder.js";
import { atomicWriteJson, readJsonIfExists } from "./fsutil.js";

export const MANIFEST_SCHEMA = 1;

export interface IndexInfo {
  status: "building" | "complete";
  built_at?: string;
  count?: number;
  sha256?: string;
  bytes?: number;
}

export interface ManifestOptions {
  only: string[] | null;
  since: string | null;
  documents: boolean;
}

export interface Manifest {
  tool: typeof MANIFEST_TOOL;
  schema: number;
  version: string;
  created_at: string;
  refresh_started_at?: string;
  refresh_id: string;
  clio_user_id: string | null;
  region: string;
  options: ManifestOptions;
  indexes: { matter_index?: IndexInfo; folder_index?: IndexInfo };
}

export function packageVersion(): string {
  const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

export function optionsOf(args: ExportArgs): ManifestOptions {
  return { only: args.only, since: args.since?.iso ?? null, documents: args.documents };
}

export function sameOptions(a: ManifestOptions, b: ManifestOptions): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function newManifest(args: ExportArgs, clioUserId: string | null, region: string, now: Date): Manifest {
  return {
    tool: MANIFEST_TOOL,
    schema: MANIFEST_SCHEMA,
    version: packageVersion(),
    created_at: now.toISOString(),
    refresh_id: crypto.randomUUID(),
    clio_user_id: clioUserId,
    region,
    options: optionsOf(args),
    indexes: {},
  };
}

export async function readManifest(outDir: string): Promise<Manifest | null> {
  return readJsonIfExists<Manifest>(path.join(outDir, MANIFEST_FILE));
}

export async function writeManifest(outDir: string, manifest: Manifest): Promise<void> {
  await atomicWriteJson(path.join(outDir, MANIFEST_FILE), manifest);
}
