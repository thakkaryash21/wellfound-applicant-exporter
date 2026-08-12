// What the run actually did, in the order it did it. A failed run used to give
// the user one sentence and give us nothing, so this exists to answer exactly
// one question - where did this run stop? - without anyone reading source.
//
// It must stay safe to paste into a chat window with no redaction. No applicant
// names, no resume URLs, no CSV rows, no email addresses, ever. Job ids and user
// ids are fine: a user id is already in every filename. That property is worth
// more than any extra detail, so the whitelist below is the whole contract and
// anything not on it is dropped rather than trusted.

// A few hundred entries: long enough for a multi-role run's shape, short enough
// to scan and to keep beside a stored summary.
export const TRACE_CAP = 300;

// The only keys that may ever appear in a trace entry.
const FIELDS = [
  'jobId',
  // Which job a stale page claimed to be showing. The race, made visible.
  'seenJobId',
  'userId',
  'page',
  'count',
  'fresh',
  'attempts',
  // A page size, not a person.
  'pageSize',
  'ms',
  'outcome',
  'kind',
  // The review bucket a page came from - a Wellfound status name, not a person.
  'bucket',
  'error',
];

// Verbose console detail may carry these as well. Cursors are opaque Apollo
// strings and page sizes are numbers; neither names anybody.
const DETAIL_FIELDS = [...FIELDS, 'after', 'cursor', 'filterKeys'];

// A URL is the one shape that reliably smuggles identity into a message we did
// not write - a signed resume link, say, quoted inside a download error.
const URL_PATTERN = /\b(?:https?:|blob:|data:)\S*/g;
const MAX_TEXT = 200;

// Exported because the trace is not the only thing that keeps a message someone
// else wrote. A summary's `error` is stored to chrome.storage.local, and one of
// the messages that can reach it interpolates a signed resume link.
export function scrubUrls(text) {
  return String(text).replace(URL_PATTERN, '[url]');
}

function cleanValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubUrls(value).slice(0, MAX_TEXT);
  // Objects, arrays, functions: never. A field that needs a shape needs its own
  // named scalar first.
  return undefined;
}

function pick(fields, allowed) {
  const out = {};
  for (const key of allowed) {
    const value = fields?.[key];
    if (value === undefined || value === null) continue;
    const cleaned = cleanValue(value);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

// The variables a request actually carried, minus anything identifying. The
// filters a recruiter has applied can hold a typed search term, so only the
// names of the filter keys survive, never their values - except `status`, which
// is a bucket name and is already on screen.
export function scrubVariables(variables) {
  if (!variables || typeof variables !== 'object') return null;
  const out = {};
  if (variables.jobId != null) out.jobId = String(variables.jobId);
  // `first` on the wire, `pageSize` in every event this extension emits.
  if (typeof variables.first === 'number') out.pageSize = variables.first;
  if (variables.after != null) out.after = String(variables.after).slice(0, 40);
  const filters = variables.filters;
  if (filters && typeof filters === 'object') {
    out.filterKeys = Object.keys(filters).sort().join(',');
    if (typeof filters.status === 'string') out.bucket = filters.status;
  }
  return out;
}

// `+1234ms focus_ready jobId=9100001 attempts=3` - one line, scannable, and
// every value on it is one a user can paste anywhere.
export function formatEntry(entry) {
  const head = `+${String(entry.t).padStart(6, ' ')}ms ${entry.step}`;
  const rest = Object.entries(entry)
    .filter(([key]) => key !== 't' && key !== 'step')
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  return rest ? `${head} ${rest}` : head;
}

// `sink` is the verbose console mirror, absent unless the user has turned it on.
// It is handed the finished entry and the scrubbed extra detail, so even the
// verbose channel cannot see a field this module refused.
export function createTrace({ cap = TRACE_CAP, now = () => Date.now(), sink = null } = {}) {
  let entries = [];
  let startedAt = now();

  return {
    // Timestamps are relative to the start of the run, because "+42310ms" is
    // readable and an epoch is not.
    reset() {
      entries = [];
      startedAt = now();
    },
    record(step, fields = {}, detail = null) {
      const entry = { t: Math.max(0, Math.round(now() - startedAt)), step: String(step) };
      Object.assign(entry, pick(fields, FIELDS));
      entries.push(entry);
      if (entries.length > cap) entries.splice(0, entries.length - cap);
      if (sink) {
        try {
          sink(entry, detail ? pick(detail, DETAIL_FIELDS) : null);
        } catch {
          // A mirror that throws must not take the run with it.
        }
      }
      return entry;
    },
    // No `text()`: trace-view.js owns the rendering, and two implementations of
    // the same join is one that can drift.
    entries: () => entries.map((e) => ({ ...e })),
  };
}
