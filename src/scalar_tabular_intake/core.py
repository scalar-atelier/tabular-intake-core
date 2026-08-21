from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from typing import Iterable, Mapping, Sequence

PACKAGE_VERSION = "0.3.0"
CORE_VERSION = "0.1.0"
RULE_SCHEMA = "scalar-tabular-intake-rules/v1"
MANIFEST_SCHEMA = "scalar-tabular-intake-result/v1"
TABLE_CLEANUP_PROFILE_SCHEMA = "scalar-table-cleanup-profile/v1"
TABLE_CLEANUP_MANIFEST_SCHEMA = "scalar-table-cleanup-run/v1"
MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 256
MAX_CELL_CHARS = 50_000
MAX_RULE_ITEMS = 100
MAX_RULE_ITEM_CHARS = 200
MAX_HEADER_ROW = 100

SOURCE_REQUIRED = ("source_id", "name", "phone", "date", "item")
SOURCE_OPTIONAL = ("submitted_at",)
HISTORY_REQUIRED = ("history_id", "disposition", "name", "phone", "date")
HISTORY_OPTIONAL = ("period", "category")
OUTPUT_FIELDS = (
    "source_id",
    "submitted_at",
    "name",
    "phone",
    "date",
    "item",
    "intake_status",
    "review_codes",
    "history_match",
)
RULE_KEYS = {
    "schemaVersion",
    "requiredFields",
    "closedItemValues",
    "historyBlockValues",
    "phoneProfile",
    "maxRows",
    "maxCellChars",
}


class IntakeError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Rules:
    required_fields: tuple[str, ...]
    closed_item_values: frozenset[str]
    history_block_values: frozenset[str]
    max_rows: int
    max_cell_chars: int


@dataclass(frozen=True)
class IntakeOutput:
    normalized_csv: bytes
    review_csv: bytes
    manifest_json: bytes
    summary: Mapping[str, int]


@dataclass(frozen=True)
class CleanupColumn:
    source: str
    output: str
    transform: str
    required: bool
    enum_map: Mapping[str, str]


@dataclass(frozen=True)
class CleanupProfile:
    columns: tuple[CleanupColumn, ...]
    key_columns: tuple[str, ...]
    blank_values: frozenset[str]
    max_rows: int
    max_cell_chars: int


@dataclass(frozen=True)
class TableCleanupOutput:
    cleaned_csv: bytes
    review_csv: bytes
    comparison_csv: bytes
    manifest_json: bytes
    summary: Mapping[str, int]


def _canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _text(value: object) -> str:
    return "" if value is None else str(value).strip()


def normalize_name(value: object) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFC", _text(value)))


def normalize_phone(value: object, profile: str = "kr_mobile") -> str:
    if profile != "kr_mobile":
        raise IntakeError("invalid_rules", f"unsupported phone profile: {profile}")
    digits = re.sub(r"\D", "", _text(value))
    if re.fullmatch(r"10\d{8}", digits):
        digits = "0" + digits
    if digits.startswith("82") and re.fullmatch(r"8210\d{8}", digits):
        digits = "0" + digits[2:]
    return digits if re.fullmatch(r"01[016789]\d{7,8}", digits) else ""


