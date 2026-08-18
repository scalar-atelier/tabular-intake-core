from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from .core import run_intake


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


def main(argv: Sequence[str] | None = None) -> None:
    args_list = list(argv) if argv is not None else None
    if args_list is not None and args_list[:1] == ["run"]:
        args_list = args_list[1:]
    elif args_list is None:
        import sys
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
