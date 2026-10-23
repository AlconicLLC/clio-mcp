import { CUSTOM_FIELD_VALUE_FIELDS, CUSTOM_FIELD_DEFINITION_FIELDS } from "../utils/customFields.js";

export interface UnitSpec {
  label: string;
  params: Record<string, string>;
}

export interface UnitContext {
  sinceIso: string | null;
  now: Date;
}

export interface SideOutput {
  file: string;
  map(row: any): unknown;
}

export interface FlatTypeSpec {
  name: string;
  endpoint: string;
  fieldSets: (string | null)[];
  columns: string[] | null;
  sinceParam: string | null;
  optional: boolean;
  units(ctx: UnitContext): UnitSpec[];
  side?: SideOutput;
  noData?: boolean;
}

export const CALENDAR_FIXED_START_YEAR = 1990;

const single = (): UnitSpec[] => [{ label: "all", params: {} }];

function calendarUnits(ctx: UnitContext): UnitSpec[] {
  const startYear = ctx.sinceIso ? new Date(ctx.sinceIso).getUTCFullYear() : CALENDAR_FIXED_START_YEAR;
  const endYear = ctx.now.getUTCFullYear() + 1;
  const units: UnitSpec[] = [];
  for (let year = startYear; year <= endYear; year++) {
    units.push({ label: String(year), params: { from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` } });
  }
  return units;
}

const MATTER_BASE = "id,display_number,description,status,client{id,name},practice_area{id,name},open_date,close_date";
const MATTER_PEOPLE = "responsible_attorney{id,name},originating_attorney{id,name},responsible_staff{id,name}";
const MATTER_EXTRA = "billable,created_at,updated_at,matter_stage{id,name}";

const CONTACT_LIST_BASE = "id,name,email_addresses{address,name},phone_numbers{number,name},company{id,name},type";
const CONTACT_DETAIL_BASE =
  "id,name,first_name,last_name,title,email_addresses{address,name},phone_numbers{number,name},company{id,name},type,created_at,updated_at,addresses{name,street,city,province,postal_code,country}";

const USER_BASE = "id,name,email,enabled,subscription_type,initials";
const RELATIONSHIP_BASE =
  "id,description,contact{id,name,type,primary_email_address,primary_phone_number},matter{id,display_number}";
const TASK_BASE = "id,name,priority,due_at,status,assignee{id,name},matter{id,display_number},reminders{id,notification_method}";
const CALENDAR_BASE = "id,summary,description,start_at,end_at,matter{id,display_number},attendees{id,name}";
const NOTE_FIELDS =
  "id,subject,detail,detail_text_type,date,type,matter{id,display_number},contact{id,name},author{id,name},created_at,updated_at";
const ACTIVITY_BASE = "id,date,quantity_in_hours,price,total,note,matter{id,display_number},user{id,name}";
const EXPENSE_BASE = "id,type,date,price,total,note,matter{id,display_number},user{id,name}";
const BILL_BASE = "id,number,issued_at,due_at,balance,total,state";
const FOLDER_BASE = "id,name,parent{id,type},matter{id,display_number}";

const MATTER_COLUMNS = [
  "id", "display_number", "description", "status", "client.id", "client.name", "practice_area.id", "practice_area.name",
  "matter_stage.id", "matter_stage.name", "responsible_attorney.id", "responsible_attorney.name",
  "originating_attorney.id", "originating_attorney.name", "responsible_staff", "open_date", "close_date", "billable",
  "created_at", "updated_at", "custom_field_values",
];

export const FLAT_SPECS: Record<string, FlatTypeSpec> = {
  matter_index: {
    name: "matter_index",
    endpoint: "/matters.json",
    fieldSets: ["id,display_number,client{id,name}"],
    columns: [],
    sinceParam: null,
    optional: false,
    units: single,
    noData: true,
    side: {
      file: "checkpoint/matter_index.jsonl",
      map: (row) => ({ id: row.id, n: row.display_number ?? null, c: row.client?.name ?? null }),
    },
  },
  users: {
    name: "users",
    endpoint: "/users.json",
    fieldSets: [`${USER_BASE},created_at,updated_at`, USER_BASE],
    columns: ["id", "name", "email", "enabled", "subscription_type", "initials", "created_at", "updated_at"],
    sinceParam: "updated_since",
    optional: false,
    units: single,
  },
  practice_areas: {
    name: "practice_areas",
    endpoint: "/practice_areas.json",
    fieldSets: ["id,name,code,created_at,updated_at", "id,name"],
    columns: null,
    sinceParam: null,
    optional: false,
    units: single,
  },
  custom_fields: {
    name: "custom_fields",
    endpoint: "/custom_fields.json",
    fieldSets: [CUSTOM_FIELD_DEFINITION_FIELDS],
    columns: ["id", "name", "field_type", "parent_type", "required", "displayed", "deleted", "picklist_options"],
    sinceParam: null,
    optional: false,
    units: single,
  },
  matter_stages: {
    name: "matter_stages",
    endpoint: "/matter_stages.json",
    fieldSets: [null],
    columns: null,
    sinceParam: null,
    optional: false,
    units: single,
  },
  matters: {
    name: "matters",
    endpoint: "/matters.json",
    fieldSets: [
      `${MATTER_BASE},${MATTER_EXTRA},${MATTER_PEOPLE},${CUSTOM_FIELD_VALUE_FIELDS}`,
      `${MATTER_BASE},${MATTER_EXTRA},${MATTER_PEOPLE}`,
      MATTER_BASE,
    ],
    columns: MATTER_COLUMNS,
    sinceParam: "updated_since",
    optional: false,
    units: single,
  },
  contacts: {
    name: "contacts",
    endpoint: "/contacts.json",
    fieldSets: [`${CONTACT_DETAIL_BASE},${CUSTOM_FIELD_VALUE_FIELDS}`, CONTACT_DETAIL_BASE, CONTACT_LIST_BASE],
    columns: [
      "id", "name", "first_name", "last_name", "title", "type", "company.id", "company.name", "email_addresses",
      "phone_numbers", "addresses", "created_at", "updated_at", "custom_field_values",
    ],
    sinceParam: "updated_since",
    optional: false,
    units: single,
  },
  relationships: {
    name: "relationships",
    endpoint: "/relationships.json",
    fieldSets: [`${RELATIONSHIP_BASE},created_at,updated_at`, RELATIONSHIP_BASE],
    columns: [
      "id", "description", "contact.id", "contact.name", "contact.type", "contact.primary_email_address",
      "contact.primary_phone_number", "matter.id", "matter.display_number", "created_at", "updated_at",
    ],
    sinceParam: "updated_since",
    optional: false,
    units: single,
  },
  tasks: {
    name: "tasks",
    endpoint: "/tasks.json",
    fieldSets: [`${TASK_BASE},created_at,updated_at`, TASK_BASE],
    columns: [
      "id", "name", "priority", "due_at", "status", "assignee.id", "assignee.name", "matter.id", "matter.display_number",
      "reminders", "created_at", "updated_at",
    ],
    sinceParam: "updated_since",
    optional: false,
    units: single,
  },
  calendar_entries: {
    name: "calendar_entries",
    endpoint: "/calendar_entries.json",
    fieldSets: [`${CALENDAR_BASE},created_at,updated_at`, CALENDAR_BASE],
    columns: [
      "id", "summary", "description", "start_at", "end_at", "matter.id", "matter.display_number", "attendees",
      "created_at", "updated_at",
    ],
    sinceParam: "updated_since",
    optional: false,
    units: calendarUnits,
  },
  notes: {
    name: "notes",
    endpoint: "/notes.json",
    fieldSets: [NOTE_FIELDS],
    columns: [
      "id", "subject", "detail", "detail_text_type", "date", "type", "matter.id", "matter.display_number", "contact.id",
      "contact.name", "author.id", "author.name", "created_at", "updated_at",
    ],
    sinceParam: "updated_since",
    optional: false,
    units: () => [
      { label: "matter notes", params: { type: "matter" } },
      { label: "contact notes", params: { type: "contact" } },
    ],
  },
  time_entries: {
    name: "time_entries",
    endpoint: "/activities.json",
    fieldSets: [`${ACTIVITY_BASE},type,created_at,updated_at`, ACTIVITY_BASE],
    columns: [
      "id", "type", "date", "quantity_in_hours", "price", "total", "note", "matter.id", "matter.display_number",
      "user.id", "user.name", "created_at", "updated_at",
    ],
    sinceParam: "updated_since",
    optional: false,
    units: () => [{ label: "time entries", params: { type: "TimeEntry" } }],
  },
  expenses: {
    name: "expenses",
    endpoint: "/activities.json",
    fieldSets: [`${EXPENSE_BASE},quantity,expense_category{id,name},created_at,updated_at`, `${EXPENSE_BASE},quantity,expense_category{id,name}`, EXPENSE_BASE],
    columns: [
      "id", "type", "date", "price", "total", "note", "quantity", "expense_category.id", "expense_category.name",
      "matter.id", "matter.display_number", "user.id", "user.name", "created_at", "updated_at",
    ],
    sinceParam: "updated_since",
    optional: false,
    units: () => [
      { label: "expense entries", params: { type: "ExpenseEntry" } },
      { label: "hard cost entries", params: { type: "HardCostEntry" } },
      { label: "soft cost entries", params: { type: "SoftCostEntry" } },
    ],
  },
  bills: {
    name: "bills",
    endpoint: "/bills.json",
    fieldSets: [`${BILL_BASE},created_at,updated_at`, BILL_BASE],
    columns: ["id", "number", "issued_at", "due_at", "balance", "total", "state", "created_at", "updated_at"],
    sinceParam: null,
    optional: false,
    units: single,
  },
  folders: {
    name: "folders",
    endpoint: "/folders.json",
    fieldSets: [`${FOLDER_BASE},created_at,updated_at`, `${FOLDER_BASE},created_at`, "id,name,parent{id,type},matter{id}"],
    columns: ["id", "name", "parent.id", "parent.type", "matter.id", "matter.display_number", "created_at", "updated_at"],
    sinceParam: null,
    optional: false,
    units: single,
    side: {
      file: "checkpoint/folder_index.jsonl",
      map: (row) => ({ i: row.id, p: row.parent?.id ?? null, m: row.matter?.id ?? null, n: row.name ?? "" }),
    },
  },
  communications: optionalAuto("communications"),
  allocations: optionalAuto("allocations"),
  trust_line_items: optionalAuto("trust_line_items"),
  bank_transactions: optionalAuto("bank_transactions"),
};

function optionalAuto(name: string): FlatTypeSpec {
  return {
    name,
    endpoint: `/${name}.json`,
    fieldSets: [null],
    columns: null,
    sinceParam: null,
    optional: true,
    units: single,
  };
}

export const FLAT_ORDER = [
  "users", "practice_areas", "custom_fields", "matter_stages", "matters", "contacts", "relationships", "tasks",
  "calendar_entries", "notes", "time_entries", "expenses", "bills", "folders",
  "communications", "allocations", "trust_line_items", "bank_transactions",
] as const;

export const DOCUMENT_FIELD_SETS = [
  "id,name,content_type,size,created_at,updated_at,matter{id,display_number},parent{id,type},latest_document_version{uuid,size}",
  "id,name,content_type,size,created_at,updated_at,matter{id,display_number},latest_document_version{uuid,size}",
  "id,name,content_type,size,created_at,matter{id,display_number},latest_document_version{uuid,size}",
];

export const DOCUMENT_COLUMNS = [
  "id", "name", "content_type", "size", "created_at", "updated_at", "matter.id", "matter.display_number", "parent.id",
  "parent.type", "latest_document_version.uuid", "latest_document_version.size", "export.status", "export.path",
];

export const SINCE_NOT_APPLIED_NOTE = "exported in full (no confirmed updated_since filter)";