def normalize_date(value: object) -> str:
    text = _text(value)
    separated = re.fullmatch(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D*", text)
    digits = (
        f"{separated.group(1)}{int(separated.group(2)):02d}{int(separated.group(3)):02d}"
        if separated
        else re.sub(r"\D", "", text)
    )
    if not re.fullmatch(r"\d{8}", digits):
        return ""
    try:
        parsed = date(int(digits[:4]), int(digits[4:6]), int(digits[6:8]))
    except ValueError:
        return ""
    return parsed.isoformat()


def _rules(value: Mapping[str, object]) -> Rules:
    if not isinstance(value, Mapping):
        raise IntakeError("invalid_rules", "rules must be an object")
    unknown = set(value) - RULE_KEYS
    if unknown:
        raise IntakeError("invalid_rules", f"unknown rule fields: {', '.join(sorted(unknown))}")
    if value.get("schemaVersion") != RULE_SCHEMA:
        raise IntakeError("invalid_rules", "unsupported rule schema")
    required = value.get("requiredFields")
    if not isinstance(required, list) or not required:
        raise IntakeError("invalid_rules", "requiredFields must be a non-empty list")
    allowed_required = {"name", "phone", "date", "item"}
    if any(not isinstance(item, str) or item not in allowed_required for item in required):
        raise IntakeError("invalid_rules", "requiredFields contains an unknown field")
    if len(set(required)) != len(required):
        raise IntakeError("invalid_rules", "requiredFields contains duplicates")

    def string_set(key: str) -> frozenset[str]:
        raw = value.get(key, [])
        if not isinstance(raw, list) or any(not isinstance(item, str) or not item.strip() for item in raw):
            raise IntakeError("invalid_rules", f"{key} must contain non-empty strings")
        if len(raw) > MAX_RULE_ITEMS or any(len(item.strip()) > MAX_RULE_ITEM_CHARS for item in raw):
            raise IntakeError("limit_exceeded", f"{key} exceeds its public limits")
        return frozenset(item.strip() for item in raw)

    if value.get("phoneProfile") != "kr_mobile":
        raise IntakeError("invalid_rules", "phoneProfile must be kr_mobile")
    max_rows = value.get("maxRows", 50_000)
    max_cell_chars = value.get("maxCellChars", 10_000)
    if not isinstance(max_rows, int) or isinstance(max_rows, bool) or not 1 <= max_rows <= MAX_ROWS:
        raise IntakeError("invalid_rules", f"maxRows is outside 1..{MAX_ROWS}")
    if (not isinstance(max_cell_chars, int) or isinstance(max_cell_chars, bool)
            or not 1 <= max_cell_chars <= MAX_CELL_CHARS):
        raise IntakeError("invalid_rules", f"maxCellChars is outside 1..{MAX_CELL_CHARS}")
    return Rules(
        required_fields=tuple(required),
        closed_item_values=string_set("closedItemValues"),
        history_block_values=string_set("historyBlockValues"),
        max_rows=max_rows,
        max_cell_chars=max_cell_chars,
    )


def _csv_table(data: bytes, kind: str) -> list[list[str]]:
    if not isinstance(data, bytes):
        raise IntakeError("malformed_csv", f"{kind} CSV must be bytes")
    if len(data) > MAX_INPUT_BYTES:
        raise IntakeError("limit_exceeded", f"{kind} CSV exceeds {MAX_INPUT_BYTES} bytes")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise IntakeError("invalid_utf8", f"{kind} CSV must be UTF-8") from exc
    try:
        table = list(csv.reader(io.StringIO(text, newline=""), strict=True))
    except csv.Error as exc:
        raise IntakeError("malformed_csv", f"{kind} CSV is malformed") from exc
    if len(table) > MAX_ROWS + MAX_HEADER_ROW + 1:
        raise IntakeError("limit_exceeded", f"{kind} CSV exceeds {MAX_ROWS} data rows")
    if any(len(row) > MAX_COLUMNS for row in table):
        raise IntakeError("limit_exceeded", f"{kind} CSV exceeds {MAX_COLUMNS} columns")
    if any(len(cell) > MAX_CELL_CHARS for row in table for cell in row):
        raise IntakeError("limit_exceeded", f"{kind} CSV contains a cell over {MAX_CELL_CHARS} characters")
    return table


def _csv_rows(data: bytes, kind: str, rules: Rules) -> list[dict[str, str]]:
    table = _csv_table(data, kind)
    required = SOURCE_REQUIRED if kind == "source" else HISTORY_REQUIRED
    optional = SOURCE_OPTIONAL if kind == "source" else HISTORY_OPTIONAL
    headers = tuple(_text(item) for item in (table[0] if table else ()))
    if len(headers) != len(set(headers)) or any(not header for header in headers):
        raise IntakeError("invalid_header_mapping", f"{kind} CSV has duplicate or blank headers")
    missing = set(required) - set(headers)
    unknown = set(headers) - set(required) - set(optional)
    if missing or unknown:
        detail = []
        if missing:
            detail.append("missing=" + ",".join(sorted(missing)))
        if unknown:
            detail.append("unknown=" + ",".join(sorted(unknown)))
        raise IntakeError("invalid_header_mapping", f"{kind} CSV header mismatch ({'; '.join(detail)})")
    rows: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    id_field = "source_id" if kind == "source" else "history_id"
    for raw in table[1:]:
        if not raw or not any(_text(cell) for cell in raw):
            continue
        if len(raw) != len(headers):
            raise IntakeError("row_width_mismatch", f"{kind} CSV row width differs from its header")
        if len(rows) >= rules.max_rows:
            raise IntakeError("limit_exceeded", f"{kind} CSV exceeds maxRows")
        row = {header: _text(raw[index]) for index, header in enumerate(headers)}
        if any(len(cell) > rules.max_cell_chars for cell in row.values()):
            raise IntakeError("limit_exceeded", f"{kind} CSV contains an oversized cell")
        identifier = row[id_field]
        if not identifier or identifier in seen_ids:
            raise IntakeError("malformed_csv", f"{kind} {id_field} must be non-empty and unique")
        seen_ids.add(identifier)
        rows.append(row)
    return rows


def _resident_or_date(value: object) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 13:
        century = "19" if digits[6] in "1256" else "20" if digits[6] in "3478" else ""
        if century:
            return normalize_date(century + digits[:6])
    return str(value or "")


def _canonicalize_table(
    headers: Sequence[object],
    rows: Sequence[Sequence[object]],
    header_map: Mapping[str, str],
    kind: str,
    *,
    generated_id: str | None = None,
    copy_roles: Mapping[str, str] | None = None,
    pre_normalizers: Mapping[str, str] | None = None,
) -> bytes:
    if kind not in {"source", "history"}:
        raise IntakeError("invalid_header_mapping", "CSV kind must be source or history")
    if len(headers) > MAX_COLUMNS or len(rows) > MAX_ROWS:
        raise IntakeError("limit_exceeded", "CSV table exceeds its public limits")
    raw_headers = [_text(header) for header in headers]
    if not raw_headers or len(raw_headers) != len(set(raw_headers)) or any(not item for item in raw_headers):
        raise IntakeError("invalid_header_mapping", "CSV has duplicate or blank headers")
    if any(len(item) > MAX_CELL_CHARS for item in raw_headers):
        raise IntakeError("limit_exceeded", "CSV contains an oversized header")
    if not isinstance(header_map, Mapping):
        raise IntakeError("invalid_header_mapping", "header map must be an object")
    allowed_order = SOURCE_REQUIRED + SOURCE_OPTIONAL if kind == "source" else HISTORY_REQUIRED + HISTORY_OPTIONAL
    allowed = set(allowed_order)
    mapping = {_text(raw): _text(role) for raw, role in header_map.items()}
    if (not mapping or set(mapping.values()) - allowed or len(set(mapping.values())) != len(mapping)
            or any(not raw or not role for raw, role in mapping.items())):
        raise IntakeError("invalid_header_mapping", "header map contains unknown, blank, or duplicate roles")
    if set(mapping) - set(raw_headers):
        raise IntakeError("invalid_header_mapping", "CSV is missing a bound header")

    copies = {_text(role): _text(raw) for role, raw in (copy_roles or {}).items()}
    if (set(copies) - allowed or any(not raw or raw not in raw_headers for raw in copies.values())
            or set(copies) & set(mapping.values())):
        raise IntakeError("invalid_header_mapping", "copy roles contain an unknown or duplicate role")
    if generated_id not in {None, "row_number"}:
        raise IntakeError("invalid_header_mapping", "generated ID must be row_number")
    id_role = "source_id" if kind == "source" else "history_id"
    if generated_id and (id_role in mapping.values() or id_role in copies):
        raise IntakeError("invalid_header_mapping", "generated ID duplicates a mapped role")
    supplied = set(mapping.values()) | set(copies)
    if generated_id:
        supplied.add(id_role)
    required = set(SOURCE_REQUIRED if kind == "source" else HISTORY_REQUIRED)
    if required - supplied:
        raise IntakeError("invalid_header_mapping", "header map is missing a required role")

    normalizers = dict(pre_normalizers or {})
    if set(normalizers) - {"date"} or any(value != "kr_resident_or_date" for value in normalizers.values()):
        raise IntakeError("invalid_header_mapping", "unsupported pre-normalizer")
    if "date" in normalizers and "date" not in supplied:
        raise IntakeError("invalid_header_mapping", "date pre-normalizer has no date role")

    indexes = {header: index for index, header in enumerate(raw_headers)}
    ordered_roles = [role for role in allowed_order if role in supplied]
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=ordered_roles, lineterminator="\n")
    writer.writeheader()
    for row_number, row in enumerate(rows, start=1):
        if len(row) != len(raw_headers):
            raise IntakeError("row_width_mismatch", "CSV row width does not match its headers")
        values = [_text(item) for item in row]
        if any(len(item) > MAX_CELL_CHARS for item in values):
            raise IntakeError("limit_exceeded", "CSV contains an oversized cell")
        mapped = {role: values[indexes[raw]] for raw, role in mapping.items()}
        mapped.update({role: values[indexes[raw]] for role, raw in copies.items()})
        if generated_id:
            mapped[id_role] = str(row_number)
        if normalizers.get("date"):
            mapped["date"] = _resident_or_date(mapped.get("date"))
        writer.writerow(mapped)
    result = buffer.getvalue().encode("utf-8")
    if len(result) > MAX_INPUT_BYTES:
        raise IntakeError("limit_exceeded", "canonical CSV exceeds the public byte limit")
    return result


