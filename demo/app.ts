import { parse } from "csv-parse/browser/esm/sync";

import sampleHistory from "./fixtures/history-ko.csv";
import sampleSource from "./fixtures/roster-ko.csv";
import {
  CORE_VERSION,
  MAX_INPUT_BYTES,
  PACKAGE_VERSION,
  IntakeError,
  canonicalizeCsv,
  runIntake,
  type IntakeOutput,
  type RuleValue,
} from "../js/core";

type Language = "ko" | "en" | "ja";
type InputKind = "source" | "history";
type CsvRow = Record<string, string>;
type InputState = {
  bytes: Uint8Array;
  headers: string[];
  rows: number;
  table: string[][];
  name: string;
};
type RoleSpec = { role: string; label: string; required: boolean; aliases: readonly string[] };

const messages: Record<Language, Record<string, string>> = {
  ko: {
    language: "언어", eyebrow: "설치 없이 명단 정리",
    title: "신청·예약 명단을 올리면, 안내 준비 명단과 확인할 명단으로 나눠드려요",
    lead: "엑셀이나 구글 시트에서 CSV로 저장한 명단을 고르세요. 파일은 이 브라우저 밖으로 나가지 않습니다.",
    privacy: "서버 전송 0회 · 브라우저 저장 0회 · AI 사용 0회", sample: "예제로 먼저 따라 해보기",
    stepSource: "명단 고르기", stepMap: "열 확인", stepHistory: "예전 명단", stepRules: "기준 확인", stepResult: "결과 받기",
    progressAria: "명단 정리 진행 단계", navigationAria: "단계 이동", downloadAria: "주요 결과 다운로드",
    sourceTitle: "정리할 명단을 골라주세요", sourceHelp: "엑셀이나 구글 시트에서 저장한 명단 파일(.csv)이면 됩니다.",
    sourceChoose: "내 명단 파일 고르기", fileLimit: "최대 20MiB · 파일 내용은 선택해도 전송되지 않습니다.",
    fileHelpTitle: "CSV 파일 만드는 법", fileHelp: "엑셀은 ‘파일 → 다른 이름으로 저장 → CSV UTF-8’, 구글 시트는 ‘파일 → 다운로드 → 쉼표로 구분된 값(.csv)’을 고르세요. 첫 줄의 열 이름은 남겨둡니다.",
    phoneProfile: "전화번호 확인은 한국 휴대전화 형식(010)을 기준으로 합니다.",
    mappingTitle: "어느 열이 무엇인지 확인해주세요", mappingHelp: "추천이 맞는지만 확인하면 됩니다. 예시는 내 기기에서만 보여요.",
    historyTitle: "예전에 처리한 명단이 있나요?", historyHelp: "없어도 괜찮습니다. 있으면 예전 참여·차단 기록을 함께 확인합니다.",
    historyChoice: "예전 명단 선택", historyNone: "없어요", historyHave: "파일이 있어요", historyChoose: "예전 명단 파일 고르기",
    historyLimit: "이 파일도 브라우저 밖으로 보내지 않습니다.", rulesTitle: "다시 볼 기준이 있나요?",
    rulesHelp: "모르면 그대로 두세요. 파일에 있는 선택지를 보여드리며, 자동으로 확정하지 않습니다.",
    closedValues: "이미 마감된 신청 항목", blockedValues: "다시 확인할 예전 기록", otherValue: "직접 입력", noneUnknown: "없어요 / 모르겠어요",
    next: "다음", previous: "이전", run: "이 브라우저에서 명단 나누기", reset: "모두 지우고 다시 시작",
    resultEyebrow: "기기 안에서 정리 완료", resultTitle: "문자나 안내를 보내기 전에 두 목록을 확인하세요",
    resultLead: "형식이 정리된 안내 준비 명단과 사람이 먼저 확인할 명단을 따로 만들었습니다.",
    contactNotice: "이 도구는 발송 동의나 실제 수신 대상을 판단하지 않습니다. 보내기 전 담당자가 최종 확인하세요.",
    downloadNormalized: "안내 준비 명단 받기", downloadReview: "확인할 명단 받기", downloadNote: "엑셀에서 바로 열 수 있도록 만든 파일입니다.",
    previewTitle: "명단 내용 미리보기", normalizedPreview: "안내 준비 명단", reviewPreview: "확인할 명단",
    technical: "기술 정보와 처리 증명 파일", proofHelp: "처리 증명 파일은 같은 파일과 기준으로 처리됐는지 기술 담당자가 확인하는 자료입니다.",
    downloadCanonicalNormalized: "원본 형식의 normalized.csv", downloadCanonicalReview: "원본 형식의 review.csv", downloadManifest: "처리 증명 파일",
    guided: "반복 업무 가져오기 시작", guidedHelp: "이 화면의 파일은 넘기지 않습니다. 다음 화면에서 원본을 다시 골라 진단합니다.", technicalError: "기술 오류 정보",
    fileReady: "파일을 읽었습니다", sampleFile: "연습용 명단", rows: "명", columns: "개 항목", choose: "열을 선택하세요", optional: "사용하지 않음",
    recommended: "추천됨 · 맞는지 확인해주세요", examples: "파일 속 예시", noExample: "빈 값만 있어요",
    sampleLoaded: "연습용 명단을 준비했습니다. 1단계부터 ‘다음’을 눌러 확인해보세요.", resultReady: "명단을 나눴습니다. 두 파일을 내려받아 확인하세요.",
    summary_normal: "형식 확인 완료", summary_information_review: "빠진 정보를 채울 명단", summary_duplicate_candidate: "같은 사람인지 확인할 명단",
    summary_blocked_candidate: "이전 기록 때문에 다시 볼 명단", summary_closed: "마감된 항목",
    role_name: "이름", role_phone: "전화번호", role_date: "날짜 또는 생년월일", role_item: "신청 항목", role_submitted_at: "신청 시각",
    role_disposition: "예전 처리 상태", role_period: "기수 또는 기간", role_category: "분류",
    output_id: "번호", output_name: "이름", output_phone: "전화번호", output_date: "날짜", output_item: "신청 항목", output_history: "예전 기록", output_issue: "확인할 일",
    status_ready: "바로 사용", status_information_review: "빠진 정보 확인", status_duplicate_candidate: "같은 사람인지 확인",
    status_blocked: "예전 차단 기록 확인", status_block_candidate: "예전 기록과 같은 사람인지 확인", status_closed: "마감된 항목",
    reason_missing_or_invalid_name: "이름이 비었거나 읽기 어렵습니다", reason_missing_or_invalid_phone: "전화번호가 비었거나 형식이 다릅니다",
    reason_missing_or_invalid_date: "날짜가 비었거나 형식이 다릅니다", reason_missing_or_invalid_item: "신청 항목이 비었습니다",
    reason_closed_item: "마감으로 고른 항목입니다", reason_blocked_phone: "예전 차단 기록과 전화번호가 같습니다",
    reason_blocked_name_date: "예전 차단 기록과 이름·날짜가 같습니다", reason_exact_duplicate: "이름·전화번호·날짜가 모두 같은 줄이 있습니다",
    reason_name_date_match: "이름·날짜는 같지만 전화번호가 다릅니다", reason_name_phone_match: "이름·전화번호는 같지만 날짜가 다릅니다",
    reason_phone_date_match: "전화번호·날짜는 같지만 이름이 다릅니다",
    error_invalid_utf8: "파일 저장 형식을 읽지 못했습니다. 엑셀에서 ‘CSV UTF-8’로 다시 저장해주세요.",
    error_malformed_csv: "명단 표를 읽지 못했습니다. 셀 안의 줄바꿈이나 따옴표를 확인해주세요.",
    error_row_width_mismatch: "어떤 줄의 항목 수가 첫 줄과 다릅니다. 엑셀에서 다시 CSV로 저장해주세요.",
    error_invalid_header_mapping: "필요한 열을 모두 하나씩 골라주세요.", error_invalid_rules: "확인 기준을 읽지 못했습니다. 선택한 값을 다시 확인해주세요.",
    error_limit_exceeded: "파일이나 셀이 너무 큽니다. 파일을 나눠서 다시 시도해주세요.",
    error_unsafe_spreadsheet_cell: "수식처럼 실행될 수 있는 셀이 있어 안전을 위해 멈췄습니다.", error_unknown: "명단을 처리하지 못했습니다. 파일을 다시 확인해주세요.",
  },
  en: {
    language: "Language", eyebrow: "Clean a roster without installing anything",
    title: "Turn a registration or booking roster into an outreach worklist and a check list",
    lead: "Choose a .csv saved from Excel or Google Sheets. The file never leaves this browser.",
    privacy: "0 server uploads · 0 browser storage · 0 AI use", sample: "Try the guided example",
    stepSource: "Choose file", stepMap: "Check columns", stepHistory: "Past roster", stepRules: "Check rules", stepResult: "Get results",
    progressAria: "Roster cleanup progress", navigationAria: "Step navigation", downloadAria: "Main result downloads",
    sourceTitle: "Choose the roster to clean", sourceHelp: "Use a .csv saved from Excel or Google Sheets.", sourceChoose: "Choose my roster file",
    fileLimit: "20MiB maximum · Choosing a file does not upload it.", fileHelpTitle: "If the file will not open",
    fileHelp: "In Excel choose File → Save As → CSV UTF-8. In Google Sheets choose File → Download → Comma-separated values (.csv). Keep the column names in the first row.",
    phoneProfile: "Phone-number checks currently use the Korean mobile format beginning with 010.",
    mappingTitle: "Check what each column means", mappingHelp: "Confirm the suggestions. Examples are shown only on your device.",
    historyTitle: "Do you have a roster from an earlier run?", historyHelp: "It is optional. Add one to check prior participation or blocks.",
    historyChoice: "Past roster", historyNone: "No", historyHave: "I have a file", historyChoose: "Choose the past roster",
    historyLimit: "This file also stays inside the browser.", rulesTitle: "Is there anything that needs another look?",
    rulesHelp: "Leave this unchanged if you are unsure. Values are shown from the file but never confirmed automatically.",
    closedValues: "Application choices that are already closed", blockedValues: "Past records to check again", otherValue: "Enter another value", noneUnknown: "None / not sure",
    next: "Next", previous: "Back", run: "Split the roster in this browser", reset: "Clear and start again",
    resultEyebrow: "Finished on this device", resultTitle: "Check both lists before sending a message or notice", resultLead: "We separated a formatted outreach worklist from records a person should check first.",
    contactNotice: "This tool does not determine consent or who should receive a message. A person must make the final check before sending.",
    downloadNormalized: "Download outreach worklist", downloadReview: "Download check list", downloadNote: "These files include a BOM so Excel can open them directly.",
    previewTitle: "Preview the lists", normalizedPreview: "Outreach worklist", reviewPreview: "Check list", technical: "Technical details and processing proof",
    proofHelp: "The processing proof lets a technical reviewer confirm that the same files and rules produced these results.",
    downloadCanonicalNormalized: "Canonical normalized.csv", downloadCanonicalReview: "Canonical review.csv", downloadManifest: "Processing proof file",
    guided: "Start a repeatable-workflow intake", guidedHelp: "This screen does not transfer your files. Choose the source again on the next screen so it can be audited.", technicalError: "Technical error details",
    fileReady: "File loaded", sampleFile: "Practice roster", rows: "people", columns: "columns", choose: "Choose a column", optional: "Do not use",
    recommended: "Suggested · please confirm", examples: "Examples in this file", noExample: "Only blank values", sampleLoaded: "The practice roster is ready. Start at step 1 and press Next.",
    resultReady: "The lists are ready. Download both files and review them.",
    summary_normal: "Format checks passed", summary_information_review: "Needs missing information", summary_duplicate_candidate: "Check if this is the same person",
    summary_blocked_candidate: "Check because of a past record", summary_closed: "Closed choices",
    role_name: "Name", role_phone: "Phone number", role_date: "Date or birth date", role_item: "Application choice", role_submitted_at: "Submitted time",
    role_disposition: "Past status", role_period: "Round or period", role_category: "Category",
    output_id: "Row", output_name: "Name", output_phone: "Phone", output_date: "Date", output_item: "Application choice", output_history: "Past record", output_issue: "What to check",
    status_ready: "Ready", status_information_review: "Check missing information", status_duplicate_candidate: "Check whether this is the same person",
    status_blocked: "Check a past block", status_block_candidate: "Check whether this matches a past block", status_closed: "Closed choice",
    reason_missing_or_invalid_name: "The name is missing or unreadable", reason_missing_or_invalid_phone: "The phone number is missing or has another format",
    reason_missing_or_invalid_date: "The date is missing or has another format", reason_missing_or_invalid_item: "The application choice is missing",
    reason_closed_item: "This choice was marked closed", reason_blocked_phone: "The phone number matches a past blocked record",
    reason_blocked_name_date: "The name and date match a past blocked record", reason_exact_duplicate: "Another row has the same name, phone, and date",
    reason_name_date_match: "The name and date match but the phone differs", reason_name_phone_match: "The name and phone match but the date differs",
    reason_phone_date_match: "The phone and date match but the name differs",
    error_invalid_utf8: "The file encoding could not be read. Save it again as ‘CSV UTF-8’ in Excel.", error_malformed_csv: "The roster could not be read. Check line breaks or quotation marks inside cells.",
    error_row_width_mismatch: "A row has a different number of columns. Save the sheet as CSV again.", error_invalid_header_mapping: "Choose one column for every required item.",
    error_invalid_rules: "The review rules could not be read. Check your selections.", error_limit_exceeded: "The file or a cell is too large. Split the file and try again.",
    error_unsafe_spreadsheet_cell: "A cell could run as a spreadsheet formula, so processing stopped for safety.", error_unknown: "The roster could not be processed. Check the file and try again.",
  },
  ja: {
    language: "言語", eyebrow: "インストールなしで名簿整理", title: "申込・予約名簿を、案内準備の一覧と確認する一覧に分けます",
    lead: "ExcelやGoogleスプレッドシートから保存した.csvを選んでください。ファイルはこのブラウザーの外に出ません。",
    privacy: "サーバー送信0回 · ブラウザー保存0回 · AI使用0回", sample: "練習例を試す",
    stepSource: "ファイル", stepMap: "列を確認", stepHistory: "過去名簿", stepRules: "基準を確認", stepResult: "結果",
    progressAria: "名簿整理の進行", navigationAria: "手順の移動", downloadAria: "主な結果のダウンロード",
    sourceTitle: "整理する名簿を選んでください", sourceHelp: "ExcelやGoogleスプレッドシートから保存した.csvを使えます。", sourceChoose: "名簿ファイルを選ぶ",
    fileLimit: "最大20MiB · 選んでもアップロードされません。", fileHelpTitle: "ファイルを開けないとき",
    fileHelp: "Excelでは「ファイル → 名前を付けて保存 → CSV UTF-8」、Googleスプレッドシートでは「ファイル → ダウンロード → カンマ区切り形式（.csv）」を選び、1行目の列名を残してください。",
    phoneProfile: "電話番号の確認は、現在韓国の携帯電話形式（010）を基準にしています。",
    mappingTitle: "各列の意味を確認してください", mappingHelp: "候補が合っているか確認します。例は端末内だけに表示されます。",
    historyTitle: "以前に処理した名簿がありますか？", historyHelp: "なくても大丈夫です。ある場合は過去の参加・ブロック記録も確認します。",
    historyChoice: "過去名簿", historyNone: "ありません", historyHave: "ファイルがあります", historyChoose: "過去名簿を選ぶ", historyLimit: "このファイルもブラウザーの外へ送りません。",
    rulesTitle: "もう一度確認する基準がありますか？", rulesHelp: "分からなければそのままで構いません。ファイル内の候補を表示しますが、自動確定しません。",
    closedValues: "すでに締め切った申込項目", blockedValues: "再確認する過去記録", otherValue: "別の値を入力", noneUnknown: "なし / 分からない",
    next: "次へ", previous: "戻る", run: "このブラウザーで名簿を分ける", reset: "消去して最初から",
    resultEyebrow: "端末内で完了", resultTitle: "メッセージや案内を送る前に2つの一覧を確認してください", resultLead: "形式を整えた案内準備名簿と、人が先に確認する名簿を分けました。",
    contactNotice: "このツールは送信同意や実際の送信対象を判断しません。送信前に担当者が最終確認してください。",
    downloadNormalized: "案内準備名簿を保存", downloadReview: "確認する名簿を保存", downloadNote: "Excelで直接開けるファイルです。",
    previewTitle: "名簿をプレビュー", normalizedPreview: "案内準備名簿", reviewPreview: "確認する名簿", technical: "技術情報と処理証明ファイル",
    proofHelp: "処理証明ファイルは、同じファイルと基準で処理されたかを技術担当者が確認する資料です。",
    downloadCanonicalNormalized: "元形式のnormalized.csv", downloadCanonicalReview: "元形式のreview.csv", downloadManifest: "処理証明ファイル",
    guided: "反復業務の取り込みを開始", guidedHelp: "この画面のファイルは引き継ぎません。次の画面でもう一度原本を選び、診断します。", technicalError: "技術エラー情報",
    fileReady: "ファイルを読み込みました", sampleFile: "練習用名簿", rows: "人", columns: "項目", choose: "列を選ぶ", optional: "使用しない",
    recommended: "候補 · 確認してください", examples: "ファイル内の例", noExample: "空欄のみ", sampleLoaded: "練習用名簿を用意しました。手順1から「次へ」を押してください。",
    resultReady: "名簿を分けました。2つのファイルを保存して確認してください。",
    summary_normal: "形式確認済み", summary_information_review: "不足情報を補う名簿", summary_duplicate_candidate: "同じ人か確認する名簿",
    summary_blocked_candidate: "過去記録のため再確認", summary_closed: "締切項目",
    role_name: "氏名", role_phone: "電話番号", role_date: "日付・生年月日", role_item: "申込項目", role_submitted_at: "申込時刻",
    role_disposition: "過去の状態", role_period: "期・期間", role_category: "分類",
    output_id: "番号", output_name: "氏名", output_phone: "電話番号", output_date: "日付", output_item: "申込項目", output_history: "過去記録", output_issue: "確認すること",
    status_ready: "すぐ使用", status_information_review: "不足情報を確認", status_duplicate_candidate: "同じ人か確認",
    status_blocked: "過去のブロック記録を確認", status_block_candidate: "過去記録と同じ人か確認", status_closed: "締切項目",
    reason_missing_or_invalid_name: "氏名が空欄か読み取れません", reason_missing_or_invalid_phone: "電話番号が空欄か形式が異なります",
    reason_missing_or_invalid_date: "日付が空欄か形式が異なります", reason_missing_or_invalid_item: "申込項目が空欄です",
    reason_closed_item: "締切として選んだ項目です", reason_blocked_phone: "過去のブロック記録と電話番号が同じです",
    reason_blocked_name_date: "過去のブロック記録と氏名・日付が同じです", reason_exact_duplicate: "氏名・電話番号・日付が同じ行があります",
    reason_name_date_match: "氏名・日付は同じですが電話番号が異なります", reason_name_phone_match: "氏名・電話番号は同じですが日付が異なります",
    reason_phone_date_match: "電話番号・日付は同じですが氏名が異なります",
    error_invalid_utf8: "ファイルの保存形式を読めません。Excelで「CSV UTF-8」として保存し直してください。",
    error_malformed_csv: "名簿を読めません。セル内の改行や引用符を確認してください。", error_row_width_mismatch: "行によって項目数が異なります。CSVとして保存し直してください。",
    error_invalid_header_mapping: "必要な項目ごとに列を1つ選んでください。", error_invalid_rules: "確認基準を読めません。選択を確認してください。",
    error_limit_exceeded: "ファイルまたはセルが大きすぎます。ファイルを分けてください。", error_unsafe_spreadsheet_cell: "数式として実行される可能性があるセルのため、安全に停止しました。",
    error_unknown: "名簿を処理できませんでした。ファイルを確認してください。",
  },
};

