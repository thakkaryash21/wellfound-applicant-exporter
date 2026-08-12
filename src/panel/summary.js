import { breakdownText } from './running-view.js';
import { scrubUrls } from '../lib/trace.js';
import { PREVIEW } from '../lib/csv.js';

// The account a run gives of itself once it is over: a function of the `done`
// event and nothing else.
//
// What it hides is the whole question of what a run is allowed to claim. Every
// way a run can end short - a limit, an early stop, a role that wrote no file,
// a fatal error at job three of four - has to reach the reader, and the one
// thing this must never do is read better than what happened. It also draws the
// line between what is shown and what is stored: `notes` names who failed
// because that is how the user knows whom to chase, `safeNotes` counts them
// instead, and only the second is ever written to disk.

// The running screen and this summary used to count the same run in two
// vocabularies: "38 downloaded - 4 skipped" for twelve minutes, then "38
// downloaded - 2 with no resume - 2 not identifiable" at the end, leaving the
// user to work out these were the same four people. One taxonomy now - the
// running screen's - and the causes appear as a note under it, where the remedy
// is anyway.
export function countsFromEvent(event) {
  return {
    downloaded: event.downloaded ?? 0,
    failed: event.failed ?? 0,
    // The running screen's `skipped` outcome is "no resume on file".
    skipped: event.skippedNoResume ?? 0,
    'no-id': event.skippedNoId ?? 0,
    masked: event.masked ?? 0,
    [PREVIEW]: event.previewed ?? 0,
  };
}

export function listNames(names, cap = 5) {
  const shown = names.slice(0, cap).join(', ');
  return names.length > cap ? `${shown} and ${names.length - cap} more` : shown;
}

// Which causes made up the one "skipped" number on the headline. Only the ones
// that happened, and only when something was skipped at all.
function skippedNote(counts) {
  const parts = [];
  if (counts.skipped) parts.push(`${counts.skipped} with no resume`);
  if (counts['no-id']) parts.push(`${counts['no-id']} not identifiable`);
  if (counts.masked) parts.push(`${counts.masked} locked`);
  const total = counts.skipped + counts['no-id'] + counts.masked;
  if (total === 0) return null;
  return `The ${total} skipped: ${parts.join(', ')}.`;
}

// Everything the run knows, said out loud. Nothing here may read better than
// what happened: a truncated run says it was truncated, and names the remedy.
//
// `trace` is passed in rather than reached for, so this stays a function of its
// arguments.
export function summarize(event, trace = []) {
  const counts = countsFromEvent(event);
  let headline = breakdownText(counts);

  const prefix = {
    aborted: 'Stopped by you',
    failing: 'Stopped: downloads kept failing',
    error: 'The run did not finish',
  }[event.stoppedBecause];
  if (prefix) headline = `${prefix} \u00b7 ${headline}`;

  // Two lists, same order. `notes` names who failed, because naming them on
  // screen is the point; `safeNotes` is the same account with no person in it,
  // and it is the only one that is ever written to storage.
  const notes = [];
  const safeNotes = [];
  const both = (text) => {
    notes.push(text);
    safeNotes.push(text);
  };

  // A preview counts nobody into `downloaded` by design, so without this a dry
  // run over 400 applicants ended with "0 downloaded" and nothing else.
  if (event.dryRun) {
    const previewed = counts[PREVIEW];
    both(
      `Preview only: nothing was downloaded. ` +
        `Untick "Preview only" and run again to fetch ${previewed === 1 ? 'this resume' : `these ${previewed} resumes`}.`,
    );
  }

  const jobs = event.jobs ?? [];

  // The limit is per role now, so the note names each role with the number that
  // role was asked for rather than one run-wide figure that no longer exists.
  for (const job of jobs.filter((j) => j.stoppedBecause === 'limit')) {
    both(`${job.jobTitle}: got the first ${job.limit} you asked for. Run again for the rest.`);
  }

  // Only worth naming when it produced nothing: that is the case the user reads
  // as "no new applicants" when in truth pages were never opened.
  const quietEarly = jobs.filter((j) => j.stoppedBecause === 'early-stop' && !j.downloaded);
  for (const job of quietEarly) {
    both(
      `${job.jobTitle}: stopped early after ${job.pages} already-downloaded pages. ` +
        'Open that role and tick "Re-read pages I have already downloaded" ' +
        'to read the whole list.',
    );
  }

  // A role that exported nothing wrote no CSV, and used to say so only in the
  // live region - overwritten by the next event within seconds, then replaced
  // wholesale by this screen. Two roles selected, one with nothing new, and the
  // summary read "38 downloaded" while the user hunted for a second file that
  // was never written. Job titles, not people, so it is safe to store.
  const noFile = jobs.filter((j) => j.wroteCsv === false).map((j) => j.jobTitle);
  if (noFile.length) {
    both(
      `No CSV for ${listNames(noFile)}: ` +
        `${noFile.length === 1 ? 'that role had' : 'those roles had'} no applicants to export.`,
    );
  }

  const causes = skippedNote(counts);
  if (causes) both(causes);

  if (counts.masked) {
    both(`${counts.masked} locked. Unlock them in Wellfound and run again.`);
  }

  // The one note that carries real people. On screen it names them, because
  // that is how the user knows who to chase. Stored, it counts them: this object
  // lives in chrome.storage.local until the next run overwrites it, and a
  // candidate's name has no business surviving there.
  if (event.failedNames?.length) {
    const n = event.failedNames.length;
    notes.push(
      `Could not download: ${listNames(event.failedNames)}. They will be retried on the next run.`,
    );
    safeNotes.push(
      `Could not download ${n} ${n === 1 ? 'applicant' : 'applicants'}. ` +
        'They will be retried on the next run.',
    );
  }

  // Job titles, not people.
  if (event.notWalked?.length) {
    both(`Never started: ${listNames(event.notWalked)}.`);
  }

  return {
    at: new Date().toISOString(),
    headline,
    notes,
    safeNotes,
    // A URL is the one shape that reliably smuggles identity into a message
    // this code did not write: "Resume link is not a full URL: <signed link>"
    // is a real thrown message, and this object is written to
    // chrome.storage.local. Scrubbed on the way in, like the trace's own
    // fields, so what is not written cannot leak.
    error: event.error == null ? null : scrubUrls(event.error),
    // Stored with the summary, so the account of a run that went wrong survives
    // the panel being closed. Already capped by the trace itself.
    trace,
  };
}

// What may be written to disk. The trace is already name-free by construction;
// the notes are not, so the stored copy takes the count-only versions and the
// naming ones are dropped rather than carried alongside.
export function storableSummary(summary) {
  if (!summary) return summary;
  const { safeNotes, ...rest } = summary;
  return { ...rest, notes: safeNotes ?? summary.notes ?? [] };
}
