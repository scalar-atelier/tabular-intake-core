# tabular-intake-core

Deterministic CSV cleanup, comparison, and review classification for operational tables. It runs in Python, Node.js, or directly in a browser and emits byte-stable `cleaned.csv`, `review.csv`, `comparison.csv`, and a SHA-256 result manifest. The original intake-roster API remains compatible.

[Try the install-free demo](https://scalar-atelier.github.io/tabular-intake-core/) · [Company demo](https://scalar-inc.com/demo/tabular-intake/)

Files selected in the demo stay in browser memory. There is no upload, account, API key, telemetry, browser storage, or AI header inference.

## Install

```sh
python -m pip install scalar-tabular-intake==0.3.0
npm install @scalar-atelier/tabular-intake-core@0.3.0
```

The package release is `0.3.0`. The original deterministic intake contract remains `CORE_VERSION=0.1.0`, so existing WorkPacks and their output hashes remain compatible. Generic cleanup is versioned separately by `scalar-table-cleanup-profile/v1` and `scalar-table-cleanup-run/v1`.

## Clean an arbitrary table

Only declared columns are kept. The profile explicitly controls output names, transforms, required values, and duplicate keys; the library does not infer business rules or delete duplicate candidates.

```sh
scalar-tabular-intake cleanup \
  --source orders.csv \
  --previous orders-previous.csv \
  --profile cleanup-profile.json \
  --output out
```

```python
from scalar_tabular_intake import run_table_cleanup

result = run_table_cleanup(source_csv, {
    "schemaVersion": "scalar-table-cleanup-profile/v1",
    "columns": [
        {"source": "order_id", "output": "order_id", "transform": "text", "required": True},
        {"source": "phone", "output": "phone", "transform": "phone_kr", "required": False},
    ],
    "keyColumns": ["order_id"],
    "blankValues": ["", "-", "N/A"],
    "maxRows": 100000,
    "maxCellChars": 50000,
}, previous_csv)
```

```js
import { runTableCleanup } from "@scalar-atelier/tabular-intake-core";

const result = await runTableCleanup({ source, previous, profile });
```

The public JSON Schemas are in [`schema/`](schema/). Runtime validation is authoritative and fail-closed.

## Intake-roster compatibility

One source CSV, with optional history:

```sh
scalar-tabular-intake run \
  --source sample-pack/source.csv \
  --history sample-pack/history.csv \
  --rules sample-pack/rules.json \
  --output out
```

The original four-positional Python CLI remains supported.

```python
from scalar_tabular_intake import canonicalize_csv, run_intake

source = canonicalize_csv(
    raw_csv,
    kind="source",
    header_map={"신청자": "name", "전화": "phone", "생년월일": "date", "선택": "item"},
    generated_id="row_number",
)
result = run_intake(source, rules)  # history is optional
```

```js
import { canonicalizeCsv, runIntake } from "@scalar-atelier/tabular-intake-core";

const source = canonicalizeCsv(rawBytes, {
  kind: "source",
  headerMap: { 신청자: "name", 전화: "phone", 생년월일: "date", 선택: "item" },
  generatedId: "row_number",
});
const result = await runIntake({ source, rules });
```

`canonicalize_csv` / `canonicalizeCsv` also support a header row, copied roles, and the explicit `kr_resident_or_date` pre-normalizer. They never infer a mapping.

## Contract and safety

- Normalizes text, dates, decimal numbers, Korean mobile numbers, and explicit enum maps.
- Keeps only declared columns and never mutates the input bytes.
- Marks invalid values, missing required values, and user-keyed duplicate candidates for review instead of dropping them.
- Compares an optional previous table as added, changed, missing, same, duplicate, or review.
- Normalizes names, Korean mobile numbers, and dates in the original intake-roster API.
- Classifies exact and two-of-three duplicate candidates while preserving phone-only shared contacts.
- Checks participant and block history when a history CSV is supplied.
- Keeps the v0.1 normalized/review/manifest bytes as shared Python–TypeScript golden vectors.
- Rejects invalid UTF-8, malformed or ragged CSV, ambiguous mappings, duplicate IDs, oversized inputs, oversized rules, and formula-leading output cells.
- Limits each input to 20MiB, 100,000 data rows, 256 columns, and 50,000 characters per cell.

This repository contains only generic code and synthetic data. Customer headers, tab names, IDs, credentials, operational wording, and applicant data belong in a private binding.

## Read-only Google Sheets bridge

[`apps-script/read_bridge.gs`](apps-script/read_bridge.gs) exposes one HMAC-authenticated `snapshot_v1` action. Spreadsheet IDs and tab names are deployer-owned Script Properties, never request fields. The bridge reads the fixed source/history tabs and performs no write, trigger, SMS, or arbitrary external call.

## Non-goals

- Header inference, LLM rule generation, fuzzy duplicate deletion, or arbitrary code execution
- Spreadsheet writeback, trigger installation, OAuth, or credential storage
- Customer-specific labels or data in the public package

MIT licensed.