const sourceRoles: readonly RoleSpec[] = [
  { role: "name", label: "role_name", required: true, aliases: ["name", "이름", "성명", "신청자", "신청자명", "氏名", "名前"] },
  { role: "phone", label: "role_phone", required: true, aliases: ["phone", "phone number", "전화", "전화번호", "연락처", "휴대폰", "電話番号", "携帯電話"] },
  { role: "date", label: "role_date", required: true, aliases: ["date", "birth date", "birthday", "날짜", "생년월일", "생일", "출생일", "日付", "生年月日"] },
  { role: "item", label: "role_item", required: true, aliases: ["item", "choice", "program", "항목", "신청항목", "신청 항목", "희망프로그램", "프로그램", "선택", "項目", "申込項目"] },
  { role: "submitted_at", label: "role_submitted_at", required: false, aliases: ["submitted at", "timestamp", "신청일시", "제출시각", "제출시간", "申込日時", "提出時刻"] },
];
const historyRoles: readonly RoleSpec[] = [
  { role: "disposition", label: "role_disposition", required: true, aliases: ["disposition", "status", "상태", "처리상태", "참여상태", "이력", "状態", "ステータス"] },
  { role: "name", label: "role_name", required: true, aliases: sourceRoles[0]?.aliases ?? [] },
  { role: "phone", label: "role_phone", required: true, aliases: sourceRoles[1]?.aliases ?? [] },
  { role: "date", label: "role_date", required: true, aliases: sourceRoles[2]?.aliases ?? [] },
  { role: "period", label: "role_period", required: false, aliases: ["period", "round", "기수", "기간", "회차", "期", "期間"] },
  { role: "category", label: "role_category", required: false, aliases: ["category", "분류", "구분", "カテゴリ", "分類"] },
];
const SUMMARY_KEYS = ["normal", "information_review", "duplicate_candidate", "blocked_candidate", "closed"] as const;

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing demo element: ${selector}`);
  return element;
};
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const normalizeHeader = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en").replace(/[\s_.\-/]+/gu, "");
const csvCell = (value: unknown) => {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

let language: Language = new URLSearchParams(location.search).get("lang") as Language
  || (navigator.language.startsWith("ja") ? "ja" : navigator.language.startsWith("en") ? "en" : "ko");
if (!(language in messages)) language = "ko";
let sourceState: InputState | null = null;
let historyState: InputState | null = null;
let currentStep = 0;
let sampleMode = false;
let downloadUrls: string[] = [];
let generation = 0;
let lastOutput: IntakeOutput | null = null;
let lastElapsed = 0;
let lastError: { code: string; detail: string } | null = null;
let lastStatusKey: string | null = null;

function message(key: string): string { return messages[language][key] ?? messages.ko[key] ?? key; }

function inspect(bytes: Uint8Array, name: string): InputState {
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new IntakeError("limit_exceeded", "CSV exceeds 20MiB");
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ""); }
  catch { throw new IntakeError("invalid_utf8", "CSV must be UTF-8"); }
  let table: string[][];
  try { table = parse(value, { bom: true, relax_column_count: true, skip_empty_lines: false }) as string[][]; }
  catch { throw new IntakeError("malformed_csv", "CSV is malformed"); }
  const headers = (table[0] ?? []).map(item => String(item).trim());
  if (!headers.length || headers.some(header => !header) || new Set(headers).size !== headers.length) {
    throw new IntakeError("invalid_header_mapping", "CSV has blank or duplicate column names");
  }
  const data = table.slice(1).filter(row => row.some(cell => String(cell).trim()));
  if (data.some(row => row.length !== headers.length)) throw new IntakeError("row_width_mismatch", "CSV row width differs from its header");
  return { bytes, headers, rows: data.length, table: [headers, ...data], name };
}

function rolesFor(kind: InputKind): readonly RoleSpec[] { return kind === "source" ? sourceRoles : historyRoles; }

function recommendedHeaders(kind: InputKind, state: InputState): Map<string, string> {
  const candidates = new Map<string, string[]>();
  for (const spec of rolesFor(kind)) {
    const aliases = new Set(spec.aliases.map(normalizeHeader));
    candidates.set(spec.role, state.headers.filter(header => aliases.has(normalizeHeader(header))));
  }
  const useCount = new Map<string, number>();
  for (const hits of candidates.values()) for (const header of hits) useCount.set(header, (useCount.get(header) ?? 0) + 1);
  const result = new Map<string, string>();
  for (const [role, hits] of candidates) if (hits.length === 1 && useCount.get(hits[0] ?? "") === 1) result.set(role, hits[0] ?? "");
  return result;
}

function examplesFor(state: InputState, header: string): string[] {
  const index = state.headers.indexOf(header);
  if (index < 0) return [];
  const values: string[] = [];
  for (const row of state.table.slice(1)) {
    const value = String(row[index] ?? "").trim();
    if (value && !values.includes(value)) values.push(value);
    if (values.length === 2) break;
  }
  return values;
}

function renderFileInfo(kind: InputKind, state: InputState): void {
  const info = $<HTMLDivElement>(`#${kind}-info`);
  info.hidden = false;
  info.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = `${state.name} · ${message("fileReady")}`;
  const span = document.createElement("span");
  span.textContent = `${state.rows} ${message("rows")} · ${state.headers.length} ${message("columns")}`;
  info.append(strong, span);
}

