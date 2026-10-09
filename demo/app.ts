import { parse } from "csv-parse/browser/esm/sync";

import {
  CORE_VERSION,
  MAX_INPUT_BYTES,
  PACKAGE_VERSION,
  IntakeError,
  runTableCleanup,
  type TableCleanupOutput,
  type TableCleanupProfileV1,
} from "../js/core";

type Language = "ko" | "en" | "ja";
type InputKind = "source" | "previous";
type InputState = {
  bytes: Uint8Array;
  headers: string[];
  table: string[][];
  rows: number;
  fileName: string;
} | null;
type ResultTab = "cleaned" | "review" | "comparison";

const messages = {
  ko: {
    language: "언어", title: "표 정리", privacy: "파일은 이 브라우저 밖으로 나가지 않습니다",
    stepFile: "파일", stepFileHint: "CSV를 선택하세요", stepRules: "정리 규칙", stepRulesHint: "열과 형식을 확인하세요",
    stepResult: "결과", stepResultHint: "검토하고 저장하세요", tipTitle: "안전하게 정리합니다",
    tipBody: "원본은 바꾸지 않고, 중복 후보와 형식 오류는 따로 표시합니다.", localTool: "설치 없는 로컬 도구",
    fileTitle: "정리할 표를 선택하세요", sample: "합성 예제로 확인",
    fileHelp: "UTF-8 CSV 한 개를 정리하고, 이전 CSV를 더하면 달라진 행도 찾습니다.",
    sourceChoose: "현재 CSV 선택", sourceLimit: "필수 · 최대 20MiB", previousChoose: "이전 CSV 추가",
    previousLimit: "선택 · 변경 비교용", emptyFile: "아직 선택한 파일이 없습니다.", run: "정리 결과 만들기",
    reset: "초기화", ruleKicker: "내가 정하는 기준", rulesTitle: "정리 규칙",
    rulesHelp: "남길 열, 이름, 형식과 중복 판단 키를 확인하세요.", ruleEmpty: "CSV를 선택하면 열별 규칙이 여기에 나타납니다.",
    blankValues: "빈칸으로 볼 값", duplicateSafety: "중복 후보는 자동 삭제하지 않습니다",
    duplicateSafetyHelp: "검토 파일에서 직접 확인한 뒤 결정하세요.", resultKicker: "로컬 처리 완료",
    resultTitle: "정리 결과", downloadCleaned: "정리 CSV", downloadReview: "검토 CSV", downloadComparison: "비교 CSV",
    downloadManifest: "실행 영수증", tabCleaned: "정리됨", tabReview: "검토 필요", tabComparison: "이전 파일과 비교",
    technical: "기술 정보", guided: "이 규칙으로 반복 정리하기", keep: "남김", required: "필수", key: "중복·비교 키",
    outputName: "결과 열 이름", enumMap: "값 대응 (예: done=완료, hold=보류)",
    transformText: "텍스트·공백 정리", transformDate: "날짜 YYYY-MM-DD", transformNumber: "숫자·콤마 정리",
    transformPhone: "한국 전화번호", transformEnum: "값 대응표", rows: "행", columns: "열",
    previousLoaded: "이전 파일", processed: "전체", normal: "정상", review: "검토", duplicate_candidate: "중복 후보",
    ready: "정리가 끝났습니다", sampleReady: "합성 예제 정리가 끝났습니다", failed: "처리하지 못했습니다",
    selectSource: "먼저 현재 CSV를 선택하세요.", invalidEnum: "값 대응은 원본=결과 형식으로 입력하세요.",
    noRows: "표시할 행이 없습니다.", running: "정리 중…", elapsed: "처리 시간",
    statusHeader: "결과", reviewHeader: "검토 이유", changeHeader: "비교", changedHeader: "바뀐 열",
    statusReady: "정상", statusReview: "검토", statusDuplicate: "중복 후보", changeAdded: "추가",
    changeChanged: "변경", changeMissing: "이전 파일에만 있음", changeSame: "같음", changeDuplicate: "중복", changeReview: "키 확인",
  },
  en: {
    language: "Language", title: "Table cleanup", privacy: "Your files never leave this browser",
    stepFile: "Files", stepFileHint: "Choose a CSV", stepRules: "Cleanup rules", stepRulesHint: "Review columns and formats",
    stepResult: "Result", stepResultHint: "Review and save", tipTitle: "Cleanup without deletion",
    tipBody: "The source stays unchanged. Duplicates and invalid values are separated for review.", localTool: "Install-free local tool",
    fileTitle: "Choose a table to clean", sample: "Try synthetic data",
    fileHelp: "Clean one UTF-8 CSV. Add a previous CSV to see what changed.",
    sourceChoose: "Choose current CSV", sourceLimit: "Required · 20MiB max", previousChoose: "Add previous CSV",
    previousLimit: "Optional · for comparison", emptyFile: "No file selected yet.", run: "Create cleanup result",
    reset: "Reset", ruleKicker: "Your explicit rules", rulesTitle: "Cleanup rules",
    rulesHelp: "Confirm kept columns, names, formats, and comparison keys.", ruleEmpty: "Choose a CSV to configure each column.",
    blankValues: "Values treated as blank", duplicateSafety: "Duplicate candidates are never deleted automatically",
    duplicateSafetyHelp: "Review them in the review file before deciding.", resultKicker: "Local processing complete",
    resultTitle: "Cleanup result", downloadCleaned: "Cleaned CSV", downloadReview: "Review CSV", downloadComparison: "Comparison CSV",
    downloadManifest: "Run receipt", tabCleaned: "Cleaned", tabReview: "Needs review", tabComparison: "Compare previous",
    technical: "Technical details", guided: "Repeat with these rules", keep: "Keep", required: "Required", key: "Duplicate / compare key",
    outputName: "Output column name", enumMap: "Value map (for example done=complete, hold=hold)",
    transformText: "Text and trim", transformDate: "Date YYYY-MM-DD", transformNumber: "Number and commas",
    transformPhone: "Korean phone", transformEnum: "Value map", rows: "rows", columns: "columns",
    previousLoaded: "Previous file", processed: "Total", normal: "Ready", review: "Review", duplicate_candidate: "Duplicate candidates",
    ready: "Cleanup finished", sampleReady: "Synthetic example finished", failed: "Could not process",
    selectSource: "Choose a current CSV first.", invalidEnum: "Enter value maps as source=result.",
    noRows: "No rows to show.", running: "Cleaning…", elapsed: "Elapsed",
    statusHeader: "Result", reviewHeader: "Review reason", changeHeader: "Comparison", changedHeader: "Changed columns",
    statusReady: "Ready", statusReview: "Review", statusDuplicate: "Duplicate candidate", changeAdded: "Added",
    changeChanged: "Changed", changeMissing: "Only in previous", changeSame: "Same", changeDuplicate: "Duplicate", changeReview: "Check key",
  },
  ja: {
    language: "言語", title: "表の整理", privacy: "ファイルはこのブラウザの外に出ません",
    stepFile: "ファイル", stepFileHint: "CSVを選択", stepRules: "整理ルール", stepRulesHint: "列と形式を確認",
    stepResult: "結果", stepResultHint: "確認して保存", tipTitle: "削除せず安全に整理",
    tipBody: "原本は変更せず、重複候補と形式エラーを確認用に分けます。", localTool: "インストール不要のローカルツール",
    fileTitle: "整理する表を選択", sample: "合成データで確認",
    fileHelp: "UTF-8 CSVを整理し、以前のCSVを追加すると変更行も確認できます。",
    sourceChoose: "現在のCSVを選択", sourceLimit: "必須 · 最大20MiB", previousChoose: "以前のCSVを追加",
    previousLimit: "任意 · 比較用", emptyFile: "ファイルはまだ選択されていません。", run: "整理結果を作成",
    reset: "リセット", ruleKicker: "明示的な基準", rulesTitle: "整理ルール",
    rulesHelp: "残す列、名前、形式、比較キーを確認してください。", ruleEmpty: "CSVを選ぶと列ごとのルールが表示されます。",
    blankValues: "空欄として扱う値", duplicateSafety: "重複候補は自動削除しません",
    duplicateSafetyHelp: "確認ファイルで判断してください。", resultKicker: "ローカル処理完了",
    resultTitle: "整理結果", downloadCleaned: "整理CSV", downloadReview: "確認CSV", downloadComparison: "比較CSV",
    downloadManifest: "実行レシート", tabCleaned: "整理済み", tabReview: "要確認", tabComparison: "以前と比較",
    technical: "技術情報", guided: "このルールで繰り返す", keep: "残す", required: "必須", key: "重複・比較キー",
    outputName: "出力列名", enumMap: "値対応 (例 done=完了, hold=保留)",
    transformText: "テキスト・空白", transformDate: "日付 YYYY-MM-DD", transformNumber: "数値・カンマ",
    transformPhone: "韓国電話番号", transformEnum: "値対応表", rows: "行", columns: "列",
    previousLoaded: "以前のファイル", processed: "全体", normal: "正常", review: "確認", duplicate_candidate: "重複候補",
    ready: "整理が完了しました", sampleReady: "合成例の整理が完了しました", failed: "処理できませんでした",
    selectSource: "先に現在のCSVを選択してください。", invalidEnum: "値対応は 元=結果 の形式で入力してください。",
    noRows: "表示する行がありません。", running: "整理中…", elapsed: "処理時間",
    statusHeader: "結果", reviewHeader: "確認理由", changeHeader: "比較", changedHeader: "変更列",
    statusReady: "正常", statusReview: "確認", statusDuplicate: "重複候補", changeAdded: "追加",
    changeChanged: "変更", changeMissing: "以前のみ", changeSame: "同じ", changeDuplicate: "重複", changeReview: "キー確認",
  },
} as const;

