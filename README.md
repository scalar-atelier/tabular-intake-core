# tabular-intake-core

Deterministic CSV normalization and review classification for real intake rosters. It runs in Python, Node.js, or directly in a browser and emits byte-stable `normalized.csv`, `review.csv`, and a SHA-256 result manifest.

## For roster operators: no installation

[Open the guided browser demo](https://scalar-atelier.github.io/tabular-intake-core/) · [Open the company demo](https://scalar-inc.com/demo/tabular-intake/)

Choose a registration or booking `.csv` saved from Excel or Google Sheets. The demo asks which columns contain the name, phone number, date, and application choice, then downloads a formatted outreach worklist and a separate check list. Files stay in browser memory. There is no upload, account, API key, telemetry, browser storage, or AI header inference. The demo does not decide messaging consent or recipients; an operator must make that final check.

## For developers: Python or npm

```sh
python -m pip install scalar-tabular-intake==0.2.2
npm install @scalar-atelier/tabular-intake-core@0.2.2
```

The package release is `0.2.2`. The deterministic transformation contract remains `CORE_VERSION=0.1.0`, so existing WorkPacks and their output hashes remain compatible.

## Run

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

- Normalizes names, Korean mobile numbers, and dates.
- Classifies exact and two-of-three duplicate candidates while preserving phone-only shared contacts.
- Checks participant and block history when a history CSV is supplied.
- Keeps the v0.1 normalized/review/manifest bytes as shared Python–TypeScript golden vectors.
- Rejects invalid UTF-8, malformed or ragged CSV, ambiguous mappings, duplicate IDs, oversized inputs, oversized rules, and formula-leading output cells.
- Limits each input to 20MiB, 100,000 data rows, 256 columns, and 50,000 characters per cell.

This repository contains only generic code and synthetic data. Customer headers, tab names, IDs, credentials, operational wording, and applicant data belong in a private binding.

## Read-only Google Sheets bridge

[`apps-script/read_bridge.gs`](apps-script/read_bridge.gs) exposes one HMAC-authenticated `snapshot_v1` action. Spreadsheet IDs and tab names are deployer-owned Script Properties, never request fields. The bridge reads the fixed source/history tabs and performs no write, trigger, SMS, or arbitrary external call.

## Non-goals

- Header inference, LLM rule generation, or arbitrary code execution
- Spreadsheet writeback, trigger installation, OAuth, or credential storage
- Customer-specific labels or data in the public package

MIT licensed.
