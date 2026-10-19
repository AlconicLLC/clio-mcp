export const CSV_BOM = "﻿";

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";

  let text: string;
  if (typeof value === "string") {
    text = FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  } else {
    text = JSON.stringify(value) ?? "";
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function getPath(row: unknown, dotted: string): unknown {
  let current: any = row;
  for (const part of dotted.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

export function csvHeader(columns: readonly string[]): string {
  return `${CSV_BOM}${columns.map(csvEscape).join(",")}\r\n`;
}

export function csvRow(row: unknown, columns: readonly string[]): string {
  return `${columns.map((column) => csvEscape(getPath(row, column))).join(",")}\r\n`;
}

/** Columns for types whose field list is not fixed: the top-level keys of the first page. */
export function inferColumns(rows: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === "object") for (const key of Object.keys(row)) keys.add(key);
  }
  return [...keys].sort((a, b) => (a === "id" ? -1 : b === "id" ? 1 : a.localeCompare(b)));
}
