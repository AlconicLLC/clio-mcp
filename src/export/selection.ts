import type { ExportArgs } from "../cli/args.js";
import { DEFAULT_EXPORT_TYPES } from "./typeNames.js";
import { FLAT_ORDER } from "./recordTypes.js";

export interface Selection {
  names: Set<string>;
  flat: string[];
  documents: boolean;
  versions: boolean;
  needsMatterIndex: boolean;
  needsFolderIndex: boolean;
}

export function selectTypes(args: Pick<ExportArgs, "only" | "documents">): Selection {
  const names = new Set<string>(args.only ?? DEFAULT_EXPORT_TYPES);
  if (!args.documents) {
    names.delete("documents");
    names.delete("document_versions");
  }
  const documents = names.has("documents");
  const versions = documents && names.has("document_versions");
  return {
    names,
    flat: FLAT_ORDER.filter((name) => names.has(name)),
    documents,
    versions,
    needsMatterIndex: documents,
    needsFolderIndex: documents,
  };
}