function renderMapping(kind: InputKind, state: InputState): void {
  const container = $<HTMLDivElement>(`#${kind}-mapping`);
  const previous = new Map([...container.querySelectorAll<HTMLSelectElement>("select")].map(select => [select.dataset.role ?? "", select.value]));
  const recommended = recommendedHeaders(kind, state);
  container.replaceChildren();
  for (const spec of rolesFor(kind)) {
    const card = document.createElement("article");
    card.className = "mapping-card";
    const label = document.createElement("label");
    const labelText = document.createElement("span");
    labelText.textContent = `${message(spec.label)}${spec.required ? " *" : ""}`;
    const select = document.createElement("select");
    select.dataset.role = spec.role;
    select.required = spec.required;
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = message(spec.required ? "choose" : "optional");
    select.append(empty, ...state.headers.map(header => {
      const option = document.createElement("option");
      option.value = header;
      option.textContent = header;
      return option;
    }));
    const retained = previous.get(spec.role);
    const suggestion = recommended.get(spec.role);
    if (retained && state.headers.includes(retained)) select.value = retained;
    else if (suggestion) select.value = suggestion;
    label.append(labelText, select);
    const suggested = document.createElement("span");
    suggested.className = "mapping-suggestion";
    suggested.textContent = suggestion && select.value === suggestion ? message("recommended") : "";
    const example = document.createElement("p");
    example.className = "mapping-example";
    const updateExample = () => {
      const values = examplesFor(state, select.value);
      example.textContent = `${message("examples")}: ${values.length ? values.join(" / ") : message("noExample")}`;
      suggested.textContent = suggestion && select.value === suggestion ? message("recommended") : "";
    };
    select.addEventListener("change", updateExample);
    updateExample();
    card.append(label, suggested, example);
    container.append(card);
  }
  container.hidden = false;
}

