import { parse } from "csv-parse/browser/esm/sync";

export const PACKAGE_VERSION = "0.2.0";
export const CORE_VERSION = "0.1.0";
export const RULE_SCHEMA = "scalar-tabular-intake-rules/v1";
export const MANIFEST_SCHEMA = "scalar-tabular-intake-result/v1";
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_ROWS = 100_000;
export const MAX_COLUMNS = 256;
export const MAX_CELL_CHARS = 50_000;

const SOURCE_REQUIRED = ["source_id", "name", "phone", "date", "item"] as const;
const SOURCE_OPTIONAL = ["submitted_at"] as const;
const HISTORY_REQUIRED = ["history_id", "disposition", "name", "phone", "date"] as const;
const HISTORY_OPTIONAL = ["period", "category"] as const;
const OUTPUT_FIELDS = [
  "source_id", "submitted_at", "name", "phone", "date", "item",
  "intake_status", "review_codes", "history_match",
] as const;
const RULE_KEYS = new Set([
  "schemaVersion", "requiredFields", "closedItemValues", "historyBlockValues",
  "phoneProfile", "maxRows", "maxCellChars",
]);

export class IntakeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "IntakeError";
    this.code = code;
  }
}

export interface RuleValue {
  schemaVersion: string;
  requiredFields: string[];
  closedItemValues?: string[];
  historyBlockValues?: string[];
  phoneProfile: string;
  maxRows?: number;
  maxCellChars?: number;
  [key: string]: unknown;
}

interface Rules {
  requiredFields: string[];
  closedItemValues: Set<string>;
  historyBlockValues: Set<string>;
  maxRows: number;
  maxCellChars: number;
}

export interface CanonicalizeOptions {
  kind: "source" | "history";
  headerMap: Record<string, string>;
  headerRow?: number;
  generatedId?: "row_number";
  copyRoles?: Record<string, string>;
  preNormalizers?: Record<string, "kr_resident_or_date">;
}

export interface IntakeOutput {
  normalizedCsv: Uint8Array;
  reviewCsv: Uint8Array;
  manifestJson: Uint8Array;
  summary: Record<string, number>;
}

export interface RunIntakeInput {
  source: Uint8Array;
  history?: Uint8Array;
  rules: RuleValue;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function encode(value: string): Uint8Array {
  return encoder.encode(value);
}

const EMPTY_HISTORY_CSV = encode("history_id,disposition,name,phone,date,period,category\n");

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function charLength(value: string): number {
  return Array.from(value).length;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function sha256(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeName(value: unknown): string {
  return text(value).normalize("NFC").replace(/\s+/gu, "");
}

export function normalizePhone(value: unknown, profile = "kr_mobile"): string {
  if (profile !== "kr_mobile") throw new IntakeError("invalid_rules", `unsupported phone profile: ${profile}`);
  let digits = text(value).replace(/\D/g, "");
  if (/^10\d{8}$/.test(digits)) digits = `0${digits}`;
  if (/^8210\d{8}$/.test(digits)) digits = `0${digits.slice(2)}`;
  return /^01[016789]\d{7,8}$/.test(digits) ? digits : "";
}

export function normalizeDate(value: unknown): string {
  const raw = text(value);
  const separated = raw.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D*$/);
  const digits = separated
    ? `${separated[1]}${Number(separated[2]).toString().padStart(2, "0")}${Number(separated[3]).toString().padStart(2, "0")}`
    : raw.replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) return "";
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return "";
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function rules(value: RuleValue): Rules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntakeError("invalid_rules", "rules must be an object");
  }
  const unknown = Object.keys(value).filter(key => !RULE_KEYS.has(key));
  if (unknown.length) throw new IntakeError("invalid_rules", `unknown rule fields: ${unknown.sort().join(", ")}`);
  if (Object.values(value).some(item => item === undefined)) throw new IntakeError("invalid_rules", "rules cannot contain undefined values");
  if (value.schemaVersion !== RULE_SCHEMA) throw new IntakeError("invalid_rules", "unsupported rule schema");
  const required = value.requiredFields;
  const allowedRequired = new Set(["name", "phone", "date", "item"]);
  if (!Array.isArray(required) || required.length === 0 || required.some(item => typeof item !== "string" || !allowedRequired.has(item))) {
    throw new IntakeError("invalid_rules", "requiredFields contains an unknown field");
  }
  if (new Set(required).size !== required.length) throw new IntakeError("invalid_rules", "requiredFields contains duplicates");

