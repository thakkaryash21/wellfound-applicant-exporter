// Every date and time this extension shows a user - on screen, in a filename, or
// inside a file it writes - is in the user's own timezone. There is no case here
// where UTC serves the reader: these are a recruiter's own files about their own
// working day.
//
// This module exists because that rule was broken in three places at once and in
// three different ways. A run at 19:23 on 11 August wrote a report named
// `run-2026-08-11-192355` (local), CSVs named `applicants-<jobId>-2026-08-12`
// (UTC) and a header reading `Run at: 2026-08-12T02:23:55.586Z` (UTC) - two of
// the user's own files claiming a day that had not started where they sat. One
// owner for the shape, so the three cannot drift apart again.
//
// The date keeps its sortable `YYYY-MM-DD` form. Only the timezone changed.

const pad = (n) => String(n).padStart(2, '0');

// A Date, whatever was passed. An unparseable value is treated as "now" rather
// than as a reason to write `NaN-NaN-NaN` into a filename.
function asDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function localDateStamp(value = new Date()) {
  const d = asDate(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// No separators: this is a filename component, and a colon is reserved on
// Windows.
export function localClockStamp(value = new Date()) {
  const d = asDate(value);
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// For prose inside a file. Still sortable, so a folder of reports reads in
// order, but with the separators a person expects rather than an ISO `T` and a
// `Z` that says the wrong day.
export function localDateTimeText(value = new Date()) {
  const d = asDate(value);
  return `${localDateStamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
