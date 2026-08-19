import { parse } from "csv-parse/browser/esm/sync";

import sampleHistory from "../sample-pack/history.csv";
import sampleRules from "../sample-pack/rules.json";
import sampleSource from "../sample-pack/source.csv";
import {
  CORE_VERSION,
  MAX_INPUT_BYTES,
  PACKAGE_VERSION,
  IntakeError,
  canonicalizeCsv,
  runCsvIntake,
  runIntake,
  type IntakeOutput,
  type RuleValue,
} from "../js/core";

type Language = "ko" | "en" | "ja";
type InputState = { bytes: Uint8Array; headers: string[]; rows: number } | null;

const messages = {
  ko: {
    language: "언어", eyebrow: "설치 없는 로컬 CSV 도구", title: "CSV 명단을 바로 정리하세요",
    lead: "파일은 이 브라우저 밖으로 나가지 않습니다. 계정, API 키, 업로드가 필요 없습니다.",
    privacy: "서버 전송 0회 · 브라우저 저장 0회 · AI 추론 0회", sample: "합성 예제로 바로 보기",
    sourceTitle: "현재 명단 CSV", sourceHelp: "첫 행에 헤더가 있는 UTF-8 CSV를 선택하세요.", sourceChoose: "명단 CSV 선택",
    fileLimit: "최대 20MiB · 파일 내용은 선택 후에도 전송되지 않습니다.", historyTitle: "이전 명단 CSV",
    historyHelp: "없으면 건너뛰어도 됩니다. 있으면 참여·차단 이력을 함께 확인합니다.", historyChoose: "이전 명단 선택 (선택)",
    historyLimit: "같은 보안 경계에서 로컬로만 처리합니다.", rulesTitle: "확인 규칙",
    rulesHelp: "이름·전화·날짜·항목은 필수입니다. 반복 실행이나 자동 예약은 하지 않습니다.",
    closedValues: "마감으로 볼 항목 값", blockedValues: "차단으로 볼 이력 값", run: "이 브라우저에서 정리하기", reset: "모두 지우기",
    resultEyebrow: "로컬 처리 완료", resultTitle: "정리 결과", downloadNormalized: "정리된 명단 받기", downloadReview: "검토 목록 받기",
    downloadManifest: "hash 영수증 받기", normalizedPreview: "정리된 명단 미리보기", reviewPreview: "검토 목록 미리보기",
    technical: "기술 정보", guided: "이 업무를 반복 흐름으로 가져오기", choose: "선택하세요", optional: "사용 안 함",
    rows: "행", headers: "헤더", processed: "전체", normal: "바로 사용", information_review: "정보 확인", duplicate_candidate: "중복 후보",
    blocked_candidate: "차단 확인", closed: "마감", ready: "처리가 끝났습니다", sampleReady: "합성 예제를 처리했습니다", selectSource: "먼저 현재 명단 CSV를 선택하세요.",
    duplicateMap: "같은 헤더를 두 역할에 연결할 수 없습니다.", failed: "처리하지 못했습니다", noRows: "표시할 행이 없습니다.", time: "처리 시간",
  },
  en: {
    language: "Language", eyebrow: "Install-free local CSV tool", title: "Clean up an intake CSV now",
    lead: "Your file never leaves this browser. No account, API key, or upload is required.",
    privacy: "0 server uploads · 0 browser storage · 0 AI inference", sample: "Run the synthetic example",
    sourceTitle: "Current roster CSV", sourceHelp: "Choose a UTF-8 CSV with headers in its first row.", sourceChoose: "Choose roster CSV",
    fileLimit: "20MiB maximum · Choosing a file does not upload it.", historyTitle: "Previous roster CSV",
    historyHelp: "Optional. Add one to check prior participation and blocks.", historyChoose: "Choose previous roster (optional)",
    historyLimit: "It is processed locally under the same privacy boundary.", rulesTitle: "Review rules",
    rulesHelp: "Name, phone, date, and item are required. This does not schedule recurring runs.",
    closedValues: "Item values treated as closed", blockedValues: "History values treated as blocked", run: "Process in this browser", reset: "Clear everything",
    resultEyebrow: "Local processing complete", resultTitle: "Result", downloadNormalized: "Download normalized roster", downloadReview: "Download review list",
    downloadManifest: "Download hash receipt", normalizedPreview: "Normalized roster preview", reviewPreview: "Review list preview",
    technical: "Technical details", guided: "Bring this into a repeatable workflow", choose: "Choose a header", optional: "Do not use",
    rows: "rows", headers: "Headers", processed: "Total", normal: "Ready", information_review: "Needs info", duplicate_candidate: "Duplicate candidates",
    blocked_candidate: "Block review", closed: "Closed", ready: "Processing finished", sampleReady: "Synthetic example processed", selectSource: "Choose a current roster CSV first.",
    duplicateMap: "One header cannot fill two roles.", failed: "Could not process the file", noRows: "No rows to show.", time: "Processing time",
  },
  ja: {
    language: "言語", eyebrow: "インストール不要のローカルCSVツール", title: "CSV名簿をすぐ整理",
    lead: "ファイルはこのブラウザの外に出ません。アカウント、APIキー、アップロードは不要です。",
    privacy: "サーバー送信0回 · ブラウザ保存0回 · AI推論0回", sample: "合成例を表示",
    sourceTitle: "現在の名簿CSV", sourceHelp: "1行目にヘッダーがあるUTF-8 CSVを選択してください。", sourceChoose: "名簿CSVを選択",
    fileLimit: "最大20MiB · 選択後もファイルは送信されません。", historyTitle: "過去の名簿CSV",
    historyHelp: "任意です。参加・ブロック履歴を確認できます。", historyChoose: "過去の名簿を選択（任意）",
    historyLimit: "同じプライバシー境界でローカル処理します。", rulesTitle: "確認ルール",
    rulesHelp: "氏名・電話・日付・項目は必須です。定期実行の予約はしません。",
    closedValues: "締切として扱う項目値", blockedValues: "ブロックとして扱う履歴値", run: "このブラウザで整理", reset: "すべて消去",
    resultEyebrow: "ローカル処理完了", resultTitle: "整理結果", downloadNormalized: "整理済み名簿を保存", downloadReview: "確認リストを保存",
    downloadManifest: "hashレシートを保存", normalizedPreview: "整理済み名簿プレビュー", reviewPreview: "確認リストプレビュー",
    technical: "技術情報", guided: "反復ワークフローに取り込む", choose: "ヘッダーを選択", optional: "使用しない",
    rows: "行", headers: "ヘッダー", processed: "全体", normal: "使用可能", information_review: "情報確認", duplicate_candidate: "重複候補",
    blocked_candidate: "ブロック確認", closed: "締切", ready: "処理が完了しました", sampleReady: "合成例を処理しました", selectSource: "先に現在の名簿CSVを選択してください。",
    duplicateMap: "同じヘッダーを複数の役割に接続できません。", failed: "処理できませんでした", noRows: "表示する行がありません。", time: "処理時間",
  },
} as const;