function selectedMapping(kind: InputKind): Record<string, string> {
  const selects = [...document.querySelectorAll<HTMLSelectElement>(`#${kind}-mapping select`)];
  const selected = selects.map(select => select.value).filter(Boolean);
  if (new Set(selected).size !== selected.length) throw new IntakeError("invalid_header_mapping", "One column was selected more than once");
  for (const spec of rolesFor(kind)) {
    if (spec.required && !selects.find(select => select.dataset.role === spec.role)?.value) {
      throw new IntakeError("invalid_header_mapping", "A required column is not selected");
    }
  }
  return Object.fromEntries(selects.filter(select => select.value).map(select => [select.value, select.dataset.role ?? ""]));
}

function historyUsesFile(): boolean {
  return document.querySelector<HTMLInputElement>('input[name="history-choice"]:checked')?.value === "file";
}

function selectedHeader(kind: InputKind, role: string): string {
  return document.querySelector<HTMLSelectElement>(`#${kind}-mapping select[data-role="${role}"]`)?.value ?? "";
}

function distinctValues(state: InputState | null, header: string): string[] {
  if (!state || !header) return [];
  const index = state.headers.indexOf(header);
  if (index < 0) return [];
  const values: string[] = [];
  for (const row of state.table.slice(1)) {
    const value = String(row[index] ?? "").trim();
    if (value && !values.includes(value)) values.push(value);
    if (values.length === 12) break;
  }
  return values;
}