def canonicalize_csv(
    data: bytes,
    *,
    kind: str,
    header_map: Mapping[str, str],
    header_row: int = 1,
    generated_id: str | None = None,
    copy_roles: Mapping[str, str] | None = None,
    pre_normalizers: Mapping[str, str] | None = None,
) -> bytes:
    if not isinstance(header_row, int) or isinstance(header_row, bool) or not 1 <= header_row <= MAX_HEADER_ROW:
        raise IntakeError("invalid_header_mapping", f"header_row must be inside 1..{MAX_HEADER_ROW}")
    table = _csv_table(data, kind)
    if header_row > len(table):
        raise IntakeError("invalid_header_mapping", "CSV does not contain the configured header row")
    return _canonicalize_table(
        table[header_row - 1], table[header_row:], header_map, kind,
        generated_id=generated_id, copy_roles=copy_roles, pre_normalizers=pre_normalizers,
    )


def canonical_csv_from_snapshot(
    headers: Sequence[object],
    rows: Sequence[Sequence[object]],
    header_map: Mapping[str, str],
    kind: str,
) -> bytes:
    return _canonicalize_table(headers, rows, header_map, kind)


def _history_index(rows: Iterable[Mapping[str, str]], rules: Rules) -> tuple[dict[str, list[str]], dict[str, list[str]], set[str], set[str]]:
    participants_phone: dict[str, list[str]] = {}
    participants_name_date: dict[str, list[str]] = {}
    blocked_phone: set[str] = set()
    blocked_name_date: set[str] = set()
    for row in rows:
        name = normalize_name(row.get("name"))
        phone = normalize_phone(row.get("phone"))
        normalized_date = normalize_date(row.get("date"))
        key = f"{name}|{normalized_date}" if name and normalized_date else ""
        disposition = _text(row.get("disposition"))
        if disposition in rules.history_block_values:
            if phone:
                blocked_phone.add(phone)
            if key:
                blocked_name_date.add(key)
            continue
        detail = " ".join(filter(None, (_text(row.get("period")), _text(row.get("category"))))) or "matched"
        if phone:
            participants_phone.setdefault(phone, []).append(detail)
        if key:
            participants_name_date.setdefault(key, []).append(detail)
    return participants_phone, participants_name_date, blocked_phone, blocked_name_date


