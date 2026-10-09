import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  CORE_VERSION,
  PACKAGE_VERSION,
  IntakeError,
  canonicalizeCsv,
  normalizeDate,
  normalizePhone,
  runCsvIntake,
  runIntake,
  runTableCleanup,
} from "../../dist-js/core.js";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sample = resolve(root, "sample-pack");
const encoder = new TextEncoder();

const cleanupProfile = {
  schemaVersion: "scalar-table-cleanup-profile/v1",
  columns: [
    { source: "order_id", output: "주문번호", transform: "text", required: true },
    { source: "customer", output: "고객명", transform: "text", required: true },
    { source: "phone", output: "연락처", transform: "phone_kr", required: true },
    { source: "order_date", output: "주문일", transform: "date_ymd", required: true },
    { source: "status", output: "상태", transform: "enum", required: true,
      enumMap: { done: "완료", shipping: "배송중", cancelled: "취소" } },
    { source: "amount", output: "금액", transform: "number", required: false },
  ],
  keyColumns: ["주문번호"],
  blankValues: ["", "-", "N/A"],
  maxRows: 100,
  maxCellChars: 1000,
};
const cleanupSource = encoder.encode(
  "order_id,customer,phone,order_date,status,amount,note\n"
  + "1001, 김철수 ,010-1234-5678,2024-7-1,done,\"120,000\",ignored\n"
  + "1002,이영희,01012345679,2024/07/02,shipping,85000,ignored\n"
  + "1003,박민수,010-1234-5678,2024.07.02,done,95000,ignored\n"
  + "1003,박민수,010-1234-5678,2024.07.02,done,95000,ignored\n"
  + "1004,최지우,bad,2024-07-03,cancelled,-50000,ignored\n",
);
const cleanupPrevious = encoder.encode(
  "order_id,customer,phone,order_date,status,amount,note\n"
  + "1001,김철수,01012345678,2024-07-01,done,100000,ignored\n"
  + "1002,이영희,01012345679,2024-07-02,shipping,85000,ignored\n"
  + "1005,정하나,010-5555-6666,2024-07-03,done,200000,ignored\n",
);

test("Python golden pack stays byte-identical in TypeScript", async () => {
  const [source, history, rules, normalized, review, manifest] = await Promise.all([
    readFile(resolve(sample, "source.csv")),
    readFile(resolve(sample, "history.csv")),
    readFile(resolve(sample, "rules.json"), "utf8").then(JSON.parse),
    readFile(resolve(sample, "expected-normalized.csv")),
    readFile(resolve(sample, "expected-review.csv")),
    readFile(resolve(sample, "expected-result-manifest.json")),
  ]);
  const result = await runCsvIntake(source, history, rules);
  assert.deepEqual(Buffer.from(result.normalizedCsv), normalized);
  assert.deepEqual(Buffer.from(result.reviewCsv), review);
  assert.deepEqual(Buffer.from(result.manifestJson), manifest);
  assert.deepEqual(result.summary, {
    processed: 13,
    normal: 4,
    information_review: 2,
    duplicate_candidate: 4,
    blocked_candidate: 2,
    closed: 1,
  });
  assert.deepEqual([PACKAGE_VERSION, CORE_VERSION], ["0.3.0", "0.1.1"]);
  assert.equal(normalizePhone("+82 10-1234-5678"), "01012345678");
  assert.equal(normalizeDate("1990. 2. 3"), "1990-02-03");
});

test("shared public adapter vectors stay byte-identical", async () => {
  const vectors = JSON.parse(await readFile(resolve(root, "contract-vectors/v1/canonicalization.json"), "utf8"));
  for (const fixture of vectors.cases) {
    const actual = canonicalizeCsv(encoder.encode(fixture.input), fixture.options);
    assert.equal(new TextDecoder().decode(actual), fixture.expected, fixture.name);
  }
  const source = encoder.encode("source_id,name,phone,date,item\n1,Example,010-1234-5678,1990-02-03,open\n");
  const result = await runIntake({
    source,
    rules: JSON.parse(await readFile(resolve(sample, "rules.json"), "utf8")),
  });
  assert.equal(result.summary.processed, 1);
});

