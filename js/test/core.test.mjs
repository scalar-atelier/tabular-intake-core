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
} from "../../dist-js/core.js";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sample = resolve(root, "sample-pack");
const encoder = new TextEncoder();

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
  assert.deepEqual([PACKAGE_VERSION, CORE_VERSION], ["0.2.2", "0.1.0"]);
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

test("demo-only Korean fixture explains every consumer outcome without changing the golden pack", async () => {
  const [sourceRaw, historyRaw] = await Promise.all([
    readFile(resolve(root, "demo/fixtures/roster-ko.csv")),
    readFile(resolve(root, "demo/fixtures/history-ko.csv")),
  ]);
  const source = canonicalizeCsv(sourceRaw, {
    kind: "source",
    generatedId: "row_number",
    preNormalizers: { date: "kr_resident_or_date" },
    headerMap: { 신청일시: "submitted_at", 이름: "name", 전화번호: "phone", 생년월일: "date", 희망프로그램: "item" },
  });
  const history = canonicalizeCsv(historyRaw, {
    kind: "history",
    generatedId: "row_number",
    preNormalizers: { date: "kr_resident_or_date" },
    headerMap: { 처리상태: "disposition", 기수: "period", 이름: "name", 생년월일: "date", 전화번호: "phone" },
  });
  const result = await runIntake({
    source,
    history,
    rules: {
      schemaVersion: "scalar-tabular-intake-rules/v1",
      requiredFields: ["name", "phone", "date", "item"],
      closedItemValues: ["마감"],
      historyBlockValues: ["차단"],
      phoneProfile: "kr_mobile",
    },
  });
  assert.deepEqual(result.summary, {
    processed: 8,
    normal: 3,
    information_review: 1,
    duplicate_candidate: 2,
    blocked_candidate: 1,
    closed: 1,
  });
});

test("static demo is networkless and its build receipt matches its bytes", async () => {
  const destination = resolve(root, "demo-dist");
  const [html, source, manifest] = await Promise.all([
    readFile(resolve(destination, "index.html"), "utf8"),
    readFile(resolve(root, "demo/app.ts"), "utf8"),
    readFile(resolve(destination, "demo-build.json"), "utf8").then(JSON.parse),
  ]);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /rel="icon" href="data:,"/);
  assert.match(html, /id="source-file"/);
  assert.match(html, /aria-live="polite"/);
  assert.equal((html.match(/class="panel[^"\n]*demo-step"/g) || []).length, 5);
  const defaultLayer = html.replace(/<details[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(defaultLayer, /UTF-8|헤더|schema|hash 영수증/);
  for (const phrase of ["안내 준비 명단 받기", "확인할 명단 받기", "발송 동의", "한국 휴대전화", "반복 업무 가져오기 시작", "처리 증명 파일"]) assert.match(html, new RegExp(phrase));
  for (const forbidden of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "localStorage", "indexedDB", "serviceWorker"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /let generation = 0/);
  assert.match(source, /let lastStatusKey: string \| null = null/);
  assert.match(source, /else if \(lastStatusKey\) \$\("#status"\)\.textContent = message\(lastStatusKey\)/);
  assert.match(source, /function clearResult\(\)/);
  assert.match(source, /lastStatusKey === "sampleLoaded"/);
  assert.match(source, /anchor\.removeAttribute\("href"\)/);
  assert.match(source, /type: "tabular-intake:close"/);
  assert.match(source, /preNormalizers: \{ date: "kr_resident_or_date" \}/);
  assert.match(source, /encode\(`\\uFEFF/);
  assert.match(source, /row\.intake_status === "ready"/);
  for (const filename of ["안내-준비-명단.csv", "확인할-명단.csv", "outreach-worklist.csv", "roster-to-check.csv"]) {
    assert.match(source, new RegExp(filename));
  }
  for (const code of [
    "invalid_utf8", "malformed_csv", "row_width_mismatch", "invalid_header_mapping",
    "invalid_rules", "limit_exceeded", "unsafe_spreadsheet_cell",
  ]) {
    assert.equal((source.match(new RegExp(`error_${code}:`, "g")) || []).length, 3, `localized error ${code}`);
  }
  for (const code of [
    "missing_or_invalid_name", "missing_or_invalid_phone", "missing_or_invalid_date", "missing_or_invalid_item",
    "closed_item", "blocked_phone", "blocked_name_date", "exact_duplicate", "name_date_match", "name_phone_match", "phone_date_match",
  ]) {
    assert.equal((source.match(new RegExp(`reason_${code}:`, "g")) || []).length, 3, `localized reason ${code}`);
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const actual = createHash("sha256").update(await readFile(resolve(destination, name))).digest("hex");
    assert.equal(actual, expected, name);
  }
});