def _unique(values: Iterable[str]) -> str:
    return " / ".join(dict.fromkeys(values))


def _csv_bytes(rows: Sequence[Mapping[str, str]]) -> bytes:
    for row in rows:
        for field in OUTPUT_FIELDS:
            value = str(row.get(field, ""))
            if re.match(r"^[\x00-\x20]*[=+@-]", value):
                raise IntakeError("unsafe_spreadsheet_cell", f"unsafe spreadsheet value in {field}")
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=OUTPUT_FIELDS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


def run_csv_intake(source_csv: bytes, history_csv: bytes, rule_value: Mapping[str, object]) -> IntakeOutput:
    rules = _rules(rule_value)
    source_rows = _csv_rows(source_csv, "source", rules)
    history_rows = _csv_rows(history_csv, "history", rules)
    participants_phone, participants_name_date, blocked_phone, blocked_name_date = _history_index(history_rows, rules)

    records: list[dict[str, object]] = []
    for index, row in enumerate(source_rows):
        name = normalize_name(row["name"])
        phone = normalize_phone(row["phone"])
        normalized_date = normalize_date(row["date"])
        item = _text(row["item"])
        values = {"name": name, "phone": phone, "date": normalized_date, "item": item}
        reasons = [f"missing_or_invalid_{field}" for field in rules.required_fields if not values[field]]
        status = "information_review" if reasons else "ready"
        if item in rules.closed_item_values:
            status = "closed"
            reasons.append("closed_item")
        name_date_key = f"{name}|{normalized_date}" if name and normalized_date else ""
        if phone and phone in blocked_phone:
            status = "blocked"
            reasons.append("blocked_phone")
        elif name_date_key and name_date_key in blocked_name_date:
            status = "block_candidate"
            reasons.append("blocked_name_date")
        history = participants_phone.get(phone) if phone else None
        history = history or (participants_name_date.get(name_date_key) if name_date_key else None)
        records.append({
            "index": index,
            "source_id": row["source_id"],
            "submitted_at": row.get("submitted_at", ""),
            "name": name,
            "phone": phone,
            "date": normalized_date,
            "item": item,
            "intake_status": status,
            "reasons": reasons,
            "history_match": _unique(history or ()),
        })

    eligible = [record for record in records if record["intake_status"] == "ready"]

    def group(indices: Sequence[str]) -> dict[tuple[str, ...], list[dict[str, object]]]:
        result: dict[tuple[str, ...], list[dict[str, object]]] = {}
        for record in eligible:
            if record["intake_status"] != "ready":
                continue
            key = tuple(str(record[field]) for field in indices)
            if all(key):
                result.setdefault(key, []).append(record)
        return result

    for matches in group(("name", "date", "phone")).values():
        if len(matches) > 1:
            for record in matches:
                record["intake_status"] = "duplicate_candidate"
                record["reasons"].append("exact_duplicate")

    for fields, differing, code in (
        (("name", "date"), "phone", "name_date_match"),
        (("name", "phone"), "date", "name_phone_match"),
        (("phone", "date"), "name", "phone_date_match"),
    ):
        for matches in group(fields).values():
            if len(matches) > 1 and len({str(record[differing]) for record in matches}) > 1:
                for record in matches:
                    record["intake_status"] = "duplicate_candidate"
                    record["reasons"].append(code)

    records.sort(key=lambda record: (str(record["submitted_at"]), str(record["source_id"]), int(record["index"])))
    output_rows = [{
        field: (
            "|".join(dict.fromkeys(record["reasons"]))
            if field == "review_codes"
            else str(record[field])
        )
        for field in OUTPUT_FIELDS
    } for record in records]
    review_rows = [row for row in output_rows if row["intake_status"] != "ready"]
    normalized_csv = _csv_bytes(output_rows)
    review_csv = _csv_bytes(review_rows)
    summary = {
        "processed": len(output_rows),
        "normal": sum(row["intake_status"] == "ready" for row in output_rows),
        "information_review": sum(row["intake_status"] == "information_review" for row in output_rows),
        "duplicate_candidate": sum(row["intake_status"] == "duplicate_candidate" for row in output_rows),
        "blocked_candidate": sum(row["intake_status"] in {"blocked", "block_candidate"} for row in output_rows),
        "closed": sum(row["intake_status"] == "closed" for row in output_rows),
    }
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA,
        "coreVersion": CORE_VERSION,
        "sourceSha256": _sha256(source_csv),
        "historySha256": _sha256(history_csv),
        "rulesSha256": _sha256(_canonical_json(rule_value)),
        "normalizedSha256": _sha256(normalized_csv),
        "reviewSha256": _sha256(review_csv),
        "summary": summary,
    }
    return IntakeOutput(
        normalized_csv=normalized_csv,
        review_csv=review_csv,
        manifest_json=_canonical_json(manifest) + b"\n",
        summary=summary,
    )


