// The grammar of a resume filename, and its only owner.
//
// `{name}-{userId}-{jobId}.{ext}` is not just a way of writing a name down: it
// is the only record of who a file on disk belongs to. Reconciliation reads a
// job's files back out of the download history by matching this shape, so
// building and parsing it are two halves of one contract. They used to live in
// two modules with no import between them, each tested against its own
// literals - so changing the separator here would have left reconciliation
// matching nothing, the Library reporting every file missing, "Re-download
// missing" offering to re-fetch the entire ledger, and no test failing.
// Everything below is derived from SEPARATOR and EXT_PATTERN, and the round
// trip is asserted in one place.
const SEPARATOR = '-';
const EXT_PATTERN = '[A-Za-z0-9]{2,5}';
// Wellfound user ids are digits, and the digits are what makes the tail
// unambiguous however many separators a person's own name contains.
const ID_PATTERN = '\\d+';

const RESERVED = /[\\/:*?"<>|]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const MAX_BASE = 100;

const MIME_EXT = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
};

export function sanitizeName(name) {
  const cleaned = String(name ?? '')
    .replace(CONTROL, '')
    .replace(RESERVED, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BASE)
    // Truncating can expose a new trailing dot or space, so trim after slicing,
    // not before - Windows silently rejects both at the end of a filename.
    .replace(/[. ]+$/, '');
  return cleaned || 'unknown';
}

export function extensionFromUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : null;
}

export function buildFilename({ name, userId, jobId, url, mimeType }) {
  const ext = extensionFromUrl(url) ?? MIME_EXT[mimeType] ?? 'pdf';
  return [sanitizeName(name), userId, jobId].join(SEPARATOR) + `.${ext}`;
}

// A jobId goes into a regex, so it may not carry regex syntax with it.
const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The tail of the grammar, for chrome.downloads.search: a job's files are
// exactly the ones ending in this. Anchored at the end, so a path in front of
// it is fine and the CSV - `applicants-{jobId}-{date}.csv` - is not a match.
// The userId and the extension are captured, because parseFilename below reads
// them out of this very pattern rather than writing a second one. Chrome's
// filenameRegex ignores groups, so the two uses share one string.
export function filenameRegexForJob(jobId) {
  return `${SEPARATOR}(${ID_PATTERN})${SEPARATOR}${escapeRe(jobId)}\\.(${EXT_PATTERN})$`;
}

// buildFilename, run backwards. Returns null for anything that is not this
// job's file, so a caller never has to know the shape in order to reject one.
// The name is whatever precedes the tail: a person whose own name contains a
// separator is still parsed correctly, because the digits and the jobId are
// what make the tail unambiguous.
export function parseFilename(path, jobId) {
  const base = basename(path);
  const match = base.match(new RegExp(`^(.*)${filenameRegexForJob(jobId)}`));
  if (!match) return null;
  const [, name, userId, ext] = match;
  return { name, userId, jobId: String(jobId), ext };
}

// The last path segment, Windows or POSIX. `chrome.downloads.search` answers
// with a full path, and the CSV's column is called Resume Filename: a cell
// reading `D:\Downloads\wellfound-resumes\Jane Doe-....pdf` publishes the
// user's directory layout into a file people forward.
export function basename(path) {
  return String(path ?? '').split(/[\\/]/).pop() ?? '';
}
