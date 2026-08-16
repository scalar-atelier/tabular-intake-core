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

CORE_VERSION = "0.1.0"
RULE_SCHEMA = "scalar-tabular-intake-rules/v1"
MANIFEST_SCHEMA = "scalar-tabular-intake-result/v1"
MAX_INPUT_BYTES = 20 * 1024 * 1024

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
        raise IntakeError("unknown_rule", f"unsupported phone profile: {profile}")
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
        raise IntakeError("unknown_rule", "rules must be an object")
    unknown = set(value) - RULE_KEYS
    if unknown:
        raise IntakeError("unknown_rule", f"unknown rule fields: {', '.join(sorted(unknown))}")
    if value.get("schemaVersion") != RULE_SCHEMA:
        raise IntakeError("unknown_rule", "unsupported rule schema")
    required = value.get("requiredFields")
    if not isinstance(required, list) or not required:
        raise IntakeError("unknown_rule", "requiredFields must be a non-empty list")
    allowed_required = {"name", "phone", "date", "item"}
    if any(not isinstance(item, str) or item not in allowed_required for item in required):
        raise IntakeError("unknown_rule", "requiredFields contains an unknown field")
    if len(set(required)) != len(required):
        raise IntakeError("unknown_rule", "requiredFields contains duplicates")

    def string_set(key: str) -> frozenset[str]:
        raw = value.get(key, [])
        if not isinstance(raw, list) or any(not isinstance(item, str) or not item.strip() for item in raw):
            raise IntakeError("unknown_rule", f"{key} must contain non-empty strings")
        return frozenset(item.strip() for item in raw)

    if value.get("phoneProfile") != "kr_mobile":
        raise IntakeError("unknown_rule", "phoneProfile must be kr_mobile")
    max_rows = value.get("maxRows", 50_000)
    max_cell_chars = value.get("maxCellChars", 10_000)
    if not isinstance(max_rows, int) or isinstance(max_rows, bool) or not 1 <= max_rows <= 100_000:
        raise IntakeError("unknown_rule", "maxRows is outside 1..100000")
    if not isinstance(max_cell_chars, int) or isinstance(max_cell_chars, bool) or not 1 <= max_cell_chars <= 100_000:
        raise IntakeError("unknown_rule", "maxCellChars is outside 1..100000")
    return Rules(
        required_fields=tuple(required),
        closed_item_values=string_set("closedItemValues"),
        history_block_values=string_set("historyBlockValues"),
        max_rows=max_rows,
        max_cell_chars=max_cell_chars,
    )


def _csv_rows(data: bytes, kind: str, rules: Rules) -> list[dict[str, str]]:
    if len(data) > MAX_INPUT_BYTES:
        raise IntakeError("oversized_input", f"{kind} CSV exceeds {MAX_INPUT_BYTES} bytes")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise IntakeError("invalid_csv", f"{kind} CSV must be UTF-8") from exc
    reader = csv.DictReader(io.StringIO(text, newline=""))
    required = SOURCE_REQUIRED if kind == "source" else HISTORY_REQUIRED
    optional = SOURCE_OPTIONAL if kind == "source" else HISTORY_OPTIONAL
    headers = tuple(reader.fieldnames or ())
    if len(headers) != len(set(headers)) or any(not header for header in headers):
        raise IntakeError("unknown_header", f"{kind} CSV has duplicate or blank headers")
    missing = set(required) - set(headers)
    unknown = set(headers) - set(required) - set(optional)
    if missing or unknown:
        detail = []
        if missing:
            detail.append("missing=" + ",".join(sorted(missing)))
        if unknown:
            detail.append("unknown=" + ",".join(sorted(unknown)))
        raise IntakeError("unknown_header", f"{kind} CSV header mismatch ({'; '.join(detail)})")
    rows: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    id_field = "source_id" if kind == "source" else "history_id"
    for raw in reader:
        if len(rows) >= rules.max_rows:
            raise IntakeError("oversized_input", f"{kind} CSV exceeds maxRows")
        row = {header: _text(raw.get(header)) for header in headers}
        if any(len(cell) > rules.max_cell_chars for cell in row.values()):
            raise IntakeError("oversized_input", f"{kind} CSV contains an oversized cell")
        if not any(row.values()):
            continue
        identifier = row[id_field]
        if not identifier or identifier in seen_ids:
            raise IntakeError("invalid_csv", f"{kind} {id_field} must be non-empty and unique")
        seen_ids.add(identifier)
        rows.append(row)
    return rows


def canonical_csv_from_snapshot(
    headers: Sequence[object],
    rows: Sequence[Sequence[object]],
    header_map: Mapping[str, str],
    kind: str,
) -> bytes:
    if kind not in {"source", "history"}:
        raise IntakeError("unknown_adapter", "snapshot kind must be source or history")
    raw_headers = [_text(header) for header in headers]
    if not raw_headers or len(raw_headers) != len(set(raw_headers)) or any(not item for item in raw_headers):
        raise IntakeError("unknown_header", "snapshot has duplicate or blank headers")
    allowed = set(SOURCE_REQUIRED + SOURCE_OPTIONAL if kind == "source" else HISTORY_REQUIRED + HISTORY_OPTIONAL)
    if set(header_map.values()) - allowed or len(set(header_map.values())) != len(header_map):
        raise IntakeError("unknown_header", "header map contains unknown or duplicate roles")
    if set(header_map) - set(raw_headers):
        raise IntakeError("unknown_header", "snapshot is missing a bound header")
    required = set(SOURCE_REQUIRED if kind == "source" else HISTORY_REQUIRED)
    if required - set(header_map.values()):
        raise IntakeError("unknown_header", "header map is missing a required role")
    selected = [(raw_headers.index(raw), role) for raw, role in header_map.items()]
    ordered_roles = [role for role in (SOURCE_REQUIRED + SOURCE_OPTIONAL if kind == "source" else HISTORY_REQUIRED + HISTORY_OPTIONAL) if role in header_map.values()]
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=ordered_roles, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        if len(row) != len(raw_headers):
            raise IntakeError("invalid_csv", "snapshot row width does not match its headers")
        mapped = {role: _text(row[index]) for index, role in selected}
        writer.writerow(mapped)
    return buffer.getvalue().encode("utf-8")


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