function renderRuleGroup(groupId: "closed-rule" | "blocked-rule", values: string[], sampleValue: string): void {
  const group = $<HTMLFieldSetElement>(`#${groupId}`);
  const container = group.querySelector<HTMLDivElement>(".rule-choices");
  if (!container) return;
  const existing = new Set([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked:not([data-none])')].map(input => input.value));
  const hadExisting = container.childElementCount > 0;
  container.replaceChildren();
  const none = document.createElement("input");
  none.type = "checkbox";
  none.dataset.none = "true";
  none.checked = hadExisting ? existing.size === 0 : !(sampleMode && values.includes(sampleValue));
  const noneLabel = document.createElement("label");
  noneLabel.append(none, document.createTextNode(message("noneUnknown")));
  container.append(noneLabel);
  for (const value of values) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = value;
    input.checked = hadExisting ? existing.has(value) : sampleMode && value === sampleValue;
    const label = document.createElement("label");
    label.append(input, document.createTextNode(value));
    container.append(label);
    input.addEventListener("change", () => { if (input.checked) none.checked = false; });
  }
  const other = group.querySelector<HTMLInputElement>(".rule-other input");
  none.addEventListener("change", () => {
    if (!none.checked) return;
    container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([data-none])').forEach(input => { input.checked = false; });
    if (other) other.value = "";
  });
  other?.addEventListener("input", () => { if (other.value.trim()) none.checked = false; });
}

function renderRules(): void {
  renderRuleGroup("closed-rule", distinctValues(sourceState, selectedHeader("source", "item")), "마감");
  renderRuleGroup("blocked-rule", historyUsesFile() ? distinctValues(historyState, selectedHeader("history", "disposition")) : [], "차단");
}

function ruleValues(groupId: "closed-rule" | "blocked-rule", otherId: "closed-other" | "blocked-other"): string[] {
  const checked = [...document.querySelectorAll<HTMLInputElement>(`#${groupId} input[type="checkbox"]:checked:not([data-none])`)].map(input => input.value.trim()).filter(Boolean);
  const other = $<HTMLInputElement>(`#${otherId}`).value.trim();
  return [...new Set([...checked, ...(other ? [other] : [])])].slice(0, 100);
}

function rules(): RuleValue {
  return {
    schemaVersion: "scalar-tabular-intake-rules/v1",
    requiredFields: ["name", "phone", "date", "item"],
    closedItemValues: ruleValues("closed-rule", "closed-other"),
    historyBlockValues: ruleValues("blocked-rule", "blocked-other"),
    phoneProfile: "kr_mobile",
    maxRows: 100_000,
    maxCellChars: 50_000,
  };
}

function parseRows(bytes: Uint8Array): CsvRow[] {
  return parse(decode(bytes), { bom: true, columns: true, skip_empty_lines: true }) as CsvRow[];
}

function humanReasons(codes: string): string {
  return codes.split("|").filter(Boolean).map(code => message(`reason_${code}`)).join(" · ");
}

function presentationCsv(rows: CsvRow[], review: boolean): Uint8Array {
  const fields = review
    ? [["output_id", "source_id"], ["output_name", "name"], ["output_phone", "phone"], ["output_date", "date"], ["output_item", "item"], ["output_issue", "review_codes"]] as const
    : [["output_id", "source_id"], ["output_name", "name"], ["output_phone", "phone"], ["output_date", "date"], ["output_item", "item"], ["output_history", "history_match"]] as const;
  const lines = [fields.map(([label]) => csvCell(message(label))).join(",")];
  for (const row of rows) {
    lines.push(fields.map(([, field]) => csvCell(field === "review_codes" ? humanReasons(row[field] ?? "") : row[field] ?? "")).join(","));
  }
  return encode(`\uFEFF${lines.join("\r\n")}\r\n`);
}

function renderTable(target: string, bytes: Uint8Array): void {
  const container = $<HTMLDivElement>(target);
  container.replaceChildren();
  const rows = parseRows(bytes);
  if (!rows.length) { container.textContent = "0"; return; }
  const fields = Object.keys(rows[0] ?? {});
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const field of fields) { const th = document.createElement("th"); th.scope = "col"; th.textContent = field; headerRow.append(th); }
  head.append(headerRow);
  const body = document.createElement("tbody");
  for (const row of rows.slice(0, 10)) {
    const tr = document.createElement("tr");
    for (const field of fields) { const td = document.createElement("td"); td.textContent = row[field] ?? ""; td.title = row[field] ?? ""; tr.append(td); }
    body.append(tr);
  }
  table.append(head, body);
  container.append(table);
}

