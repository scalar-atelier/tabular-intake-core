from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from .core import run_intake, run_table_cleanup


def _write_result(source: Path, rules: Path, output: Path, history: Path | None) -> None:
    result = run_intake(
        source.read_bytes(),
        json.loads(rules.read_text(encoding="utf-8")),
        history.read_bytes() if history else None,
    )
    output.mkdir(parents=True, exist_ok=True)
    (output / "normalized.csv").write_bytes(result.normalized_csv)
    (output / "review.csv").write_bytes(result.review_csv)
    (output / "result-manifest.json").write_bytes(result.manifest_json)


def _write_cleanup(source: Path, profile: Path, output: Path, previous: Path | None) -> None:
    result = run_table_cleanup(
        source.read_bytes(),
        json.loads(profile.read_text(encoding="utf-8")),
        previous.read_bytes() if previous else None,
    )
    output.mkdir(parents=True, exist_ok=True)
    (output / "cleaned.csv").write_bytes(result.cleaned_csv)
    (output / "review.csv").write_bytes(result.review_csv)
    (output / "comparison.csv").write_bytes(result.comparison_csv)
    (output / "result-manifest.json").write_bytes(result.manifest_json)


def main(argv: Sequence[str] | None = None) -> None:
    args_list = list(argv) if argv is not None else None
    if args_list is not None and args_list[:1] == ["cleanup"]:
        parser = argparse.ArgumentParser(description="Clean and compare a generic CSV table")
        parser.add_argument("--source", type=Path, required=True)
        parser.add_argument("--previous", type=Path)
        parser.add_argument("--profile", type=Path, required=True)
        parser.add_argument("--output", type=Path, required=True)
        args = parser.parse_args(args_list[1:])
        _write_cleanup(args.source, args.profile, args.output, args.previous)
        return
    if args_list is not None and args_list[:1] == ["run"]:
        args_list = args_list[1:]
    elif args_list is None:
        import sys
        if sys.argv[1:2] == ["cleanup"]:
            main(sys.argv[1:])
            return
        if sys.argv[1:2] == ["run"]:
            args_list = sys.argv[2:]
    if args_list is not None:
        parser = argparse.ArgumentParser(description="Normalize tabular intake CSV files")
        parser.add_argument("--source", type=Path, required=True)
        parser.add_argument("--history", type=Path)
        parser.add_argument("--rules", type=Path, required=True)
        parser.add_argument("--output", type=Path, required=True)
        args = parser.parse_args(args_list)
        _write_result(args.source, args.rules, args.output, args.history)
        return

    parser = argparse.ArgumentParser(description="Normalize a tabular intake pair")
    parser.add_argument("source", type=Path)
    parser.add_argument("history", type=Path)
    parser.add_argument("rules", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    _write_result(args.source, args.rules, args.output, args.history)


if __name__ == "__main__":
    main()
