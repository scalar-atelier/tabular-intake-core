/**
 * Read-only scalar-tabular-intake snapshot bridge.
 *
 * Required Script Properties:
 *   SNAPSHOT_SPREADSHEET_ID, SNAPSHOT_SOURCE_TAB, SNAPSHOT_HISTORY_TAB,
 *   SNAPSHOT_SHARED_SECRET
 * Deploy as a web app that executes as the deployer. The request cannot choose
 * a spreadsheet, tab, or range.
 */

const SNAPSHOT_ACTION = 'snapshot_v1';
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_ROWS = 50000;
const MAX_COLUMNS = 100;

function doPost(event) {
  try {
    const request = parseSnapshotRequest_(event);
    verifySnapshotRequest_(request);
    const properties = PropertiesService.getScriptProperties();
    const spreadsheetId = requiredProperty_(properties, 'SNAPSHOT_SPREADSHEET_ID');
    const sourceTab = requiredProperty_(properties, 'SNAPSHOT_SOURCE_TAB');
    const historyTab = requiredProperty_(properties, 'SNAPSHOT_HISTORY_TAB');
    const book = SpreadsheetApp.openById(spreadsheetId);
    const response = {
      schemaVersion: 'scalar-tabular-snapshot/v1',
      source: readBoundTab_(book, sourceTab),
      history: readBoundTab_(book, historyTab),
    };
    return jsonResponse_(200, response);
  } catch (error) {
    return jsonResponse_(400, {error: safeErrorCode_(error)});
  }
}

function parseSnapshotRequest_(event) {
  const text = event && event.postData && event.postData.contents;
  if (!text || text.length > 4096) throw new Error('request_invalid');
  const value = JSON.parse(text);
  const keys = Object.keys(value || {}).sort().join(',');
  if (keys !== 'action,nonce,signature,timestamp') throw new Error('request_invalid');
  return value;
}

function verifySnapshotRequest_(request) {
  if (request.action !== SNAPSHOT_ACTION) throw new Error('action_invalid');
  if (!/^\d{13}$/.test(String(request.timestamp || ''))) throw new Error('timestamp_invalid');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(String(request.nonce || ''))) throw new Error('nonce_invalid');
  if (!/^[0-9a-f]{64}$/.test(String(request.signature || ''))) throw new Error('signature_invalid');
  const timestamp = Number(request.timestamp);
  if (Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) throw new Error('timestamp_expired');
  const secret = requiredProperty_(PropertiesService.getScriptProperties(), 'SNAPSHOT_SHARED_SECRET');
  const canonical = `${request.timestamp}\n${request.nonce}\n${SNAPSHOT_ACTION}`;
  const expected = bytesToHex_(Utilities.computeHmacSha256Signature(canonical, secret));
  if (!constantTimeEqual_(expected, request.signature)) throw new Error('signature_invalid');
  const replayKey = `snapshot_nonce_${bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, request.nonce))}`;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('bridge_busy');
  const cache = CacheService.getScriptCache();
  try {
    if (cache.get(replayKey)) throw new Error('nonce_reused');
    cache.put(replayKey, '1', 600);
  } finally {
    lock.releaseLock();
  }
}

function readBoundTab_(book, tabName) {
  const sheet = book.getSheetByName(tabName);
  if (!sheet) throw new Error('bound_tab_missing');
  const range = sheet.getDataRange();
  if (range.getNumRows() > MAX_ROWS || range.getNumColumns() > MAX_COLUMNS) {
    throw new Error('snapshot_oversized');
  }
  const values = range.getDisplayValues();
  return {
    headers: values.length ? values[0] : [],
    rows: values.length > 1 ? values.slice(1) : [],
  };
}

function requiredProperty_(properties, key) {
  const value = properties.getProperty(key);
  if (!value) throw new Error('bridge_unconfigured');
  return value;
}

function bytesToHex_(bytes) {
  return bytes.map(value => ((value < 0 ? value + 256 : value).toString(16).padStart(2, '0'))).join('');
}

function constantTimeEqual_(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function safeErrorCode_(error) {
  const code = String(error && error.message || 'snapshot_failed');
  return /^[a-z_]{3,64}$/.test(code) ? code : 'snapshot_failed';
}

function jsonResponse_(status, value) {
  return ContentService.createTextOutput(JSON.stringify({status, ...value}))
    .setMimeType(ContentService.MimeType.JSON);
}
