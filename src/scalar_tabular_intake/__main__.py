from __future__ import annotations

import argparse
import json
from pathlib import Path

from .core import run_csv_intake


def main() -> None:
    parser = argparse.ArgumentParser(description="Normalize a tabular intake pair")
    parser.add_argument("source", type=Path)
    parser.add_argument("history", type=Path)
    parser.add_argument("rules", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = run_csv_intake(
        args.source.read_bytes(),
        args.history.read_bytes(),
        json.loads(args.rules.read_text(encoding="utf-8")),
    )
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "normalized.csv").write_bytes(result.normalized_csv)
    (args.output / "review.csv").write_bytes(result.review_csv)
    (args.output / "result-manifest.json").write_bytes(result.manifest_json)


if __name__ == "__main__":
    main()