EMPTY_HISTORY_CSV = b"history_id,disposition,name,phone,date,period,category\n"


def run_intake(
    source_csv: bytes,
    rule_value: Mapping[str, object],
    history_csv: bytes | None = None,
) -> IntakeOutput:
    return run_csv_intake(source_csv, EMPTY_HISTORY_CSV if history_csv is None else history_csv, rule_value)


_CLEANUP_PROFILE_KEYS = {
    "schemaVersion", "columns", "keyColumns", "blankValues", "maxRows", "maxCellChars",
}
_CLEANUP_COLUMN_KEYS = {"source", "output", "transform", "required", "enumMap"}
_CLEANUP_TRANSFORMS = {"text", "date_ymd", "number", "phone_kr", "enum"}
_CLEANUP_RESERVED = {
    "_atelier_status", "_atelier_review", "_atelier_change", "_atelier_changed_columns",
}


def _cleanup_profile(value: Mapping[str, object]) -> CleanupProfile:
    if not isinstance(value, Mapping):
        raise IntakeError("invalid_profile", "profile must be an object")
    unknown = set(value) - _CLEANUP_PROFILE_KEYS
    if unknown:
        raise IntakeError("invalid_profile", f"unknown profile fields: {', '.join(sorted(unknown))}")
    if value.get("schemaVersion") != TABLE_CLEANUP_PROFILE_SCHEMA:
        raise IntakeError("invalid_profile", "unsupported profile schema")
    raw_columns = value.get("columns")
    if not isinstance(raw_columns, list) or not 1 <= len(raw_columns) <= MAX_COLUMNS:
        raise IntakeError("invalid_profile", f"columns must contain 1..{MAX_COLUMNS} items")

    columns: list[CleanupColumn] = []
    seen_sources: set[str] = set()
    seen_outputs: set[str] = set()
    for raw in raw_columns:
        if not isinstance(raw, Mapping) or set(raw) - _CLEANUP_COLUMN_KEYS:
            raise IntakeError("invalid_profile", "column rules contain unknown fields")
        source = _text(raw.get("source"))
        output = _text(raw.get("output"))
        transform = _text(raw.get("transform"))
        required = raw.get("required", False)
        if (not source or not output or len(source) > MAX_RULE_ITEM_CHARS or len(output) > MAX_RULE_ITEM_CHARS
                or any(char in source + output for char in "\x00\r\n")):
            raise IntakeError("invalid_profile", "column source and output must be short single-line strings")
        if re.match(r"^[\x00-\x20]*[=+@-]", output) or output in _CLEANUP_RESERVED:
            raise IntakeError("invalid_profile", "column output uses a reserved or unsafe name")
        if source in seen_sources or output in seen_outputs:
            raise IntakeError("invalid_profile", "column source and output names must be unique")
        if transform not in _CLEANUP_TRANSFORMS or not isinstance(required, bool):
            raise IntakeError("invalid_profile", "column transform or required flag is invalid")
        raw_enum = raw.get("enumMap", {})
        if not isinstance(raw_enum, Mapping) or len(raw_enum) > MAX_RULE_ITEMS:
            raise IntakeError("invalid_profile", "enumMap must be a small object")
        enum_map: dict[str, str] = {}
        for enum_source, enum_output in raw_enum.items():
            if not isinstance(enum_source, str) or not isinstance(enum_output, str):
                raise IntakeError("invalid_profile", "enumMap keys and values must be strings")
            enum_source, enum_output = enum_source.strip(), enum_output.strip()
            if (not enum_source or not enum_output or len(enum_source) > MAX_RULE_ITEM_CHARS
                    or len(enum_output) > MAX_RULE_ITEM_CHARS):
                raise IntakeError("invalid_profile", "enumMap contains a blank or oversized item")
            enum_map[enum_source] = enum_output
        if (transform == "enum") != bool(enum_map):
            raise IntakeError("invalid_profile", "enum transform requires enumMap and other transforms forbid it")
        columns.append(CleanupColumn(source, output, transform, required, enum_map))
        seen_sources.add(source)
        seen_outputs.add(output)

    raw_keys = value.get("keyColumns", [])
    if (not isinstance(raw_keys, list) or len(raw_keys) > len(columns)
            or any(not isinstance(item, str) or item not in seen_outputs for item in raw_keys)
            or len(set(raw_keys)) != len(raw_keys)):
        raise IntakeError("invalid_profile", "keyColumns must contain unique output column names")
    raw_blanks = value.get("blankValues", ["", "-", "N/A", "n/a"])
    if (not isinstance(raw_blanks, list) or len(raw_blanks) > MAX_RULE_ITEMS
            or any(not isinstance(item, str) or len(item) > MAX_RULE_ITEM_CHARS for item in raw_blanks)):
        raise IntakeError("invalid_profile", "blankValues must contain short strings")
    max_rows = value.get("maxRows", 50_000)
    max_cell_chars = value.get("maxCellChars", 10_000)
    if not isinstance(max_rows, int) or isinstance(max_rows, bool) or not 1 <= max_rows <= MAX_ROWS:
        raise IntakeError("invalid_profile", f"maxRows is outside 1..{MAX_ROWS}")
    if (not isinstance(max_cell_chars, int) or isinstance(max_cell_chars, bool)
            or not 1 <= max_cell_chars <= MAX_CELL_CHARS):
        raise IntakeError("invalid_profile", f"maxCellChars is outside 1..{MAX_CELL_CHARS}")
    return CleanupProfile(
        columns=tuple(columns),
        key_columns=tuple(raw_keys),
        blank_values=frozenset(item.strip() for item in raw_blanks) | {""},
        max_rows=max_rows,
        max_cell_chars=max_cell_chars,
    )