const transformKeys = {
  text: "transformText",
  date_ymd: "transformDate",
  number: "transformNumber",
  phone_kr: "transformPhone",
  enum: "transformEnum",
} as const;

const SAMPLE_SOURCE = `order_id,customer,phone,order_date,status,amount,note
1001, 김철수 ,010-1234-5678,2024-7-1,done,"120,000",첫 구매
1002,이영희,01012345679,2024/07/02,shipping,85000,
1003,박민수,010-1234-5678,2024.07.02,done,95000,중복 후보
1004,최지우,bad,2024-07-03,cancelled,-50000,연락처 확인
1005,정하나,010-5555-6666,2024-13-03,done,200000,날짜 확인
1003,박민수,010-1234-5678,2024.07.02,done,95000,중복 후보
1007,윤서준,010-2222-3333,2024-07-04,shipping,125000,
1008,장예은,010-3333-4444,2024-07-05,done,75000,
1009,한도윤,010-4444-5555,2024-07-06,done,99000,
1010,서지안,010-6666-7777,2024-07-07,shipping,132000,
1011,임하준,010-7777-8888,2024-07-08,done,88000,
1012,조서연,010-8888-9999,2024-07-09,done,"95,000원",금액 확인
`;
const SAMPLE_PREVIOUS = `order_id,customer,phone,order_date,status,amount,note
1001,김철수,01012345678,2024-07-01,done,100000,
1002,이영희,01012345679,2024-07-02,shipping,85000,
1003,박민수,01012345678,2024-07-02,done,95000,
1013,김나연,010-9999-0000,2024-06-30,done,64000,
`;
const SAMPLE_PROFILE: TableCleanupProfileV1 = {
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
  blankValues: ["", "-", "N/A", "n/a"],
  maxRows: 100_000,
  maxCellChars: 50_000,
};

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing demo element: ${selector}`);
  return element;
};
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
let language: Language = new URLSearchParams(location.search).get("lang") as Language
  || (navigator.language.startsWith("ja") ? "ja" : navigator.language.startsWith("en") ? "en" : "ko");
if (!(language in messages)) language = "ko";
let sourceState: InputState = null;
let previousState: InputState = null;
let fileGeneration: Record<InputKind, number> = { source: 0, previous: 0 };
let operationGeneration = 0;
let downloadUrls: string[] = [];
let currentResult: TableCleanupOutput | null = null;
let currentProfile: TableCleanupProfileV1 | null = null;
let resultTab: ResultTab = "cleaned";

function message(key: keyof typeof messages.ko): string { return messages[language][key]; }

function applyLanguage(): void {
  document.documentElement.lang = language;
  $<HTMLSelectElement>("#language").value = language;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach(element => {
    const key = element.dataset.i18n as keyof typeof messages.ko;
    element.textContent = message(key);
  });
  document.querySelectorAll<HTMLOptionElement>("[data-transform-key]").forEach(option => {
    option.textContent = message(option.dataset.transformKey as keyof typeof messages.ko);
  });
  updateFileInfo();
}

function inspect(bytes: Uint8Array, fileName: string): NonNullable<InputState> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_INPUT_BYTES) {
    throw new IntakeError("limit_exceeded", "CSV exceeds 20MiB");
  }
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { throw new IntakeError("invalid_utf8", "CSV must be UTF-8"); }
  let table: string[][];
  try { table = parse(value, { bom: true, relax_column_count: true, skip_empty_lines: false }) as string[][]; }
  catch { throw new IntakeError("malformed_csv", "CSV is malformed"); }
  const headers = (table[0] ?? []).map(item => String(item).trim());
  if (!headers.length || headers.some(header => !header) || new Set(headers).size !== headers.length) {
    throw new IntakeError("invalid_header_mapping", "CSV must have unique, non-empty headers");
  }
  return { bytes, headers, table, rows: Math.max(0, table.length - 1), fileName };
}

function renderArrayTable(target: string, fields: string[], rows: string[][]): void {
  const container = $(target);
  container.replaceChildren();
  if (!rows.length) { container.textContent = message("noRows"); return; }
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  fields.forEach(field => { const th = document.createElement("th"); th.scope = "col"; th.textContent = field; headerRow.append(th); });
  head.append(headerRow);
  const body = document.createElement("tbody");
  rows.slice(0, 12).forEach(values => {
    const tr = document.createElement("tr");
    fields.forEach((_field, index) => {
      const td = document.createElement("td");
      td.textContent = String(values[index] ?? "").trim();
      td.title = td.textContent;
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(head, body);
  container.append(table);
}

function renderCsvTable(bytes: Uint8Array): void {
  const rows = parse(decode(bytes), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  const container = $("#result-preview");
  container.replaceChildren();
  if (!rows.length) { container.textContent = message("noRows"); return; }
  const fields = Object.keys(rows[0] ?? {});
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const fieldLabels: Record<string, string> = {
    _atelier_status: message("statusHeader"),
    _atelier_review: message("reviewHeader"),
    _atelier_change: message("changeHeader"),
    _atelier_changed_columns: message("changedHeader"),
  };
  const valueLabels: Record<string, string> = {
    ready: message("statusReady"), review: message("statusReview"), duplicate_candidate: message("statusDuplicate"),
    added: message("changeAdded"), changed: message("changeChanged"), missing: message("changeMissing"),
    same: message("changeSame"), duplicate: message("changeDuplicate"),
  };
  fields.forEach(field => { const th = document.createElement("th"); th.scope = "col"; th.textContent = fieldLabels[field] ?? field; headerRow.append(th); });
  head.append(headerRow);
  const body = document.createElement("tbody");
  rows.slice(0, 30).forEach(row => {
    const tr = document.createElement("tr");
    fields.forEach(field => {
      const td = document.createElement("td");
      const value = row[field] ?? "";
      if (field === "_atelier_status" || field === "_atelier_change") {
        const chip = document.createElement("span");
        chip.className = `status-chip${["review", "duplicate_candidate", "duplicate", "changed", "missing"].includes(value) ? " is-warning" : ""}`;
        chip.textContent = valueLabels[value] ?? value;
        td.append(chip);
      } else if (field === "_atelier_review") {
        td.textContent = value.split("|").filter(Boolean).map(code => {
          if (code === "duplicate:key") return language === "en" ? "Check duplicate key" : language === "ja" ? "重複キー確認" : "중복 키 확인";
          if (code.startsWith("invalid:")) return language === "en" ? `Check ${code.slice(8)} format` : language === "ja" ? `${code.slice(8)} 形式確認` : `${code.slice(8)} 형식 확인`;
          if (code.startsWith("missing:")) return language === "en" ? `Missing ${code.slice(8)}` : language === "ja" ? `${code.slice(8)} 必須` : `${code.slice(8)} 필수`;
          return code;
        }).join(" · ");
        td.title = td.textContent;
      } else {
        td.textContent = value;
        td.title = value;
      }
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(head, body);
  container.append(table);
}

function inferredTransform(header: string): keyof typeof transformKeys {
  const normalized = header.toLowerCase();
  if (/(date|day|일자|날짜)/.test(normalized)) return "date_ymd";
  if (/(phone|mobile|tel|연락|전화)/.test(normalized)) return "phone_kr";
  if (/(amount|price|total|cost|금액|가격|수량)/.test(normalized)) return "number";
  return "text";
}

function renderRules(state: NonNullable<InputState>, preset?: TableCleanupProfileV1): void {
  const rules = $("#column-rules");
  rules.replaceChildren();
  const presetBySource = new Map(preset?.columns.map(column => [column.source, column]) ?? []);
  const presetKeys = new Set(preset?.keyColumns ?? []);
  const inferredKey = state.headers.find(header => /(^id$|_id$|번호|code)/i.test(header)) ?? state.headers[0];
  state.headers.forEach(header => {
    const configured = presetBySource.get(header);
    const row = document.createElement("section");
    row.className = `column-rule${preset && !configured ? " is-excluded" : ""}`;
    row.dataset.source = header;

    const keep = document.createElement("input");
    keep.type = "checkbox";
    keep.className = "column-keep";
    keep.checked = preset ? Boolean(configured) : true;
    keep.setAttribute("aria-label", `${header} ${message("keep")}`);

    const body = document.createElement("div");
    body.className = "column-rule__body";
    const source = document.createElement("span");
    source.className = "column-rule__source";
    source.textContent = header;
    const controls = document.createElement("div");
    controls.className = "column-rule__controls";
    const output = document.createElement("input");
    output.type = "text";
    output.className = "column-output";
    output.value = configured?.output ?? header;
    output.placeholder = message("outputName");
    output.setAttribute("aria-label", `${header} ${message("outputName")}`);
    const transform = document.createElement("select");
    transform.className = "column-transform";
    transform.setAttribute("aria-label", `${header} transform`);
    (Object.keys(transformKeys) as (keyof typeof transformKeys)[]).forEach(value => {
      const option = document.createElement("option");
      option.value = value;
      option.dataset.transformKey = transformKeys[value];
      option.textContent = message(transformKeys[value]);
      transform.append(option);
    });
    transform.value = configured?.transform ?? inferredTransform(header);
    controls.append(output, transform);

    const flags = document.createElement("div");
    flags.className = "column-rule__flags";
    const required = document.createElement("input");
    required.type = "checkbox";
    required.className = "column-required";
    required.checked = configured?.required ?? header === inferredKey;
    const requiredLabel = document.createElement("label");
    requiredLabel.append(required, document.createTextNode(message("required")));
    const key = document.createElement("input");
    key.type = "checkbox";
    key.className = "column-key";
    key.checked = preset ? presetKeys.has(configured?.output ?? "") : header === inferredKey;
    const keyLabel = document.createElement("label");
    keyLabel.append(key, document.createTextNode(message("key")));
    flags.append(requiredLabel, keyLabel);

    const enumMap = document.createElement("input");
    enumMap.type = "text";
    enumMap.className = "enum-map";
    enumMap.placeholder = message("enumMap");
    enumMap.setAttribute("aria-label", `${header} ${message("enumMap")}`);
    enumMap.value = configured?.enumMap ? Object.entries(configured.enumMap).map(([from, to]) => `${from}=${to}`).join(", ") : "";
    enumMap.hidden = transform.value !== "enum";
    body.append(source, controls, flags, enumMap);
    row.append(keep, body);
    rules.append(row);
  });
  rules.hidden = false;
  $("#rule-empty").hidden = true;
  $<HTMLInputElement>("#blank-values").value = (preset?.blankValues ?? ["-", "N/A", "n/a"]).filter(Boolean).join(", ");
}

function parseEnumMap(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const item of value.split(",").map(part => part.trim()).filter(Boolean)) {
    const separator = item.indexOf("=");
    if (separator < 1 || !item.slice(separator + 1).trim()) throw new IntakeError("invalid_profile", message("invalidEnum"));
    result[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
  }
  if (!Object.keys(result).length) throw new IntakeError("invalid_profile", message("invalidEnum"));
  return result;
}

function profileFromRules(): TableCleanupProfileV1 {
  const columns: TableCleanupProfileV1["columns"] = [];
  const keyColumns: string[] = [];
  for (const row of document.querySelectorAll<HTMLElement>(".column-rule")) {
    if (!row.querySelector<HTMLInputElement>(".column-keep")?.checked) continue;
    const source = row.dataset.source ?? "";
    const output = row.querySelector<HTMLInputElement>(".column-output")?.value.trim() ?? "";
    const transform = row.querySelector<HTMLSelectElement>(".column-transform")?.value as keyof typeof transformKeys;
    const required = Boolean(row.querySelector<HTMLInputElement>(".column-required")?.checked);
    const column: TableCleanupProfileV1["columns"][number] = { source, output, transform, required };
    if (transform === "enum") column.enumMap = parseEnumMap(row.querySelector<HTMLInputElement>(".enum-map")?.value ?? "");
    columns.push(column);
    if (row.querySelector<HTMLInputElement>(".column-key")?.checked) keyColumns.push(output);
  }
  const blankValues = ["", ...$<HTMLInputElement>("#blank-values").value.split(",").map(item => item.trim()).filter(Boolean)];
  return {
    schemaVersion: "scalar-table-cleanup-profile/v1",
    columns,
    keyColumns,
    blankValues,
    maxRows: 100_000,
    maxCellChars: 50_000,
  };
}

function updateFileInfo(): void {
  const info = $("#source-info");
  if (!sourceState) {
    info.className = "file-info empty-state";
    info.textContent = message("emptyFile");
    return;
  }
  info.className = "file-info";
  info.textContent = `${sourceState.fileName} · ${sourceState.rows} ${message("rows")} · ${sourceState.headers.length} ${message("columns")}`
    + (previousState ? ` · ${message("previousLoaded")}: ${previousState.fileName}` : "");
  $("#step-file-detail").textContent = `${sourceState.rows} ${message("rows")} · ${sourceState.headers.length} ${message("columns")}`;
}

function setStep(step: "file" | "rules" | "result"): void {
  const order = ["file", "rules", "result"];
  const index = order.indexOf(step);
  document.querySelectorAll<HTMLElement>("[data-step]").forEach(item => {
    const itemIndex = order.indexOf(item.dataset.step ?? "");
    item.classList.toggle("is-active", itemIndex === index);
    item.classList.toggle("is-complete", itemIndex < index);
  });
}

function clearDownloadsAndResult(): void {
  downloadUrls.forEach(url => URL.revokeObjectURL(url));
  downloadUrls = [];
  currentResult = null;
  currentProfile = null;
  document.querySelectorAll<HTMLAnchorElement>("[data-download]").forEach(anchor => {
    anchor.removeAttribute("href");
    anchor.removeAttribute("download");
  });
  $("#summary").replaceChildren();
  $("#result-preview").replaceChildren();
  $("#manifest").replaceChildren();
  $("#result").hidden = true;
}

function invalidate(): void {
  operationGeneration += 1;
  clearDownloadsAndResult();
  $<HTMLButtonElement>("#run").disabled = !sourceState;
  if (sourceState) setStep("rules"); else setStep("file");
}

async function loadFile(kind: InputKind, file: File | undefined): Promise<void> {
  if (!file) return;
  const token = ++fileGeneration[kind];
  const bytes = new Uint8Array(await file.arrayBuffer());
  const state = inspect(bytes, file.name);
  if (token !== fileGeneration[kind]) return;
  if (kind === "source") {
    sourceState = state;
    renderRules(state);
    renderArrayTable("#source-preview", state.headers, state.table.slice(1));
  } else {
    previousState = state;
  }
  updateFileInfo();
  invalidate();
  $("#status").textContent = "";
}

function renderSelectedResult(): void {
  if (!currentResult) return;
  const bytes = resultTab === "cleaned" ? currentResult.cleanedCsv
    : resultTab === "review" ? currentResult.reviewCsv : currentResult.comparisonCsv;
  renderCsvTable(bytes);
  document.querySelectorAll<HTMLButtonElement>("[data-result-tab]").forEach(button => {
    button.setAttribute("aria-selected", String(button.dataset.resultTab === resultTab));
  });
}

function showResult(result: TableCleanupOutput, profile: TableCleanupProfileV1, elapsed: number, statusKey: "ready" | "sampleReady"): void {
  clearDownloadsAndResult();
  currentResult = result;
  currentProfile = profile;
  const downloads = [
    ["cleaned", result.cleanedCsv, "cleaned.csv", "text/csv"],
    ["review", result.reviewCsv, "review.csv", "text/csv"],
    ["comparison", result.comparisonCsv, "comparison.csv", "text/csv"],
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
  for (const key of ["processed", "normal", "review", "duplicate_candidate"] as const) {
    const card = document.createElement("div");
    card.className = `summary-card${key === "review" || key === "duplicate_candidate" ? " is-warning" : ""}`;
    const strong = document.createElement("strong");
    strong.textContent = String(result.summary[key] ?? 0);
    const label = document.createElement("span");
    label.textContent = message(key);
    card.append(strong, label);
    summary.append(card);
  }
  const manifest = JSON.parse(decode(result.manifestJson));
  $("#manifest").textContent = JSON.stringify({ packageVersion: PACKAGE_VERSION, profile, ...manifest }, null, 2);
  const comparisonTab = $<HTMLButtonElement>('[data-result-tab="comparison"]');
  comparisonTab.disabled = !previousState;
  resultTab = "cleaned";
  renderSelectedResult();
  $("#result").hidden = false;
  $("#status").textContent = `${message(statusKey)} · ${message("elapsed")} ${elapsed.toFixed(1)}ms`;
  setStep("result");
  $("#result-title").focus();
}

async function runCurrent(statusKey: "ready" | "sampleReady" = "ready"): Promise<void> {
  if (!sourceState) throw new IntakeError("invalid_header_mapping", message("selectSource"));
  const profile = profileFromRules();
  const source = sourceState.bytes;
  const previous = previousState?.bytes;
  const token = ++operationGeneration;
  const button = $<HTMLButtonElement>("#run");
  button.disabled = true;
  $("#status").textContent = message("running");
  const started = performance.now();
  try {
    const result = await runTableCleanup({ source, previous, profile });
    if (token === operationGeneration) showResult(result, profile, performance.now() - started, statusKey);
  } finally {
    if (token === operationGeneration) button.disabled = false;
  }
}

async function runSample(): Promise<void> {
  sourceState = inspect(encode(SAMPLE_SOURCE), "orders_sample.csv");
  previousState = inspect(encode(SAMPLE_PREVIOUS), "orders_previous.csv");
  renderRules(sourceState, SAMPLE_PROFILE);
  renderArrayTable("#source-preview", sourceState.headers, sourceState.table.slice(1));
  updateFileInfo();
  invalidate();
  await runCurrent("sampleReady");
}

function reset(): void {
  fileGeneration = { source: fileGeneration.source + 1, previous: fileGeneration.previous + 1 };
  sourceState = null;
  previousState = null;
  operationGeneration += 1;
  clearDownloadsAndResult();
  for (const id of ["source-file", "previous-file"]) $<HTMLInputElement>(`#${id}`).value = "";
  $("#source-preview").replaceChildren();
  $("#column-rules").replaceChildren();
  $("#column-rules").hidden = true;
  $("#rule-empty").hidden = false;
  $("#status").textContent = "";
  $<HTMLButtonElement>("#run").disabled = true;
  updateFileInfo();
  setStep("file");
}