  const stringSet = (key: "closedItemValues" | "historyBlockValues"): Set<string> => {
    const raw = value[key] ?? [];
    if (!Array.isArray(raw) || raw.some(item => typeof item !== "string" || !item.trim())) {
      throw new IntakeError("invalid_rules", `${key} must contain non-empty strings`);
    }
    if (raw.length > 100 || raw.some(item => charLength(item.trim()) > 200)) {
      throw new IntakeError("limit_exceeded", `${key} exceeds its public limits`);
    }
    return new Set(raw.map(item => item.trim()));
  };
  if (value.phoneProfile !== "kr_mobile") throw new IntakeError("invalid_rules", "phoneProfile must be kr_mobile");
  const maxRows = value.maxRows ?? 50_000;
  const maxCellChars = value.maxCellChars ?? 10_000;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) {
    throw new IntakeError("invalid_rules", `maxRows is outside 1..${MAX_ROWS}`);
  }
  if (!Number.isInteger(maxCellChars) || maxCellChars < 1 || maxCellChars > MAX_CELL_CHARS) {
    throw new IntakeError("invalid_rules", `maxCellChars is outside 1..${MAX_CELL_CHARS}`);
  }
  return {
    requiredFields: [...required],
    closedItemValues: stringSet("closedItemValues"),
    historyBlockValues: stringSet("historyBlockValues"),
    maxRows,
    maxCellChars,
  };
}

function csvTable(data: Uint8Array, kind: string): string[][] {
  if (!(data instanceof Uint8Array)) throw new IntakeError("malformed_csv", `${kind} CSV must be bytes`);
  if (data.byteLength > MAX_INPUT_BYTES) throw new IntakeError("limit_exceeded", `${kind} CSV exceeds ${MAX_INPUT_BYTES} bytes`);
  let decoded: string;
  try {
    decoded = decoder.decode(data).replace(/^\uFEFF/, "");
  } catch {
    throw new IntakeError("invalid_utf8", `${kind} CSV must be UTF-8`);
  }
  let table: string[][];
  try {
    table = parse(decoded, { bom: true, relax_column_count: true, skip_empty_lines: false }) as string[][];
  } catch {
    throw new IntakeError("malformed_csv", `${kind} CSV is malformed`);
  }
  if (table.length > MAX_ROWS + 101) throw new IntakeError("limit_exceeded", `${kind} CSV exceeds ${MAX_ROWS} data rows`);
  if (table.some(row => row.length > MAX_COLUMNS)) throw new IntakeError("limit_exceeded", `${kind} CSV exceeds ${MAX_COLUMNS} columns`);
  if (table.some(row => row.some(cell => charLength(cell) > MAX_CELL_CHARS))) {
    throw new IntakeError("limit_exceeded", `${kind} CSV contains a cell over ${MAX_CELL_CHARS} characters`);
  }
  return table;
}

function inputRows(data: Uint8Array, kind: "source" | "history", parsedRules: Rules): Record<string, string>[] {
  const table = csvTable(data, kind);
  const required = kind === "source" ? SOURCE_REQUIRED : HISTORY_REQUIRED;
  const optional = kind === "source" ? SOURCE_OPTIONAL : HISTORY_OPTIONAL;
  const headers = (table[0] ?? []).map(text);
  if (!headers.length || new Set(headers).size !== headers.length || headers.some(header => !header)) {
    throw new IntakeError("invalid_header_mapping", `${kind} CSV has duplicate or blank headers`);
  }
  const allowed = new Set<string>([...required, ...optional]);
  const missing = required.filter(field => !headers.includes(field));
  const unknown = headers.filter(field => !allowed.has(field));
  if (missing.length || unknown.length) throw new IntakeError("invalid_header_mapping", `${kind} CSV header mismatch`);
  const rows: Record<string, string>[] = [];
  const seen = new Set<string>();
  const idField = kind === "source" ? "source_id" : "history_id";
  for (const raw of table.slice(1)) {
    if (!raw.length || !raw.some(cell => text(cell))) continue;
    if (raw.length !== headers.length) throw new IntakeError("row_width_mismatch", `${kind} CSV row width differs from its header`);
    if (rows.length >= parsedRules.maxRows) throw new IntakeError("limit_exceeded", `${kind} CSV exceeds maxRows`);
    const row = Object.fromEntries(headers.map((header, index) => [header, text(raw[index])]));
    if (Object.values(row).some(cell => charLength(cell) > parsedRules.maxCellChars)) {
      throw new IntakeError("limit_exceeded", `${kind} CSV contains an oversized cell`);
    }
    const identifier = row[idField] ?? "";
    if (!identifier || seen.has(identifier)) throw new IntakeError("malformed_csv", `${kind} ${idField} must be non-empty and unique`);
    seen.add(identifier);
    rows.push(row);
  }
  return rows;
}