const sourceRoles = [
  ["name", { ko: "이름", en: "Name", ja: "氏名" }, true],
  ["phone", { ko: "전화번호", en: "Phone", ja: "電話番号" }, true],
  ["date", { ko: "날짜·생년월일", en: "Date / birth date", ja: "日付・生年月日" }, true],
  ["item", { ko: "항목·신청 선택", en: "Item / choice", ja: "項目・選択" }, true],
  ["submitted_at", { ko: "제출 시각", en: "Submitted at", ja: "提出時刻" }, false],
] as const;
const historyRoles = [
  ["disposition", { ko: "상태", en: "Disposition", ja: "状態" }, true],
  ["name", { ko: "이름", en: "Name", ja: "氏名" }, true],
  ["phone", { ko: "전화번호", en: "Phone", ja: "電話番号" }, true],
  ["date", { ko: "날짜·생년월일", en: "Date / birth date", ja: "日付・生年月日" }, true],
  ["period", { ko: "기간", en: "Period", ja: "期間" }, false],
  ["category", { ko: "분류", en: "Category", ja: "分類" }, false],
] as const;

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing demo element: ${selector}`);
  return element;
};
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const csvValues = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean).slice(0, 100);
let language: Language = new URLSearchParams(location.search).get("lang") as Language
  || (navigator.language.startsWith("ja") ? "ja" : navigator.language.startsWith("en") ? "en" : "ko");
if (!(language in messages)) language = "ko";
let sourceState: InputState = null;
let historyState: InputState = null;
let downloadUrls: string[] = [];
let generation = 0;

function message(key: keyof typeof messages.ko): string { return messages[language][key]; }

function applyLanguage(): void {
  document.documentElement.lang = language;
  $<HTMLSelectElement>("#language").value = language;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach(element => {
    const key = element.dataset.i18n as keyof typeof messages.ko;
    element.textContent = message(key);
  });
  if (sourceState) renderMapping("source", sourceState);
  if (historyState) renderMapping("history", historyState);
}

function inspect(bytes: Uint8Array): NonNullable<InputState> {
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new IntakeError("limit_exceeded", "CSV exceeds 20MiB");
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { throw new IntakeError("invalid_utf8", "CSV must be UTF-8"); }
  let table: string[][];
  try { table = parse(value, { bom: true, relax_column_count: true, skip_empty_lines: false }) as string[][]; }
  catch { throw new IntakeError("malformed_csv", "CSV is malformed"); }
  const headers = (table[0] ?? []).map(item => String(item).trim());
  if (!headers.length) throw new IntakeError("invalid_header_mapping", "CSV has no header row");
  return { bytes, headers, rows: Math.max(0, table.length - 1) };
}

function renderMapping(kind: "source" | "history", state: NonNullable<InputState>): void {
  const info = $<HTMLDivElement>(`#${kind}-info`);
  info.hidden = false;
  info.replaceChildren();
  const summary = document.createElement("strong");
  summary.textContent = `${state.rows} ${message("rows")} · ${message("headers")} ${state.headers.length}`;
  const list = document.createElement("div");
  list.className = "header-list";
  state.headers.forEach(header => { const code = document.createElement("code"); code.textContent = header; list.append(code); });
  info.append(summary, list);

  const container = $<HTMLDivElement>(`#${kind}-mapping`);
  const previous = new Map([...container.querySelectorAll<HTMLSelectElement>("select")].map(select => [select.dataset.role, select.value]));
  container.replaceChildren();
  const roles = kind === "source" ? sourceRoles : historyRoles;
  roles.forEach(([role, labels, required]) => {
    const label = document.createElement("label");
    label.textContent = `${labels[language]}${required ? " *" : ""}`;
    const select = document.createElement("select");
    select.dataset.role = role;
    select.required = required;
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = required ? message("choose") : message("optional");
    select.append(empty, ...state.headers.map(header => {
      const option = document.createElement("option"); option.value = header; option.textContent = header; return option;
    }));
    const retained = previous.get(role);
    if (retained && state.headers.includes(retained)) select.value = retained;
    label.append(select);
    container.append(label);
  });
  container.hidden = false;
}