test("trust-boundary errors match the public codes without mutating input", async () => {
  const source = encoder.encode("name,phone,date,item\nExample,010-1234-5678,1990-02-03,open\n");
  const before = Buffer.from(source);
  canonicalizeCsv(source, {
    kind: "source",
    headerMap: { name: "name", phone: "phone", date: "date", item: "item" },
    generatedId: "row_number",
  });
  assert.deepEqual(Buffer.from(source), before);

  const cases = [
    [new Uint8Array([0xff]), "invalid_utf8"],
    [encoder.encode('name,phone,date,item\n"unterminated'), "malformed_csv"],
    [encoder.encode("name,phone,date,item\nExample,010-1234-5678,1990-02-03\n"), "row_width_mismatch"],
    [encoder.encode("name,name,phone,date,item\nA,A,010-1234-5678,1990-02-03,open\n"), "invalid_header_mapping"],
  ];
  for (const [value, code] of cases) {
    assert.throws(() => canonicalizeCsv(value, {
      kind: "source",
      headerMap: { name: "name", phone: "phone", date: "date", item: "item" },
      generatedId: "row_number",
    }), error => error instanceof IntakeError && error.code === code);
  }

  const rules = JSON.parse(await readFile(resolve(sample, "rules.json"), "utf8"));
  await assert.rejects(
    runIntake({ source: encoder.encode("source_id,name,phone,date,item\n1,Example,010-1234-5678,1990-02-03,=CMD()\n"), rules }),
    error => error instanceof IntakeError && error.code === "unsafe_spreadsheet_cell",
  );
  await assert.rejects(
    runIntake({ source: encoder.encode("source_id,name,phone,date,item\n1,Example,010-1234-5678,1990-02-03,open\n"), rules: {
      ...rules, closedItemValues: Array.from({ length: 101 }, (_, index) => String(index)),
    } }),
    error => error instanceof IntakeError && error.code === "limit_exceeded",
  );
});

test("generic table cleanup is deterministic, concurrent-safe, and review-only", async () => {
  const before = Buffer.from(cleanupSource);
  const results = await Promise.all(Array.from({ length: 8 }, () => runTableCleanup({
    source: cleanupSource, previous: cleanupPrevious, profile: cleanupProfile,
  })));
  assert.deepEqual(Buffer.from(cleanupSource), before);
  assert.equal(new Set(results.map(result => Buffer.from(result.manifestJson).toString("hex"))).size, 1);
  const result = results[0];
  assert.deepEqual(result.summary, {
    processed: 5,
    normal: 2,
    review: 1,
    duplicate_candidate: 2,
    comparison_added: 1,
    comparison_changed: 1,
    comparison_missing: 1,
    comparison_same: 1,
    comparison_duplicate: 2,
    comparison_review: 0,
  });
  const cleaned = new TextDecoder().decode(result.cleanedCsv);
  assert.match(cleaned, /김철수,01012345678,2024-07-01,완료,120000,ready/);
  assert.equal((cleaned.match(/duplicate_candidate/g) ?? []).length, 2);
  assert.match(cleaned, /최지우,bad,2024-07-03,취소,-50000,review,invalid:연락처/);
  const comparison = new TextDecoder().decode(result.comparisonCsv);
  assert.equal((comparison.match(/^duplicate,/gm) ?? []).length, 2);
  assert.match(comparison, /^changed,금액,1001/m);
  assert.match(comparison, /^missing,,1005/m);
  const manifest = JSON.parse(new TextDecoder().decode(result.manifestJson));
  assert.match(manifest.operationId, /^tc_[0-9a-f]{24}$/);
});

test("generic cleanup preserves quoted headers and prototype-named cells", async () => {
  const profile = { schemaVersion: "scalar-table-cleanup-profile/v1", columns: [{ source: "raw", output: 'Name, "alias"', transform: "text" }, { source: "key", output: "__proto__", transform: "enum", enumMap: JSON.parse('{"__proto__":"mapped"}') }] };
  const result = await runTableCleanup({ source: encoder.encode("raw,key\nA,__proto__\n"), profile });
  assert.equal(new TextDecoder().decode(result.cleanedCsv), '"Name, ""alias""",__proto__,_atelier_status,_atelier_review\nA,mapped,ready,\n');
  const unknown = await runTableCleanup({ source: encoder.encode("raw,key\nA,toString\n"), profile });
  assert.equal(unknown.summary.review, 1);
  assert.match(new TextDecoder().decode(unknown.reviewCsv), /A,toString,review,invalid:__proto__/);
});

test("generic table cleanup rejects profile drift and spreadsheet formulas", async () => {
  await assert.rejects(
    runTableCleanup({ source: cleanupSource, profile: { ...cleanupProfile, future: true } }),
    error => error instanceof IntakeError && error.code === "invalid_profile",
  );
  await assert.rejects(
    runTableCleanup({ source: encoder.encode(new TextDecoder().decode(cleanupSource).replace("ignored\n", "=HYPERLINK(1)\n")), profile: {
      ...cleanupProfile,
      columns: [...cleanupProfile.columns, { source: "note", output: "메모", transform: "text", required: false }],
    } }),
    error => error instanceof IntakeError && error.code === "unsafe_spreadsheet_cell",
  );
});

