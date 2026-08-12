import { localDateStamp } from './local-time.js';

// The run that writes the CSV and downloads nothing had five names: `dryRun`
// in the options, `'dry-run'` as an outcome key and a trace kind, "Preview
// only" on the checkbox, "listed" in the running screen, and "dry run" in this
// column. The code word is `dryRun` - it names the flag, and a flag reads as a
// flag. The word a reader ever sees is "preview", and this is the one place
// that says so: the outcome key, the counts bucket and the Resume cell are all
// this constant, so a grep for one finds all three.
export const PREVIEW = 'preview';

// Every value the Resume column can hold. This file declares the column, and
// these strings are nothing but the text that goes in it, so this is where
// they live; the runner imports them to write one, and the panel and the tests
// name the same strings the CSV does.
export const RESUME_STATUS = {
  DOWNLOADED: 'downloaded',
  ALREADY: 'already downloaded',
  NO_RESUME: 'no resume on file',
  NO_ID: 'not identifiable',
  LOCKED: 'locked on Wellfound',
  PREVIEW: PREVIEW,
  NOT_REACHED: 'not fetched: the run stopped first',
};

// Wellfound sends Unix seconds (1786465883). The raw integer is meaningless in a
// spreadsheet, so the CSV carries a date and only a date - `YYYY-MM-DD`, because
// this file is destined for a sort, not for prose, and a locale string is
// neither sortable nor unambiguous. The day is the reader's own day: an instant
// late in their evening belongs to the date they would name, not to the UTC one.
const MS_THRESHOLD = 1e11;

export function formatDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    // A bare date carries no timezone to convert from, so it is taken as it
    // stands. A stamp with a time in it is an instant, and an instant is
    // rendered on the reader's clock like every other one.
    const bare = value.match(/^(\d{4}-\d{2}-\d{2})$/);
    if (bare) return bare[1];
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? '' : localDateStamp(parsed);
    }
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  // Seconds or milliseconds. Anything below the threshold is far too early to be
  // a real millisecond stamp and far too late to be anything but seconds.
  const ms = Math.abs(n) < MS_THRESHOLD ? n * 1000 : n;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return localDateStamp(date);
}

// `format` turns a stored value into the cell a reader sees. Presentation lives
// here because this module owns the file's shape; the record keeps the raw value.
export const CSV_COLUMNS = [
  { key: 'name', header: 'Name' },
  { key: 'userId', header: 'User ID' },
  { key: 'jobId', header: 'Job ID' },
  { key: 'jobTitle', header: 'Job Title' },
  { key: 'location', header: 'Location' },
  { key: 'yearsExperience', header: 'Years Experience' },
  { key: 'linkedinUrl', header: 'LinkedIn' },
  { key: 'githubUrl', header: 'GitHub' },
  { key: 'website', header: 'Website' },
  { key: 'wellfoundUrl', header: 'Wellfound URL' },
  { key: 'usAuthorized', header: 'US Authorized' },
  { key: 'submittedAt', header: 'Applied At', format: formatDate },
  { key: 'resumeUrl', header: 'Resume Link' },
  { key: 'resumeFilename', header: 'Resume Filename' },
  // Why the filename cell is blank. Without this, "fetched on an earlier run"
  // and "never fetched" are the same empty cell.
  { key: 'resumeStatus', header: 'Resume' },
];

const BOM = '\ufeff';

export function escapeField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(records) {
  const header = CSV_COLUMNS.map((c) => c.header).join(',');
  const rows = records.map((r) =>
    CSV_COLUMNS.map((c) => escapeField(c.format ? c.format(r[c.key]) : r[c.key])).join(','),
  );
  return BOM + [header, ...rows].join('\r\n') + '\r\n';
}

// Minimal RFC 4180 row splitter: enough for CSVs this extension wrote.
function parseRow(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

// The only two Resume values that mean "the file is on disk". Everything else -
// "not fetched: the run stopped first", "no resume on file", "not
// identifiable", "preview", "locked on Wellfound", "failed: ..." - means the
// import must not teach the ledger that this person is done, or they would
// never be fetched again.
export const ADOPTABLE_RESUME_STATUSES = new Set([
  RESUME_STATUS.DOWNLOADED,
  RESUME_STATUS.ALREADY,
]);

// The filter lives here rather than in importCsv because this module owns the
// CSV's shape: it declares the columns, it writes the Resume cell, and it is the
// only place that has to change if a status string ever moves. importCsv would
// otherwise have to re-parse header names to make the same decision.
export function userIdsFromCsv(text) {
  const lines = text
    .replace(/^\ufeff/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const header = parseRow(lines[0]);
  const index = header.indexOf('User ID');
  if (index === -1) return [];
  const statusIndex = header.indexOf('Resume');
  // Older CSVs predate the Resume column. Their Resume Filename cell is the
  // only surviving evidence that a file landed, so fall back to it: a named
  // file is proof, a blank cell is not. Getting this wrong in the generous
  // direction is permanent (the person is never fetched again); getting it
  // wrong in the strict direction costs one re-download that overwrites in
  // place, so the strict reading is the safe one.
  const filenameIndex = header.indexOf('Resume Filename');

  const rows = lines.slice(1).map(parseRow);
  return rows
    .filter((row) => {
      if (statusIndex !== -1) return ADOPTABLE_RESUME_STATUSES.has(row[statusIndex]?.trim());
      if (filenameIndex !== -1) return Boolean(row[filenameIndex]?.trim());
      // Neither column: nothing in the file distinguishes a fetched person from
      // a listed one, so adopt nobody rather than adopt everybody.
      return false;
    })
    .map((row) => row[index]?.trim())
    .filter((id) => id);
}