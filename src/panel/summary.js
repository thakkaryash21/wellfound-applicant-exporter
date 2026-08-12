import { breakdownText, DOT } from './running-view.js';
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

// The one accept outcome that needs the reader's hands. An unclear send is a
// message that may or may not have gone out: the pass stops rather than retry,
// because a retry is a second message to a real person, and nothing here can
// tell which happened. It is the only state in this whole panel that asks the
// operator to go and look at Wellfound before running again, so it is lifted
// out of the notes and rendered above the headline.
export function acceptAlert(jobs = []) {
  const unclear = jobs.filter((job) => job.acceptStoppedBecause === 'unclear');
  if (unclear.length === 0) return null;
  const names = listNames(unclear.map((job) => job.jobTitle));
  return (
    `${names}: an accept did not confirm, so that message may or may not have gone out. ` +
    'Nothing was retried. Check that role in Wellfound before running it again.'
  );
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

  // A preview counts nobody into `downloaded` by design, so without this a run
  // with downloads off over 400 applicants ended with "0 downloaded" and
  // nothing else.
  // Presence-checked, not just falsy-checked: an event carrying no actions at
  // all is one this run did not produce, and it must not be described as a
  // preview on the strength of a missing field.
  if (event.actions && !event.actions.download) {
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

  // The accept dimension, and every cause kept apart from every other: they
  // have different remedies, and one of them has none at all. Job titles and
  // counts only, so all of it is safe to store.
  if (event.actions?.accept) {
    const accepted = event.accepted ?? 0;
    headline = `${headline}${DOT}${accepted} accepted`;
    both(
      `${accepted} ${accepted === 1 ? 'person was' : 'people were'} accepted and messaged. ` +
        'That cannot be undone.',
    );
    if (accepted) {
      both(
        'They have left the review queue, so the applicant counts on the roles screen ' +
          'will be lower now, perhaps zero. They are not lost, and this extension can ' +
          'no longer fetch or re-download them.',
      );
    }
    if (event.acceptRefused) {
      both(
        `${event.acceptRefused} refused: no resume was captured for them, and accepting ` +
          'would have lost it for good. Download them first, then accept.',
      );
    }
    if (event.acceptAlready) {
      both(`${event.acceptAlready} were accepted on an earlier run, so nothing was sent again.`);
    }
    if (event.acceptFailed) {
      both(`${event.acceptFailed} could not be accepted. Nothing was sent to them.`);
    }
    // Held back, not merely absent. When a role's downloads failed five times
    // in a row the run declines to start sending irreversible messages through
    // Wellfound's UI, and that decision has to be said: an accepting run that
    // reports nothing accepted, with no reason given, reads as a role where
    // there was nobody to accept.
    const heldBack = jobs.filter((j) => j.acceptHeldBack).map((j) => j.jobTitle);
    if (heldBack.length) {
      both(
        `Nothing was accepted for ${listNames(heldBack)}: downloads kept failing, ` +
          'so no messages were sent. Nobody was accepted and nothing is lost. ' +
          'Run that role again once downloads are working.',
      );
    }

    for (const job of jobs.filter(
      (j) => j.acceptStoppedBecause === 'aborted' || j.acceptStoppedBecause === 'error',
    )) {
      both(
        `${job.jobTitle}: accepting stopped after ${job.accepted ?? 0} of ` +
          `${job.acceptIntended ?? 0}. The rest were not attempted.`,
      );
    }
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
    // Above the headline, not among the notes: it is the one outcome that needs
    // the operator to go and check Wellfound before doing anything else.
    alert: acceptAlert(jobs),
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