function setDownload(kind: string, bytes: Uint8Array, name: string, type: string): void {
  const anchor = $<HTMLAnchorElement>(`[data-download="${kind}"]`);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  downloadUrls.push(url);
  anchor.href = url;
  anchor.download = name;
}

function clearDownloads(): void {
  downloadUrls.forEach(url => URL.revokeObjectURL(url));
  downloadUrls = [];
  document.querySelectorAll<HTMLAnchorElement>("[data-download]").forEach(anchor => { anchor.removeAttribute("href"); anchor.removeAttribute("download"); });
}

function renderResult(result: IntakeOutput): void {
  clearDownloads();
  const rows = parseRows(result.normalizedCsv);
  const readyRows = rows.filter(row => row.intake_status === "ready");
  const reviewRows = rows.filter(row => row.intake_status !== "ready");
  const readyBytes = presentationCsv(readyRows, false);
  const reviewBytes = presentationCsv(reviewRows, true);
  const readyName = language === "ko" ? "안내-준비-명단.csv" : language === "ja" ? "案内準備名簿.csv" : "outreach-worklist.csv";
  const reviewName = language === "ko" ? "확인할-명단.csv" : language === "ja" ? "確認する名簿.csv" : "roster-to-check.csv";
  setDownload("consumer-normalized", readyBytes, readyName, "text/csv;charset=utf-8");
  setDownload("consumer-review", reviewBytes, reviewName, "text/csv;charset=utf-8");
  setDownload("normalized", result.normalizedCsv, "normalized.csv", "text/csv");
  setDownload("review", result.reviewCsv, "review.csv", "text/csv");
  setDownload("manifest", result.manifestJson, "result-manifest.json", "application/json");

  const summary = $("#summary");
  summary.replaceChildren();
  for (const key of SUMMARY_KEYS) {
    const card = document.createElement("div");
    card.className = "summary-card";
    const strong = document.createElement("strong");
    strong.textContent = String(result.summary[key] ?? 0);
    const label = document.createElement("span");
    label.textContent = message(`summary_${key}`);
    card.append(strong, label);
    summary.append(card);
  }
  const manifest = JSON.parse(decode(result.manifestJson)) as Record<string, unknown>;
  $("#manifest").textContent = JSON.stringify({ packageVersion: PACKAGE_VERSION, processingMs: Number(lastElapsed.toFixed(1)), ...manifest }, null, 2);
  renderTable("#normalized-preview", readyBytes);
  renderTable("#review-preview", reviewBytes);
}