def validate_table_cleanup_profile(value: Mapping[str, object]) -> None:
    """Validate a cleanup profile without reading or mutating user data."""
    _cleanup_profile(value)


def _normalize_number(value: str) -> str:
    compact = re.sub(r"[\s,]", "", value)
    match = re.fullmatch(r"([+-]?)(\d+)(?:\.(\d+))?", compact)
    if not match:
        return ""
    integer = match.group(2).lstrip("0") or "0"
    fraction = (match.group(3) or "").rstrip("0")
    sign = "-" if match.group(1) == "-" and (integer != "0" or fraction) else ""
    return sign + integer + (f".{fraction}" if fraction else "")


def _cleanup_rows(data: bytes, profile: CleanupProfile, kind: str) -> list[dict[str, object]]:
    table = _csv_table(data, kind)
    headers = tuple(_text(item) for item in (table[0] if table else ()))
    if not headers or len(headers) != len(set(headers)) or any(not item for item in headers):
        raise IntakeError("invalid_header_mapping", f"{kind} CSV has duplicate or blank headers")
    missing = {column.source for column in profile.columns} - set(headers)
    if missing:
        raise IntakeError("invalid_header_mapping", f"{kind} CSV is missing configured columns")
    indexes = {header: index for index, header in enumerate(headers)}
    rows: list[dict[str, object]] = []
    for raw in table[1:]:
        if not raw or not any(_text(cell) for cell in raw):
            continue
        if len(raw) != len(headers):
            raise IntakeError("row_width_mismatch", f"{kind} CSV row width differs from its header")
        if len(rows) >= profile.max_rows:
            raise IntakeError("limit_exceeded", f"{kind} CSV exceeds maxRows")
        if any(len(cell) > profile.max_cell_chars for cell in raw):
            raise IntakeError("limit_exceeded", f"{kind} CSV contains an oversized cell")
        values: dict[str, str] = {}
        reasons: list[str] = []
        invalid_outputs: set[str] = set()
        for column in profile.columns:
            original = _text(raw[indexes[column.source]])
            cleaned = "" if original in profile.blank_values else original
            normalized = cleaned
            invalid = False
            if cleaned and column.transform == "date_ymd":
                normalized = normalize_date(cleaned)
                invalid = not normalized
            elif cleaned and column.transform == "number":
                normalized = _normalize_number(cleaned)
                invalid = not normalized
            elif cleaned and column.transform == "phone_kr":
                normalized = normalize_phone(cleaned)
                invalid = not normalized
            elif cleaned and column.transform == "enum":
                normalized = column.enum_map.get(cleaned, "")
                invalid = not normalized
            if invalid:
                normalized = cleaned
                invalid_outputs.add(column.output)
                reasons.append(f"invalid:{column.output}")
            if column.required and not normalized:
                reasons.append(f"missing:{column.output}")
                invalid_outputs.add(column.output)
            values[column.output] = normalized
        rows.append({"values": values, "reasons": reasons, "invalid_outputs": invalid_outputs})

    groups: dict[tuple[str, ...], list[dict[str, object]]] = {}
    for row in rows:
        values = row["values"]
        invalid_outputs = row["invalid_outputs"]
        assert isinstance(values, dict) and isinstance(invalid_outputs, set)
        key = tuple(str(values.get(column, "")) for column in profile.key_columns)
        if profile.key_columns and all(key) and not (set(profile.key_columns) & invalid_outputs):
            groups.setdefault(key, []).append(row)
    for matches in groups.values():
        if len(matches) > 1:
            for row in matches:
                reasons = row["reasons"]
                assert isinstance(reasons, list)
                reasons.append("duplicate:key")
    for row in rows:
        reasons = row["reasons"]
        assert isinstance(reasons, list)
        row["status"] = "duplicate_candidate" if "duplicate:key" in reasons else "review" if reasons else "ready"
    return rows