async function loadFile(kind: "source" | "history", file: File | undefined): Promise<void> {
  if (!file) return;
  const current = ++generation;
  if (kind === "source") sourceState = null; else historyState = null;
  for (const id of [`${kind}-info`, `${kind}-mapping`]) {
    const element = $(`#${id}`); element.hidden = true; element.replaceChildren();
  }
  clearResult();
  try {
    const state = inspect(new Uint8Array(await file.arrayBuffer()));
    if (current !== generation) return;
    if (kind === "source") sourceState = state; else historyState = state;
    renderMapping(kind, state);
    $("#status").textContent = "";
  } catch (error) {
    if (current === generation) throw error;
  }
}

function mapping(kind: "source" | "history"): Record<string, string> {
  const selects = [...document.querySelectorAll<HTMLSelectElement>(`#${kind}-mapping select`)];
  const rawValues = selects.map(select => select.value).filter(Boolean);
  if (new Set(rawValues).size !== rawValues.length) throw new IntakeError("invalid_header_mapping", message("duplicateMap"));
  const required = kind === "source" ? sourceRoles : historyRoles;
  for (const [role, , needed] of required) {
    if (needed && !selects.find(select => select.dataset.role === role)?.value) {
      throw new IntakeError("invalid_header_mapping", message("choose"));
    }
  }
  return Object.fromEntries(selects.filter(select => select.value).map(select => [select.value, select.dataset.role ?? ""]));
}

function rules(): RuleValue {
  return {
    schemaVersion: "scalar-tabular-intake-rules/v1",
    requiredFields: ["name", "phone", "date", "item"],
    closedItemValues: csvValues($<HTMLInputElement>("#closed-values").value),
    historyBlockValues: csvValues($<HTMLInputElement>("#blocked-values").value),
    phoneProfile: "kr_mobile",
    maxRows: 100_000,
    maxCellChars: 50_000,
  };
}