function clearResult(): void {
  clearDownloads();
  lastOutput = null;
  lastElapsed = 0;
  for (const id of ["summary", "normalized-preview", "review-preview", "manifest"]) $(`#${id}`).replaceChildren();
}

function clearError(): void {
  lastError = null;
  const status = $("#status");
  status.dataset.error = "false";
  status.setAttribute("role", "status");
  $("#error-technical").hidden = true;
  $("#error-code").textContent = "";
}

function report(error: unknown): void {
  const code = error instanceof IntakeError ? error.code : "unknown";
  const detail = error instanceof Error ? error.message : String(error);
  lastError = { code, detail };
  lastStatusKey = null;
  const status = $("#status");
  status.dataset.error = "true";
  status.setAttribute("role", "alert");
  status.textContent = message(`error_${code}`) === `error_${code}` ? message("error_unknown") : message(`error_${code}`);
  $("#error-code").textContent = `${code}: ${detail}`;
  $("#error-technical").hidden = false;
}

function setStatus(key: string): void {
  clearError();
  lastStatusKey = key;
  $("#status").textContent = message(key);
}

function showStep(step: number, focus = true): void {
  currentStep = Math.max(0, Math.min(4, step));
  if (currentStep > 0 && lastStatusKey === "sampleLoaded") {
    lastStatusKey = null;
    $("#status").textContent = "";
  }
  document.querySelectorAll<HTMLElement>(".demo-step").forEach(section => { section.hidden = Number(section.dataset.step) !== currentStep; });
  document.querySelectorAll<HTMLElement>("[data-step-indicator]").forEach(item => {
    const index = Number(item.dataset.stepIndicator);
    if (index === currentStep) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
    item.dataset.complete = index < currentStep ? "true" : "false";
  });
  if (focus) requestAnimationFrame(() => {
    const section = document.querySelector<HTMLElement>(`.demo-step[data-step="${currentStep}"]`);
    section?.scrollIntoView({ block: "start" });
    section?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  });
}

async function loadFile(kind: InputKind, file: File | undefined): Promise<void> {
  if (!file) return;
  const current = ++generation;
  if (kind === "source") { sourceState = null; sampleMode = false; clearResult(); }
  else historyState = null;
  clearError();
  try {
    const state = inspect(new Uint8Array(await file.arrayBuffer()), file.name);
    if (current !== generation) return;
    if (kind === "source") sourceState = state; else historyState = state;
    renderFileInfo(kind, state);
    renderMapping(kind, state);
    if (kind === "history") {
      const choice = document.querySelector<HTMLInputElement>('input[name="history-choice"][value="file"]');
      if (choice) choice.checked = true;
      $("#history-file-area").hidden = false;
    }
  } catch (error) { if (current === generation) throw error; }
}