test("Node CLI produces the three public artifacts without history", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "tabular-intake-js-"));
  const source = resolve(temporary, "source.csv");
  const rules = resolve(temporary, "rules.json");
  const output = resolve(temporary, "out");
  await Promise.all([
    writeFile(source, "source_id,name,phone,date,item\n1,Example,010-1234-5678,1990-02-03,open\n"),
    writeFile(rules, await readFile(resolve(sample, "rules.json"))),
  ]);
  await execFileAsync(process.execPath, [resolve(root, "dist-js/cli.js"), "run", "--source", source, "--rules", rules, "--output", output]);
  const artifacts = await Promise.all(["normalized.csv", "review.csv", "result-manifest.json"].map(name => readFile(resolve(output, name))));
  assert.ok(artifacts.every(value => value.byteLength > 0));
});

test("Python and TypeScript cleanup CLIs produce byte-identical artifacts", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "table-cleanup-parity-"));
  const source = resolve(temporary, "source.csv");
  const previous = resolve(temporary, "previous.csv");
  const profile = resolve(temporary, "profile.json");
  const nodeOutput = resolve(temporary, "node");
  const pythonOutput = resolve(temporary, "python");
  await Promise.all([
    writeFile(source, cleanupSource),
    writeFile(previous, cleanupPrevious),
    writeFile(profile, `${JSON.stringify(cleanupProfile)}\n`),
  ]);
  await Promise.all([
    execFileAsync(process.execPath, [resolve(root, "dist-js/cli.js"), "cleanup", "--source", source,
      "--previous", previous, "--profile", profile, "--output", nodeOutput]),
    execFileAsync("python3", ["-m", "scalar_tabular_intake", "cleanup", "--source", source,
      "--previous", previous, "--profile", profile, "--output", pythonOutput], {
      env: { ...process.env, PYTHONPATH: resolve(root, "src") },
    }),
  ]);
  for (const name of ["cleaned.csv", "review.csv", "comparison.csv", "result-manifest.json"]) {
    assert.deepEqual(await readFile(resolve(nodeOutput, name)), await readFile(resolve(pythonOutput, name)), name);
  }
});

test("static demo is networkless and its build receipt matches its bytes", async () => {
  const destination = resolve(root, "demo-dist");
  const [html, source, manifest] = await Promise.all([
    readFile(resolve(destination, "index.html"), "utf8"),
    readFile(resolve(root, "demo/app.ts"), "utf8"),
    readFile(resolve(destination, "demo-build.json"), "utf8").then(JSON.parse),
  ]);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /id="source-file"/);
  assert.match(html, /aria-live="polite"/);
  for (const forbidden of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "localStorage", "indexedDB", "serviceWorker"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /let operationGeneration = 0/);
  assert.match(source, /let fileGeneration:/);
  assert.match(source, /function clearDownloadsAndResult\(\)/);
  assert.match(source, /anchor\.removeAttribute\("href"\)/);
  assert.match(source, /type: "tabular-intake:open-guided"/);
  assert.match(source, /type: "tabular-intake:close"/);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const actual = createHash("sha256").update(await readFile(resolve(destination, name))).digest("hex");
    assert.equal(actual, expected, name);
  }
});

test("duplicate candidates remain available to find overlapping two-of-three matches", async () => {
  const source = encoder.encode("source_id,name,phone,date,item\n1,Example,01012345678,1990-02-03,open\n2,Example,01012345678,1990-02-03,open\n3,Example,01098765432,1990-02-03,open\n4,Other,01098765432,1990-02-03,open\n");
  for (const count of [3, 4]) {
    const input = encoder.encode(new TextDecoder().decode(source).split("\n").slice(0, count + 1).join("\n") + "\n");
    const result = await runIntake({ source: input, rules: JSON.parse(await readFile(resolve(sample, "rules.json"), "utf8")) });
    assert.equal(result.summary.normal, 0);
    assert.equal(result.summary.duplicate_candidate, count);
    assert.match(new TextDecoder().decode(result.normalizedCsv), /3,,Example,01098765432,1990-02-03,open,duplicate_candidate,name_date_match/);
    if (count === 4) assert.match(new TextDecoder().decode(result.normalizedCsv), /name_date_match\|phone_date_match/);
  }
});

test("Node CLI refuses an existing output directory without overwriting its input", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "tabular-intake-preserve-"));
  const source = resolve(directory, "normalized.csv");
  const original = "source_id,name,phone,date,item\n1,Example,010-1234-5678,1990-02-03,open\n";
  await writeFile(source, original);
  await assert.rejects(execFileAsync(process.execPath, [resolve(root, "dist-js/cli.js"), "run", "--source", source, "--rules", resolve(sample, "rules.json"), "--output", directory]));
  assert.equal(await readFile(source, "utf8"), original);
  await assert.rejects(readFile(resolve(directory, "review.csv")), { code: "ENOENT" });
});
