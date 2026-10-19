export const DEFAULT_EXPORT_TYPES = [
  "matters",
  "contacts",
  "users",
  "practice_areas",
  "custom_fields",
  "matter_stages",
  "relationships",
  "tasks",
  "calendar_entries",
  "notes",
  "time_entries",
  "expenses",
  "bills",
  "folders",
  "documents",
] as const;

export const OPTIONAL_EXPORT_TYPES = [
  "document_versions",
  "communications",
  "allocations",
  "trust_line_items",
  "bank_transactions",
] as const;

export const NOT_EXPORTED_TYPES = ["ledger_reports"] as const;

export type ExportTypeName = (typeof DEFAULT_EXPORT_TYPES)[number] | (typeof OPTIONAL_EXPORT_TYPES)[number];