function advance(target: number): void {
  clearError();
  if (target === 1) {
    if (!sourceState) throw new IntakeError("invalid_header_mapping", "Source file is missing");
    renderMapping("source", sourceState);
  }
  if (target === 2) selectedMapping("source");
  if (target === 3) {
    selectedMapping("source");
    if (historyUsesFile()) {
      if (!historyState) throw new IntakeError("invalid_header_mapping", "History file is missing");
      selectedMapping("history");
    }
    renderRules();
  }
  showStep(target);
}

async function runFiles(): Promise<void> {
  if (!sourceState) throw new IntakeError("invalid_header_mapping", "Source file is missing");
  const current = ++generation;
  clearError();
  const started = performance.now();
  const source = canonicalizeCsv(sourceState.bytes, {
    kind: "source", headerMap: selectedMapping("source"), generatedId: "row_number",
    preNormalizers: { date: "kr_resident_or_date" },
  });
  const history = historyUsesFile() && historyState ? canonicalizeCsv(historyState.bytes, {
    kind: "history", headerMap: selectedMapping("history"), generatedId: "row_number",
    preNormalizers: { date: "kr_resident_or_date" },
  }) : undefined;
  const result = await runIntake({ source, history, rules: rules() });
  if (current !== generation) return;
  lastOutput = result;
  lastElapsed = performance.now() - started;
  renderResult(result);
  setStatus("resultReady");
  showStep(4);
}

function loadSample(): void {
  generation += 1;
  clearResult();
  clearError();
  lastStatusKey = null;
  sampleMode = true;
  sourceState = inspect(encode(sampleSource), message("sampleFile"));
  historyState = inspect(encode(sampleHistory), message("sampleFile"));
  renderFileInfo("source", sourceState);
  renderFileInfo("history", historyState);
  renderMapping("source", sourceState);
  renderMapping("history", historyState);
  const choice = document.querySelector<HTMLInputElement>('input[name="history-choice"][value="file"]');
  if (choice) choice.checked = true;
  $("#history-file-area").hidden = false;
  $<HTMLInputElement>("#closed-other").value = "";
  $<HTMLInputElement>("#blocked-other").value = "";
  renderRules();
  setStatus("sampleLoaded");
  showStep(0);
}

function reset(): void {
  generation += 1;
  sourceState = null;
  historyState = null;
  sampleMode = false;
  clearResult();
  clearError();
  for (const id of ["source-file", "history-file", "closed-other", "blocked-other"]) $<HTMLInputElement>(`#${id}`).value = "";
  for (const id of ["source-info", "history-info"]) { const element = $(`#${id}`); element.hidden = true; element.replaceChildren(); }
  for (const id of ["source-mapping", "history-mapping"]) $(`#${id}`).replaceChildren();
  document.querySelector<HTMLInputElement>('input[name="history-choice"][value="none"]')!.checked = true;
  $("#history-file-area").hidden = true;
  $("#closed-rule .rule-choices").replaceChildren();
  $("#blocked-rule .rule-choices").replaceChildren();
  $("#status").textContent = "";
  showStep(0);
}

function applyLanguage(): void {
  document.documentElement.lang = language;
  $<HTMLSelectElement>("#language").value = language;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach(element => { element.textContent = message(element.dataset.i18n ?? ""); });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach(element => { element.setAttribute("aria-label", message(element.dataset.i18nAria ?? "")); });
  if (sourceState) { renderFileInfo("source", sourceState); renderMapping("source", sourceState); }
  if (historyState) { renderFileInfo("history", historyState); renderMapping("history", historyState); }
  if ($("#closed-rule .rule-choices").childElementCount || $("#blocked-rule .rule-choices").childElementCount) renderRules();
  if (lastOutput) renderResult(lastOutput);
  if (lastError) report(new IntakeError(lastError.code, lastError.detail));
  else if (lastStatusKey) $("#status").textContent = message(lastStatusKey);
}

$("#language").addEventListener("change", event => { language = (event.currentTarget as HTMLSelectElement).value as Language; applyLanguage(); });
$("#source-file").addEventListener("change", event => { void loadFile("source", (event.currentTarget as HTMLInputElement).files?.[0]).catch(report); });
$("#history-file").addEventListener("change", event => { void loadFile("history", (event.currentTarget as HTMLInputElement).files?.[0]).catch(report); });
document.querySelectorAll<HTMLInputElement>('input[name="history-choice"]').forEach(input => input.addEventListener("change", () => {
  $("#history-file-area").hidden = !historyUsesFile();
}));
document.querySelectorAll<HTMLButtonElement>("[data-next]").forEach(button => button.addEventListener("click", () => {
  try { advance(Number(button.dataset.next)); } catch (error) { report(error); }
}));
document.querySelectorAll<HTMLButtonElement>("[data-back]").forEach(button => button.addEventListener("click", () => showStep(Number(button.dataset.back))));
$("#run").addEventListener("click", () => { void runFiles().catch(report); });
$("#sample-run").addEventListener("click", loadSample);
$("#reset").addEventListener("click", reset);

const embedded = new URLSearchParams(location.search).get("atelier") === "1";
document.documentElement.dataset.embedded = String(embedded);
$("#guided-intake").hidden = !embedded;
$("#guided-note").hidden = !embedded;
$("#guided-intake").addEventListener("click", () => window.parent.postMessage({ type: "tabular-intake:open-guided" }, location.origin));
if (embedded) window.addEventListener("keydown", event => {
  if (event.key === "Escape") window.parent.postMessage({ type: "tabular-intake:close" }, location.origin);
});
$("#version").textContent = `package ${PACKAGE_VERSION} · contract ${CORE_VERSION}`;
applyLanguage();
showStep(0, false);
