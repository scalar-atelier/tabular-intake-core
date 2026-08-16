# scalar-tabular-intake

Deterministic, dependency-free intake normalization for CSV or a read-only Google Sheets snapshot. It normalizes names, Korean mobile numbers, and dates; classifies exact and two-of-three duplicate candidates; preserves phone-only shared contacts; checks participant history and block records; and emits byte-stable normalized/review CSV plus a result manifest.

This public repository contains only generic code and synthetic data. Customer headers, tab names, deployment IDs, credentials, operational wording, and applicant data belong in a private pack and binding.

## Install and verify

```sh
python -m pip install \
  "scalar-tabular-intake @ https://github.com/scalar-atelier/tabular-intake-core/releases/download/v0.1.0/scalar_tabular_intake-0.1.0-py3-none-any.whl"
python -m unittest discover -s tests -v
```

The package uses only the Python standard library. Its trust-boundary parsers reject unknown canonical headers, unknown rule fields, duplicate IDs, oversized input, and malformed snapshots before processing.

## Run the synthetic pack

```sh
scalar-tabular-intake \
  sample-pack/source.csv \
  sample-pack/history.csv \
  sample-pack/rules.json \
  out
```

The public API is `run_csv_intake(source_bytes, history_bytes, rules)`. A Google Apps Script response is converted through `canonical_csv_from_snapshot(...)`; the test suite proves that the CSV and snapshot routes produce identical output bytes and hashes.

## Google Sheets bridge

[`apps-script/read_bridge.gs`](apps-script/read_bridge.gs) supports one HMAC-authenticated `snapshot_v1` action. Spreadsheet ID and the source/history tab names are Script Properties fixed by the deployer, never request fields. The bridge reads only those two tabs, writes nothing, installs no trigger, calls no SMS or external service, and returns no logs containing row data.

Deploy it as a web app that executes as the deployer. Keep its endpoint and shared secret outside packs and bindings. Clients must restrict the initial URL to `script.google.com` and only follow Google ContentService redirects to `script.googleusercontent.com`.

## Non-goals

- Spreadsheet writeback or trigger installation
- SMS delivery
- OAuth or credential storage
- Arbitrary Python/code execution from packs
- Customer-specific status labels or header inference

MIT licensed.