def _cleanup_export_rows(rows: Sequence[Mapping[str, object]]) -> list[dict[str, str]]:
    exported: list[dict[str, str]] = []
    for row in rows:
        values = dict(row["values"])
        reasons = row["reasons"]
        assert isinstance(reasons, list)
        values["_atelier_status"] = str(row["status"])
        values["_atelier_review"] = "|".join(dict.fromkeys(str(item) for item in reasons))
        exported.append({key: str(value) for key, value in values.items()})
    return exported


def _cleanup_csv(fields: Sequence[str], rows: Sequence[Mapping[str, str]], numeric_fields: set[str]) -> bytes:
    for row in rows:
        for field in fields:
            value = str(row.get(field, ""))
            if re.match(r"^[\x00-\x20]*[=+@-]", value) and not (
                field in numeric_fields and bool(re.fullmatch(r"-?\d+(?:\.\d+)?", value))
            ):
                raise IntakeError("unsafe_spreadsheet_cell", f"unsafe spreadsheet value in {field}")
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


def _comparison_rows(
    current: Sequence[Mapping[str, object]], previous: Sequence[Mapping[str, object]], profile: CleanupProfile,
) -> tuple[list[dict[str, str]], dict[str, int]]:
    summary = {name: 0 for name in ("added", "changed", "missing", "same", "duplicate", "review")}
    if not previous:
        return [], summary

    def key(row: Mapping[str, object]) -> tuple[str, ...]:
        values = row["values"]
        assert isinstance(values, dict)
        return tuple(str(values.get(column, "")) for column in profile.key_columns)

    current_groups: dict[tuple[str, ...], list[Mapping[str, object]]] = {}
    previous_groups: dict[tuple[str, ...], list[Mapping[str, object]]] = {}
    for row in current:
        current_groups.setdefault(key(row), []).append(row)
    for row in previous:
        previous_groups.setdefault(key(row), []).append(row)
    output: list[dict[str, str]] = []
    seen: set[tuple[str, ...]] = set()

    def append(change: str, row: Mapping[str, object], changed: Sequence[str] = ()) -> None:
        values = _cleanup_export_rows([row])[0]
        output.append({"_atelier_change": change, "_atelier_changed_columns": "|".join(changed), **values})
        summary[change] += 1

    for row in current:
        row_key = key(row)
        if not profile.key_columns or not all(row_key):
            append("review", row, profile.key_columns)
            continue
        if len(current_groups[row_key]) > 1 or len(previous_groups.get(row_key, ())) > 1:
            append("duplicate", row)
            seen.add(row_key)
            continue
        old = previous_groups.get(row_key)
        if not old:
            append("added", row)
        else:
            current_values, previous_values = row["values"], old[0]["values"]
            assert isinstance(current_values, dict) and isinstance(previous_values, dict)
            changed = [column.output for column in profile.columns
                       if current_values.get(column.output) != previous_values.get(column.output)]
            append("changed" if changed else "same", row, changed)
        seen.add(row_key)
    for row in previous:
        row_key = key(row)
        if not profile.key_columns or not all(row_key) or row_key in seen:
            continue
        append("duplicate" if len(previous_groups[row_key]) > 1 else "missing", row)
        seen.add(row_key)
    return output, summary


