from __future__ import annotations

import csv
import io
import json
import unittest
from pathlib import Path

from scalar_tabular_intake import (
    IntakeError,
    canonical_csv_from_snapshot,
    normalize_date,
    normalize_phone,
    run_csv_intake,
)

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "sample-pack"


def rows(data: bytes) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(data.decode("utf-8"))))


class IntakeCoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.source = (SAMPLE / "source.csv").read_bytes()
        self.history = (SAMPLE / "history.csv").read_bytes()
        self.rules = json.loads((SAMPLE / "rules.json").read_text(encoding="utf-8"))

    def test_cfriends_parity_rules_on_synthetic_data(self) -> None:
        self.assertEqual(normalize_phone("010-1234-5678"), "01012345678")
        self.assertEqual(normalize_phone("10 1234 5678"), "01012345678")
        self.assertEqual(normalize_phone("1234"), "")
        self.assertEqual(normalize_date("1990. 2. 3"), "1990-02-03")
        self.assertEqual(normalize_date("1999-02-30"), "")

        result = run_csv_intake(self.source, self.history, self.rules)
        self.assertEqual(result.normalized_csv, (SAMPLE / "expected-normalized.csv").read_bytes())
        self.assertEqual(result.review_csv, (SAMPLE / "expected-review.csv").read_bytes())
        self.assertEqual(result.manifest_json, (SAMPLE / "expected-result-manifest.json").read_bytes())
        by_id = {row["source_id"]: row for row in rows(result.normalized_csv)}
        self.assertEqual(result.summary, {
            "processed": 13,
            "normal": 4,
            "information_review": 2,
            "duplicate_candidate": 4,
            "blocked_candidate": 2,
            "closed": 1,
        })
        self.assertEqual(by_id["1"]["review_codes"], "exact_duplicate")
        self.assertEqual(by_id["4"]["review_codes"], "name_date_match")
        self.assertEqual(by_id["3"]["intake_status"], "ready")
        self.assertEqual(by_id["12"]["intake_status"], "ready")
        self.assertEqual(by_id["13"]["intake_status"], "ready")
        self.assertEqual(by_id["6"]["intake_status"], "information_review")
        self.assertEqual(by_id["7"]["history_match"], "2024 program-a")
        self.assertEqual(by_id["8"]["intake_status"], "blocked")
        self.assertEqual(by_id["9"]["intake_status"], "block_candidate")
        self.assertEqual(by_id["10"]["intake_status"], "information_review")
        self.assertEqual(by_id["11"]["intake_status"], "closed")

    def test_csv_and_apps_script_snapshot_are_byte_identical(self) -> None:
        source_table = list(csv.reader(io.StringIO(self.source.decode("utf-8"))))
        history_table = list(csv.reader(io.StringIO(self.history.decode("utf-8"))))
        source_map = {header: header for header in source_table[0]}
        history_map = {header: header for header in history_table[0]}
        from_snapshot_source = canonical_csv_from_snapshot(source_table[0], source_table[1:], source_map, "source")
        from_snapshot_history = canonical_csv_from_snapshot(history_table[0], history_table[1:], history_map, "history")
        csv_result = run_csv_intake(self.source, self.history, self.rules)
        snapshot_result = run_csv_intake(from_snapshot_source, from_snapshot_history, self.rules)
        self.assertEqual(from_snapshot_source, self.source)
        self.assertEqual(from_snapshot_history, self.history)
        self.assertEqual(snapshot_result.normalized_csv, csv_result.normalized_csv)
        self.assertEqual(snapshot_result.review_csv, csv_result.review_csv)
        self.assertEqual(snapshot_result.manifest_json, csv_result.manifest_json)

    def test_unknown_contract_and_oversized_input_fail_before_processing(self) -> None:
        unknown_rule = {**self.rules, "futureGuess": True}
        with self.assertRaisesRegex(IntakeError, "unknown rule fields") as rule_error:
            run_csv_intake(self.source, self.history, unknown_rule)
        self.assertEqual(rule_error.exception.code, "unknown_rule")

        unknown_header = self.source.replace(b"source_id,name", b"source_id,unexpected")
        with self.assertRaises(IntakeError) as header_error:
            run_csv_intake(unknown_header, self.history, self.rules)
        self.assertEqual(header_error.exception.code, "unknown_header")

        with self.assertRaises(IntakeError) as size_error:
            run_csv_intake(self.source, self.history, {**self.rules, "maxRows": 1})
        self.assertEqual(size_error.exception.code, "oversized_input")

    def test_public_tree_has_no_client_canary_and_bridge_has_no_writes(self) -> None:
        import base64

        canaries = [base64.b64decode(value).decode("utf-8") for value in (
            "Q2ZyaWVuZHM=",
            "7J2067ut7KKF6rWQ7Iqk7YWM7J20",
            "MXBtMzQ4eldXSlZMT1VqdTE1VTdqemIwbFhOMV9Cc0hiaE16OWtQUEtENDg=",
        )]
        for path in ROOT.rglob("*"):
            if not path.is_file() or path == Path(__file__) or ".git" in path.parts:
                continue
            if path.suffix not in {".py", ".json", ".csv", ".md", ".gs", ".toml"}:
                continue
            text = path.read_text(encoding="utf-8")
            for canary in canaries:
                self.assertNotIn(canary, text, str(path))
        bridge = (ROOT / "apps-script" / "read_bridge.gs").read_text(encoding="utf-8")
        for forbidden in (".setValue(", ".setValues(", "insertSheet(", "newTrigger(", "UrlFetchApp"):
            self.assertNotIn(forbidden, bridge)


if __name__ == "__main__":
    unittest.main()