function residentOrDate(value: unknown): string {
  const raw = String(value ?? "");
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 13) {
    const marker = digits[6] ?? "";
    const century = "1256".includes(marker) ? "19" : "3478".includes(marker) ? "20" : "";
    if (century) return normalizeDate(`${century}${digits.slice(0, 6)}`);
  }
  return raw;
}

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeCsv(fields: readonly string[], rows: Record<string, string>[], guardFormulas = true): Uint8Array {
  if (guardFormulas) {
    for (const row of rows) {
      for (const field of fields) {
        if (/^[\x00-\x20]*[=+@-]/.test(String(row[field] ?? ""))) {
          throw new IntakeError("unsafe_spreadsheet_cell", `unsafe spreadsheet value in ${field}`);
        }
      }
    }
  }
  const lines = [fields.join(","), ...rows.map(row => fields.map(field => csvCell(row[field])).join(","))];
  return encode(`${lines.join("\n")}\n`);
}

function canonicalizeTable(
  headersValue: unknown[], rowsValue: unknown[][], options: CanonicalizeOptions,
): Uint8Array {
  const { kind, headerMap, generatedId, copyRoles = {}, preNormalizers = {} } = options;
  if (!(["source", "history"] as string[]).includes(kind)) throw new IntakeError("invalid_header_mapping", "CSV kind must be source or history");
  if (headersValue.length > MAX_COLUMNS || rowsValue.length > MAX_ROWS) throw new IntakeError("limit_exceeded", "CSV table exceeds its public limits");
  const headers = headersValue.map(text);
  if (!headers.length || new Set(headers).size !== headers.length || headers.some(header => !header)) {
    throw new IntakeError("invalid_header_mapping", "CSV has duplicate or blank headers");
  }
  const allowedOrder = kind === "source" ? [...SOURCE_REQUIRED, ...SOURCE_OPTIONAL] : [...HISTORY_REQUIRED, ...HISTORY_OPTIONAL];
  const allowed = new Set<string>(allowedOrder);
  const mapping = Object.fromEntries(Object.entries(headerMap ?? {}).map(([raw, role]) => [text(raw), text(role)]));
  const mappedRoles = Object.values(mapping);
  if (!Object.keys(mapping).length || mappedRoles.some(role => !allowed.has(role)) || new Set(mappedRoles).size !== mappedRoles.length
      || Object.entries(mapping).some(([raw, role]) => !raw || !role) || Object.keys(mapping).some(raw => !headers.includes(raw))) {
    throw new IntakeError("invalid_header_mapping", "header map contains an unknown, blank, missing, or duplicate role");
  }
  const copies = Object.fromEntries(Object.entries(copyRoles).map(([role, raw]) => [text(role), text(raw)]));
  if (Object.keys(copies).some(role => !allowed.has(role)) || Object.values(copies).some(raw => !raw || !headers.includes(raw))
      || Object.keys(copies).some(role => mappedRoles.includes(role))) {
    throw new IntakeError("invalid_header_mapping", "copy roles contain an unknown or duplicate role");
  }
  if (generatedId !== undefined && generatedId !== "row_number") throw new IntakeError("invalid_header_mapping", "generated ID must be row_number");
  const idRole = kind === "source" ? "source_id" : "history_id";
  if (generatedId && (mappedRoles.includes(idRole) || Object.hasOwn(copies, idRole))) {
    throw new IntakeError("invalid_header_mapping", "generated ID duplicates a mapped role");
  }
  const supplied = new Set([...mappedRoles, ...Object.keys(copies), ...(generatedId ? [idRole] : [])]);
  const required = kind === "source" ? SOURCE_REQUIRED : HISTORY_REQUIRED;
  if (required.some(role => !supplied.has(role))) throw new IntakeError("invalid_header_mapping", "header map is missing a required role");
  if (Object.keys(preNormalizers).some(role => role !== "date")
      || Object.values(preNormalizers).some(value => value !== "kr_resident_or_date")
      || (preNormalizers.date && !supplied.has("date"))) {
    throw new IntakeError("invalid_header_mapping", "unsupported pre-normalizer");
  }

  const indexes = new Map(headers.map((header, index) => [header, index]));
  const orderedRoles = allowedOrder.filter(role => supplied.has(role));
  const rows: Record<string, string>[] = [];
  rowsValue.forEach((raw, index) => {
    if (raw.length !== headers.length) throw new IntakeError("row_width_mismatch", "CSV row width does not match its headers");
    const values = raw.map(text);
    if (values.some(value => charLength(value) > MAX_CELL_CHARS)) throw new IntakeError("limit_exceeded", "CSV contains an oversized cell");
    const mapped: Record<string, string> = {};
    Object.entries(mapping).forEach(([header, role]) => { mapped[role] = values[indexes.get(header) ?? -1] ?? ""; });
    Object.entries(copies).forEach(([role, header]) => { mapped[role] = values[indexes.get(header) ?? -1] ?? ""; });
    if (generatedId) mapped[idRole] = String(index + 1);
    if (preNormalizers.date) mapped.date = residentOrDate(mapped.date);
    rows.push(mapped);
  });
  const result = writeCsv(orderedRoles, rows, false);
  if (result.byteLength > MAX_INPUT_BYTES) throw new IntakeError("limit_exceeded", "canonical CSV exceeds the public byte limit");
  return result;
}