function renderTable(target: string, bytes: Uint8Array): void {
  const container = $<HTMLDivElement>(target);
  container.replaceChildren();
  const rows = parse(decode(bytes), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  if (!rows.length) { container.textContent = message("noRows"); return; }
  const fields = Object.keys(rows[0] ?? {});
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  fields.forEach(field => { const th = document.createElement("th"); th.scope = "col"; th.textContent = field; headerRow.append(th); });
  head.append(headerRow);
  const body = document.createElement("tbody");
  rows.slice(0, 10).forEach(row => {
    const tr = document.createElement("tr");
    fields.forEach(field => { const td = document.createElement("td"); td.textContent = row[field] ?? ""; td.title = row[field] ?? ""; tr.append(td); });
    body.append(tr);
  });
  table.append(head, body);
  container.append(table);
}

function showResult(result: IntakeOutput, elapsed: number, statusKey: "ready" | "sampleReady"): void {
  clearResult();
  const downloads = [
    ["normalized", result.normalizedCsv, "normalized.csv", "text/csv"],
    ["review", result.reviewCsv, "review.csv", "text/csv"],
    ["manifest", result.manifestJson, "result-manifest.json", "application/json"],
  ] as const;
  downloads.forEach(([kind, bytes, name, type]) => {
    const anchor = $<HTMLAnchorElement>(`[data-download="${kind}"]`);
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
    downloadUrls.push(url);
    anchor.href = url;
    anchor.download = name;
  });
  const summary = $("#summary");
  summary.replaceChildren();
  Object.entries(result.summary).forEach(([key, value]) => {
    const card = document.createElement("div"); card.className = "summary-card";
    const strong = document.createElement("strong"); strong.textContent = String(value);
    const label = document.createElement("span"); label.textContent = message(key as keyof typeof messages.ko);
    card.append(strong, label); summary.append(card);
  });
  const manifest = JSON.parse(decode(result.manifestJson));
  $("#manifest").textContent = JSON.stringify({ packageVersion: PACKAGE_VERSION, ...manifest }, null, 2);
  renderTable("#normalized-preview", result.normalizedCsv);
  renderTable("#review-preview", result.reviewCsv);
  const panel = $("#result"); panel.hidden = false;
  $("#status").textContent = `${message(statusKey)} · ${message("time")} ${elapsed.toFixed(1)}ms`;
  $("#result-title").focus();
}

function clearResult(): void {
  downloadUrls.forEach(url => URL.revokeObjectURL(url));
  downloadUrls = [];
  document.querySelectorAll<HTMLAnchorElement>("[data-download]").forEach(anchor => {
    anchor.removeAttribute("href"); anchor.removeAttribute("download");
  });
  for (const id of ["summary", "normalized-preview", "review-preview", "manifest"]) $(`#${id}`).replaceChildren();
  $("#result").hidden = true;
}

async function runFiles(): Promise<void> {
  if (!sourceState) throw new IntakeError("invalid_header_mapping", message("selectSource"));
  const current = ++generation;
  clearResult();
  const started = performance.now();
  const source = canonicalizeCsv(sourceState.bytes, { kind: "source", headerMap: mapping("source"), generatedId: "row_number" });
  const history = historyState
    ? canonicalizeCsv(historyState.bytes, { kind: "history", headerMap: mapping("history"), generatedId: "row_number" })
    : undefined;
  const result = await runIntake({ source, history, rules: rules() });
  if (current === generation) showResult(result, performance.now() - started, "ready");
}

async function runSample(): Promise<void> {
  const current = ++generation;
  clearResult();
  const started = performance.now();
  const result = await runCsvIntake(encode(sampleSource), encode(sampleHistory), sampleRules as RuleValue);
  if (current === generation) showResult(result, performance.now() - started, "sampleReady");
}

function reset(): void {
  generation += 1;
  sourceState = null; historyState = null;
  clearResult();
  for (const id of ["source-file", "history-file"]) $<HTMLInputElement>(`#${id}`).value = "";
  for (const id of ["source-info", "history-info", "source-mapping", "history-mapping", "result"]) {
    const element = $(id.startsWith("#") ? id : `#${id}`); element.hidden = true;
    if (id !== "result") element.replaceChildren();
  }
  $("#status").textContent = "";
}

function report(error: unknown): void {
  const detail = error instanceof IntakeError ? `${error.code}: ${error.message}` : String(error);
  $("#status").textContent = `${message("failed")}: ${detail}`;
}

$("#language").addEventListener("change", event => { language = (event.currentTarget as HTMLSelectElement).value as Language; applyLanguage(); });
$("#source-file").addEventListener("change", event => { void loadFile("source", (event.currentTarget as HTMLInputElement).files?.[0]).catch(report); });
$("#history-file").addEventListener("change", event => { void loadFile("history", (event.currentTarget as HTMLInputElement).files?.[0]).catch(report); });
$("#run").addEventListener("click", () => { void runFiles().catch(report); });
$("#sample-run").addEventListener("click", () => { void runSample().catch(report); });
$("#reset").addEventListener("click", reset);
const embedded = new URLSearchParams(location.search).get("atelier") === "1";
$("#guided-intake").hidden = !embedded;
$("#guided-intake").addEventListener("click", () => window.parent.postMessage({ type: "tabular-intake:open-guided" }, location.origin));
if (embedded) window.addEventListener("keydown", event => {
  if (event.key === "Escape") window.parent.postMessage({ type: "tabular-intake:close" }, location.origin);
});
$("#version").textContent = `package ${PACKAGE_VERSION} · contract ${CORE_VERSION}`;
applyLanguage();