function report(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  $("#status").textContent = `${message("failed")}: ${detail}`;
  $<HTMLButtonElement>("#run").disabled = !sourceState;
}

$("#language").addEventListener("change", event => {
  language = (event.currentTarget as HTMLSelectElement).value as Language;
  applyLanguage();
});
$("#source-file").addEventListener("change", event => {
  void loadFile("source", (event.currentTarget as HTMLInputElement).files?.[0]).catch(report);
});
$("#previous-file").addEventListener("change", event => {
  void loadFile("previous", (event.currentTarget as HTMLInputElement).files?.[0]).catch(report);
});
$("#column-rules").addEventListener("change", event => {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>(".column-rule");
  if (target.classList.contains("column-transform") && row) {
    row.querySelector<HTMLInputElement>(".enum-map")!.hidden = (target as HTMLSelectElement).value !== "enum";
  }
  if (target.classList.contains("column-keep") && row) {
    row.classList.toggle("is-excluded", !(target as HTMLInputElement).checked);
  }
  invalidate();
});
$("#column-rules").addEventListener("input", invalidate);
$("#blank-values").addEventListener("input", invalidate);
$("#run").addEventListener("click", () => { void runCurrent().catch(report); });
$("#sample-run").addEventListener("click", () => { void runSample().catch(report); });
$("#reset").addEventListener("click", reset);
document.querySelectorAll<HTMLButtonElement>("[data-result-tab]").forEach(button => {
  button.addEventListener("click", () => {
    resultTab = button.dataset.resultTab as ResultTab;
    renderSelectedResult();
  });
});

const embedded = new URLSearchParams(location.search).get("atelier") === "1";
$("#guided-intake").hidden = !embedded;
$("#guided-intake").addEventListener("click", () => {
  if (!sourceState || !currentResult || !currentProfile) return;
  const sourceBuffer = sourceState.bytes.slice().buffer;
  const previousBuffer = previousState?.bytes.slice().buffer;
  const operationId = JSON.parse(decode(currentResult.manifestJson)).operationId as string;
  const transfer = previousBuffer ? [sourceBuffer, previousBuffer] : [sourceBuffer];
  window.parent.postMessage({
    type: "tabular-intake:open-guided",
    profile: currentProfile,
    sourceBuffer,
    previousBuffer,
    sourceFileName: sourceState.fileName,
    previousFileName: previousState?.fileName,
    operationId,
  }, location.origin, transfer);
});
if (embedded) window.addEventListener("keydown", event => {
  if (event.key === "Escape") window.parent.postMessage({ type: "tabular-intake:close" }, location.origin);
});

$("#version").textContent = `package ${PACKAGE_VERSION} · contract ${CORE_VERSION}`;
applyLanguage();
updateFileInfo();
setStep("file");