export function canonicalizeCsv(data: Uint8Array, options: CanonicalizeOptions): Uint8Array {
  const headerRow = options.headerRow ?? 1;
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 100) {
    throw new IntakeError("invalid_header_mapping", "headerRow must be inside 1..100");
  }
  const table = csvTable(data, options.kind);
  if (headerRow > table.length) throw new IntakeError("invalid_header_mapping", "CSV does not contain the configured header row");
  return canonicalizeTable(table[headerRow - 1] ?? [], table.slice(headerRow), options);
}

function unique(values: string[]): string {
  return [...new Set(values)].join(" / ");
}

function compareText(left: string, right: string): number {
  const leftPoints = Array.from(left, value => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, value => value.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
  }
  return leftPoints.length - rightPoints.length;
}

type WorkingRecord = Record<string, string | number | string[]> & {
  index: number;
  intake_status: string;
  reasons: string[];
};

export async function runCsvIntake(sourceCsv: Uint8Array, historyCsv: Uint8Array, ruleValue: RuleValue): Promise<IntakeOutput> {
  const parsedRules = rules(ruleValue);
  const sourceRows = inputRows(sourceCsv, "source", parsedRules);
  const historyRows = inputRows(historyCsv, "history", parsedRules);
  const participantsPhone = new Map<string, string[]>();
  const participantsNameDate = new Map<string, string[]>();
  const blockedPhone = new Set<string>();
  const blockedNameDate = new Set<string>();
  for (const row of historyRows) {
    const name = normalizeName(row.name);
    const phone = normalizePhone(row.phone);
    const date = normalizeDate(row.date);
    const key = name && date ? `${name}|${date}` : "";
    if (parsedRules.historyBlockValues.has(text(row.disposition))) {
      if (phone) blockedPhone.add(phone);
      if (key) blockedNameDate.add(key);
      continue;
    }
    const detail = [text(row.period), text(row.category)].filter(Boolean).join(" ") || "matched";
    if (phone) participantsPhone.set(phone, [...(participantsPhone.get(phone) ?? []), detail]);
    if (key) participantsNameDate.set(key, [...(participantsNameDate.get(key) ?? []), detail]);
  }

  const records: WorkingRecord[] = sourceRows.map((row, index) => {
    const name = normalizeName(row.name);
    const phone = normalizePhone(row.phone);
    const date = normalizeDate(row.date);
    const item = text(row.item);
    const values: Record<string, string> = { name, phone, date, item };
    const reasons = parsedRules.requiredFields.filter(field => !values[field]).map(field => `missing_or_invalid_${field}`);
    let status = reasons.length ? "information_review" : "ready";
    if (parsedRules.closedItemValues.has(item)) {
      status = "closed";
      reasons.push("closed_item");
    }
    const key = name && date ? `${name}|${date}` : "";
    if (phone && blockedPhone.has(phone)) {
      status = "blocked";
      reasons.push("blocked_phone");
    } else if (key && blockedNameDate.has(key)) {
      status = "block_candidate";
      reasons.push("blocked_name_date");
    }
    const history = (phone ? participantsPhone.get(phone) : undefined) ?? (key ? participantsNameDate.get(key) : undefined) ?? [];
    return {
      index, source_id: row.source_id ?? "", submitted_at: row.submitted_at ?? "", name, phone, date, item,
      intake_status: status, reasons, history_match: unique(history),
    };
  });
  const eligible = records.filter(record => record.intake_status === "ready");
  const group = (fields: string[]): Map<string, WorkingRecord[]> => {
    const result = new Map<string, WorkingRecord[]>();
    for (const record of eligible) {
      if (record.intake_status !== "ready") continue;
      const parts = fields.map(field => String(record[field] ?? ""));
      if (!parts.every(Boolean)) continue;
      const key = canonicalJson(parts);
      result.set(key, [...(result.get(key) ?? []), record]);
    }
    return result;
  };
  for (const matches of group(["name", "date", "phone"]).values()) {
    if (matches.length > 1) matches.forEach(record => { record.intake_status = "duplicate_candidate"; record.reasons.push("exact_duplicate"); });
  }
  for (const [fields, differing, code] of [
    [["name", "date"], "phone", "name_date_match"],
    [["name", "phone"], "date", "name_phone_match"],
    [["phone", "date"], "name", "phone_date_match"],
  ] as [string[], string, string][]) {
    for (const matches of group(fields).values()) {
      if (matches.length > 1 && new Set(matches.map(record => String(record[differing] ?? ""))).size > 1) {
        matches.forEach(record => { record.intake_status = "duplicate_candidate"; record.reasons.push(code); });
      }
    }
  }
  records.sort((left, right) => compareText(String(left.submitted_at), String(right.submitted_at))
    || compareText(String(left.source_id), String(right.source_id)) || left.index - right.index);
  const outputRows = records.map(record => Object.fromEntries(OUTPUT_FIELDS.map(field => [
    field, field === "review_codes" ? [...new Set(record.reasons)].join("|") : String(record[field] ?? ""),
  ])));
  const reviewRows = outputRows.filter(row => row.intake_status !== "ready");
  const normalizedCsv = writeCsv(OUTPUT_FIELDS, outputRows);
  const reviewCsv = writeCsv(OUTPUT_FIELDS, reviewRows);
  const summary = {
    processed: outputRows.length,
    normal: outputRows.filter(row => row.intake_status === "ready").length,
    information_review: outputRows.filter(row => row.intake_status === "information_review").length,
    duplicate_candidate: outputRows.filter(row => row.intake_status === "duplicate_candidate").length,
    blocked_candidate: outputRows.filter(row => ["blocked", "block_candidate"].includes(String(row.intake_status ?? ""))).length,
    closed: outputRows.filter(row => row.intake_status === "closed").length,
  };
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    coreVersion: CORE_VERSION,
    sourceSha256: await sha256(sourceCsv),
    historySha256: await sha256(historyCsv),
    rulesSha256: await sha256(encode(canonicalJson(ruleValue))),
    normalizedSha256: await sha256(normalizedCsv),
    reviewSha256: await sha256(reviewCsv),
    summary,
  };
  return { normalizedCsv, reviewCsv, manifestJson: encode(`${canonicalJson(manifest)}\n`), summary };
}

export async function runIntake(input: RunIntakeInput): Promise<IntakeOutput> {
  return runCsvIntake(input.source, input.history ?? EMPTY_HISTORY_CSV, input.rules);
}