def run_table_cleanup(
    source_csv: bytes,
    profile_value: Mapping[str, object],
    previous_csv: bytes | None = None,
) -> TableCleanupOutput:
    profile = _cleanup_profile(profile_value)
    current = _cleanup_rows(source_csv, profile, "source")
    previous = _cleanup_rows(previous_csv, profile, "previous") if previous_csv is not None else []
    fields = [column.output for column in profile.columns] + ["_atelier_status", "_atelier_review"]
    numeric_fields = {column.output for column in profile.columns if column.transform == "number"}
    cleaned_rows = _cleanup_export_rows(current)
    review_rows = [row for row in cleaned_rows if row["_atelier_status"] != "ready"]
    comparison_rows, comparison_summary = _comparison_rows(current, previous, profile)
    cleaned_csv = _cleanup_csv(fields, cleaned_rows, numeric_fields)
    review_csv = _cleanup_csv(fields, review_rows, numeric_fields)
    comparison_fields = ["_atelier_change", "_atelier_changed_columns", *fields]
    comparison_csv = _cleanup_csv(comparison_fields, comparison_rows, numeric_fields)
    summary = {
        "processed": len(cleaned_rows),
        "normal": sum(row["_atelier_status"] == "ready" for row in cleaned_rows),
        "review": sum(row["_atelier_status"] == "review" for row in cleaned_rows),
        "duplicate_candidate": sum(row["_atelier_status"] == "duplicate_candidate" for row in cleaned_rows),
        **{f"comparison_{key}": value for key, value in comparison_summary.items()},
    }
    source_hash = _sha256(source_csv)
    previous_hash = _sha256(previous_csv) if previous_csv is not None else None
    profile_hash = _sha256(_canonical_json(profile_value))
    operation_id = "tc_" + _sha256(_canonical_json({
        "sourceSha256": source_hash, "previousSha256": previous_hash, "profileSha256": profile_hash,
    }))[:24]
    manifest = {
        "schemaVersion": TABLE_CLEANUP_MANIFEST_SCHEMA,
        "coreVersion": CORE_VERSION,
        "operationId": operation_id,
        "sourceSha256": source_hash,
        "previousSha256": previous_hash,
        "profileSha256": profile_hash,
        "cleanedSha256": _sha256(cleaned_csv),
        "reviewSha256": _sha256(review_csv),
        "comparisonSha256": _sha256(comparison_csv),
        "summary": summary,
    }
    return TableCleanupOutput(
        cleaned_csv=cleaned_csv,
        review_csv=review_csv,
        comparison_csv=comparison_csv,
        manifest_json=_canonical_json(manifest) + b"\n",
        summary=summary,
    )
