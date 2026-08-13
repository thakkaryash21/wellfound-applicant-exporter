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
// What the run was ASKED to do, as the lines a report opens with.
//
// The operator asked for this directly, and it had already cost them: every
// diagnosis of a run began with them being asked which boxes they had ticked,
// because the report opened with results and a trace records effects. This is
// the record of intent, built from the configuration the run captured before
// its first request rather than inferred from what came out - so a run that
// died halfway still says what it was trying to do.
//
// The vocabulary is the panel's own. `mode` carries whatever runKind called the
// run - preview, live, accept, live+accept - and is not translated into
// report-only words here.
export function configLines(config) {
  if (!config) return [];
  const lines = ['What this run was asked to do', `Mode: ${config.mode}`];
  const roles = config.roles ?? [];
  for (const role of roles) {
    const name = role.jobTitle ?? role.jobId;
    // Unlimited in words. Infinity survives neither storage nor rendering, and
    // a blank reads as a number somebody forgot to write down.
    const limit = role.limit == null ? 'everyone new' : `first ${role.limit}`;
    const extra = role.forceFullWalk ? ', re-reading pages already downloaded' : '';
    lines.push(`Role: ${name} (${role.jobId}) - ${limit}${extra}`);
  }
  if (roles.length === 0) lines.push('Role: none selected');
  if (config.pageSize != null) lines.push(`Page size: ${config.pageSize}`);
  if (config.folder) lines.push(`Folder: ${config.folder}`);
  // Only when the run would actually send. The wording is editable per run, so
  // an accept run reported without it cannot be interpreted afterwards - the
  // one thing a reader wants to know about an irreversible message is what it
  // said.
  if (config.acceptMessage) {
    lines.push('Message sent to each accepted applicant:', config.acceptMessage);
  }
  return lines;
}

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
  const lines = [];
  // Counted from the per-role figure rather than from the stop reason. A role
  // can carry an unresolved send and still have finished everybody else, which
  // is the whole point of deferring them - so "did this role leave somebody
  // unresolved" and "did this role stop" are two different questions now.
  const unclear = jobs.filter((job) => (job.acceptUnresolved ?? 0) > 0);
  if (unclear.length) {
    const people = unclear.reduce((sum, job) => sum + job.acceptUnresolved, 0);
    lines.push(
      `${people} ${people === 1 ? 'accept' : 'accepts'} in ` +
        `${listNames(unclear.map((job) => job.jobTitle))} could not be confirmed, even after ` +
        'asking the review queue again at the end. The message may have gone out - this page ' +
        'has been seen sending one minutes after the click - and nothing was retried. They are ' +
        'held rather than counted either way, and the next run over that role will ask about ' +
        'them again. Check them in Wellfound if you would rather know now.',
    );
  }
  // The other hands-on state, and the more definite of the two: the message
  // certainly went out and the ledger - the only thing that stops the next run
  // sending a second one - does not know it did.
  const unrecorded = jobs.filter((job) => job.acceptStoppedBecause === 'unrecorded');
  if (unrecorded.length) {
    lines.push(
      `${listNames(unrecorded.map((job) => job.jobTitle))}: a message was sent that could not ` +
        'be recorded, so nothing here remembers it. Check that role in Wellfound before ' +
        'running it again, or that person will be messaged a second time.',
    );
  }
  return lines.length ? lines.join(' ') : null;
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
    // The two accept outcomes that stop the whole run. Without them a run that
    // halted at role one of three opened with a plain count and read as a
    // complete export.
    unclear: 'Stopped: an accept did not confirm',
    unrecorded: 'Stopped: a message was sent and could not be recorded',
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
    // The unclear send used to be counted into acceptFailed alongside every
    // other failure, and it is not like every other failure: "nothing was sent
    // to them" is exactly what nobody can say about it. The report printed that
    // sentence about the same person the alert above sends the operator to
    // Wellfound to check, so one of the two was always lying and the operator
    // learnt to discount whichever they read second.
    //
    // They are now their own count, all the way back from the pass, so this
    // note no longer has to subtract one number from another to work out which
    // of its people it may say that about.
    const certain = event.acceptFailed ?? 0;
    if (certain) {
      both(
        `${certain} could not be accepted. Nothing was sent to them, and they are still ` +
          'in the review queue, so running this role again will try them.',
      );
    }
    const unresolved = event.acceptUnresolved ?? 0;
    if (unresolved) {
      both(
        `${unresolved} ${unresolved === 1 ? 'accept' : 'accepts'} could not be confirmed, even ` +
          'after asking the review queue again at the end. The message may have gone out; ' +
          'nothing was retried. They are held, so nothing will message them again until a ' +
          'later run can settle it.',
      );
    }
    // Sent, and not written down. Kept apart from both of the above because the
    // remedy is different again: it is the only note here about a message this
    // extension knows went out and cannot prove to itself later.
    const unrecorded = jobs.filter((j) => j.acceptStoppedBecause === 'unrecorded');
    if (unrecorded.length) {
      both(
        `${unrecorded.length} ${unrecorded.length === 1 ? 'message' : 'messages'} went out and ` +
          'could not be recorded. The CSV for that role is the only record of it, and the run ' +
          'stopped there rather than sending more.',
      );
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
    // Before the outcome, because it is what the outcome is an outcome OF.
    // Carried both as the lines a report prints and as the object they were
    // built from, so a reader gets prose and a later question gets the fields.
    config: event.config ?? null,
    configLines: configLines(event.config),
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
