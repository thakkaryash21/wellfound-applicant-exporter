import { ACCEPT_STATUS, RESUME_STATUS, acceptFailure } from '../lib/csv.js';
import { composeMessage } from '../lib/accept-message.js';
import { CX } from '../lib/messages.js';
import { PACING, sample, sampleInt } from '../lib/jitter.js';
import { localDateTimeText } from '../lib/local-time.js';

// The second pass over a job: the reviewer walk that accepts the people the
// first pass captured.
//
// It is a separate pass, not a branch inside runJob, for one measured reason:
// accepting removes a candidate from the NEEDS_REVIEW collection the API walk
// paginates with a cursor. Accepting mid-walk mutates the very collection the
// cursor points into, and the walk then returns fewer people and reports
// success - people silently skipped, with no error anywhere. So pass 1 runs to
// completion first, and only then does this run.
//
// Everything here decides and books; the DOM belongs to src/content/reviewer.js
// and the wording to src/lib/accept-message.js. This module never composes a
// selector, never retries a send, and never accepts anybody whose resume this
// extension does not already have on disk.

// The two Resume outcomes that mean "we have their file": fetched by this run,
// or fetched by an earlier one. Anything else - no resume, locked, previewed,
// failed, never reached - means accepting them would forfeit their resume
// forever, because an accepted candidate leaves NEEDS_REVIEW and no query this
// extension has can ever reach them again.
const CAPTURED = new Set([RESUME_STATUS.DOWNLOADED, RESUME_STATUS.ALREADY]);

// The one status that is neither a capture nor a refusal. A person with two
// applications has two rows; the walk spends one download and the other row
// says only "the outcome is on the other row". Read as a capture it would
// launder a failed download into an accept, which is the loss this whole
// module exists to prevent. Read as a refusal it would block a person whose
// download plainly succeeded. It is a pointer, so it is neither.
const POINTER = RESUME_STATUS.ANOTHER_ROW;

// The panel's half of the driver's one classification. src/content/reviewer.js
// appends this phrase to every refusal it raises BEFORE the send is clicked,
// and to nothing else; a test asserts the driver's own copy of it is this exact
// string. The two live apart because the driver is a MAIN-world classic script
// with no imports, the same reason the message types are duplicated into it.
export const NOTHING_SENT = 'nothing was sent';

// Leave the page as this pass found it: no reviewer modal, and above all no
// composer sitting there with the operator's message typed into it, one click
// from a stranger's inbox. src/content/reviewer.js does the clicking - `Cancel
// response`, then `Exit` - and never throws doing it.
//
// It is its own message rather than a second duty on CX_STOP_REVIEWER because
// stopping and leaving are two different moments: a stop arrives DURING an
// accept and must touch nothing, and most teardowns follow no stop at all.
//
// Re-exported so this pass's own tests and callers can keep naming it here,
// while the name itself lives with its siblings in messages.js. bridge.js
// carries the same literal in its table, exactly as the other message types are
// duplicated into it, and a test asserts the two agree.
export const CX_CLOSE_REVIEWER = CX.CLOSE_REVIEWER;

// Which of the two a failed accept was. Only certainty is recognised: an error
// this extension did not write - a relay timeout, anything unforeseen - carries
// no phrase and is read as unclear, because an outcome nobody can vouch for is
// exactly what `unclear` means.
//
// `unclear` is the one word in this panel that sends the operator to Wellfound
// to check whether a stranger got a message. Spending it on a composer that was
// slow to render teaches them to ignore it on the run where it is real.
//
// The certain half is `error`, which is not a new word: it is already what this
// pass reports when opening the reviewer, reading a position or skipping fails
// - the same concept, "the pass stopped and nothing went out", and the summary
// already says so in those words. One term, one meaning.
export function sendOutcome(reason) {
  return String(reason).includes(NOTHING_SENT) ? 'error' : 'unclear';
}

// What the operator is told about a send the queue could not settle.
//
// The two outcomes are not the same and used to read the same. A queue that
// still showed the candidate after a minute of looking is EVIDENCE, and the
// operator can act on it; a queue that could not be read is the absence of
// evidence and leaves them exactly where they were. Saying so is not
// overclaiming as long as the sentence also says what is not known - which it
// does, in the same breath, because the queue cannot prove a message was never
// composed and sent.
//
// The driver's own sentence is kept in front, verbatim: it is the account of
// what happened at the click, and this only adds what was learnt afterwards.
// Nothing appended may ever read as the driver's certainty phrase - `unclear`
// is decided from the ORIGINAL reason, and a test asserts these sentences do
// not disturb that.
export function unresolvedReason(reason, { verdict, looks = 0, waitedMs = 0 } = {}) {
  if (verdict === 'queued') {
    const seconds = Math.round(waitedMs / 1000);
    return (
      `${reason} Checked the review queue ${looks} times over the following ` +
      `${seconds}s and they were still in it every time, which leans towards the message ` +
      'never leaving - but a queue cannot prove that, so they are recorded as neither ' +
      'accepted nor safe to try again.'
    );
  }
  if (verdict === 'unknown') {
    return `${reason} The review queue could not be read afterwards, so nothing was learnt.`;
  }
  return reason;
}

// THE INTERLOCK, as a function rather than as three lines buried in a closure,
// for one reason: a rule that cannot be broken in a test is defended by nothing.
// It is called on the one path that destroys the page context, and its whole
// job is to refuse when this pass does not yet durably know what happened to a
// real person.
//
// A reload inside that window destroys the only witness a send has, and the
// queue cannot recover it - a send can land after we stop looking, which this
// project has measured rather than supposed. So this throws, and the throw
// leaves the walk through the handler a failed open or a failed read does: the
// pass stops and says so.
export function guardReload(unresolvedSend) {
  if (unresolvedSend === null || unresolvedSend === undefined) return;
  throw new Error(
    `Refusing to reload the page with the accept for ${unresolvedSend} still unresolved`,
  );
}

// What the operator is told when a message demonstrably went out and the ledger
// refused to remember it. It is neither `error` - which promises nothing went
// out - nor `unclear`, which is about the click. The send is a fact; the record
// of it is what failed.
//
// The ledger is the single thing standing between this person and a second
// message from the next run, so this sentence has to send the operator to the
// one place that can prevent it.
export function unrecordedReason(userId, reason) {
  return (
    `The message to ${userId} was sent, and writing it to the ledger failed: ${reason} ` +
    'The send cannot be undone and nothing was retried. This run stopped there. ' +
    'Before running this role again, check that person in Wellfound: nothing here ' +
    'remembers they were messaged, so another run could message them a second time.'
  );
}

// `[first_name]` is a greeting, not an identity: splitting `name` on
// whitespace is a guess, wrong for a title, a mononym, or family-name-first
// order. It exists only as a fallback for the rare record where Wellfound's
// own `firstName` field is missing. An empty result is fine - composeMessage
// drops the name and keeps the comma rather than skipping the candidate.
export function firstNameOf(name) {
  return String(name ?? '').trim().split(/\s+/)[0] ?? '';
}

// Preference order: the field Wellfound sends, then the first word of the
// display name, then nothing. Never the reverse - a split guess must never
// override the real field, because the real field is what the candidate
// actually typed as their first name.
export function resolveFirstName(record) {
  const real = String(record?.firstName ?? '').trim();
  if (real) return real;
  return firstNameOf(record?.name);
}

// Who this pass will try, who it refuses and why - decided before a single
// keystroke, from the rows pass 1 built. Every row gets an Accept cell here, so
// no row can reach the CSV with a blank one and leave the reader guessing
// whether it was refused, missed, or never attempted.
//
// `limit` is the role's own number - the one the operator typed beside it on
// Home - and here it means exactly one thing: at most this many people are
// MESSAGED from this role. It is the same number pass 1 reads as "take at most
// N new downloads from this role", and the two readings can diverge: a
// download-and-accept run over a role that has been walked before may download
// three new people and message three others who were already on disk. The
// reading chosen is the one that cannot surprise: whatever else a run does,
// somebody who typed 3 gets at most three messages sent under their name.
//
// It bounds the people messaged and nothing else. A refusal is not a message
// and an already-accepted person is not a message, so neither spends the
// number; counting them would let a role with three refusals send nothing and
// still report the limit as honoured, which is the surprise in the other
// direction.
//
// Everyone over the number keeps NOT_REACHED - already the word for "the run
// was accepting and stopped (a limit, an abort) before reaching this
// candidate", which is precisely what happened to them.
export function planAccepts({ records = [], alreadyAccepted = [], limit = Infinity } = {}) {
  const already = new Set(alreadyAccepted.map(String));
  // Grouped before anything is decided, because the decision is about a PERSON
  // and the evidence is spread across their rows. Deciding row by row let one
  // person be refused on the row whose download failed and accepted on the
  // row that merely pointed at it - the same person, both cells in the CSV,
  // and a resume lost for good.
  const rowsById = new Map();
  // Rows with no userId at all, kept apart: nobody without an id can be
  // accepted, since the interlock in the reviewer matches on the id and there
  // is no name-based fallback anywhere.
  const anonymous = [];
  for (const record of records) {
    const userId = record.userId == null ? null : String(record.userId);
    if (!userId) {
      anonymous.push(record);
      continue;
    }
    if (rowsById.has(userId)) rowsById.get(userId).push(record);
    else rowsById.set(userId, [record]);
  }

  const targets = [];
  let refusedNoResume = 0;
  let alreadyCount = 0;

  const refuse = (rows) => {
    for (const row of rows) row.acceptStatus = ACCEPT_STATUS.NO_RESUME;
    refusedNoResume += rows.length;
  };

  refuse(anonymous);

  for (const [userId, rows] of rowsById) {
    // Both halves are load-bearing and neither implies the other. `some`
    // rules out a person whose every row is a pointer or a refusal; `every`
    // rules out the person one of whose rows records a failure or a refusal,
    // whatever their other rows say. A run holds their resume only if a row
    // says so and no row says otherwise.
    const captured =
      rows.some((row) => CAPTURED.has(row.resumeStatus)) &&
      rows.every((row) => CAPTURED.has(row.resumeStatus) || row.resumeStatus === POINTER);
    if (!captured) {
      refuse(rows);
      continue;
    }
    if (already.has(userId)) {
      for (const row of rows) row.acceptStatus = ACCEPT_STATUS.ALREADY;
      alreadyCount += rows.length;
      continue;
    }
    targets.push(userId);
    // Held until the walk reaches them. A pass that stops early leaves this
    // word in the cell, which is the honest one.
    for (const row of rows) row.acceptStatus = ACCEPT_STATUS.NOT_REACHED;
  }

  // Cut here, last, once every row has its cell. Order is the order pass 1
  // handed the records over - Wellfound's own queue order, the order the API
  // paginated them in - carried through `records`, then through this Map's
  // insertion order, and out to `targets` unchanged. It is deliberately not
  // whatever order a Map or an object happens to yield for a set of ids: the
  // people a capped run takes are the ones at the front of the queue, which is
  // also where the reviewer starts, so a small run skips past nobody.
  //
  // `Infinity` is the unlimited case and slices nothing: a role set to
  // "everyone" still accepts everyone.
  const capped = Number.isFinite(limit) ? targets.slice(0, Math.max(0, limit)) : targets;

  return { targets: capped, rowsById, refusedNoResume, alreadyAccepted: alreadyCount };
}

// How many times one pass will fall back to the API to settle an unconfirmed
// send. The check pages the whole NEEDS_REVIEW collection for the job, so it is
// far and away the most expensive thing this pass can do, and it must never
// become something a pass does per candidate. One is enough for the failure
// that was actually observed - a single accept whose confirmation never
// arrived - and a pass that produces a second one is a pass whose page state is
// beyond what this module can reason about, which is exactly what `unclear` is
// for.
const QUEUE_CHECKS_PER_PASS = 1;

// How long the queue is given to settle before "still there" is believed, as
// the waits BETWEEN successive looks. The first look happens immediately.
//
// Measured, on a real run: a send whose confirmation never arrived was checked
// once, found the candidate still queued, and stopped - and the message had in
// fact gone out. The check began 2.4 s after the failure and finished 11.7 s
// after it, and the send still had not landed by then.
//
// So the polarity of the evidence is not symmetric, and that is the whole
// lesson. ABSENT means it landed; there is nothing else that removes somebody
// from this collection in the seconds concerned. PRESENT means it has not
// landed YET, which is a statement about the moment of the look and not about
// the send. Only presence held across a settled interval is evidence about the
// send itself.
//
// 5 s, then 15 s, then 30 s: four looks in all, the last beginning at least
// 50 s of deliberate waiting after the failure, plus the walks themselves.
// Chosen against the one hard bound available rather than against a feeling:
// the failure being settled is the relay giving up at 45 s, so by the time it
// is raised nothing further can be in flight from this extension's side, and
// what remains is Wellfound finishing a request it already has. 50 s past that
// is more than four times the 11.7 s that concluded too early. The growth is
// geometric so that the common case - it landed a moment later - costs the
// operator five seconds, and only the genuinely stuck case spends the minute.
//
// The alternative to waiting is not "the operator gets on with their day": it
// is a halted run and a trip to Wellfound to check a stranger's inbox by hand.
// A minute is cheap against that, and it is spent at most once in a pass.
const QUEUE_SETTLE_WAITS_MS = [5000, 15000, 30000];

// One accept taking this long is the page asking to be reloaded.
//
// The counted cadence in PACING is a backstop and cannot be the whole trigger,
// because how fast the page degrades scales with how much of the list it is
// holding. Both measured:
//
//   20 applicants:   5-9 s an accept, steady, reloads at 7, 13, 18, finished
//   111 applicants:  8.3 s, 7.1 s, 35.9 s, then 47 s and the relay gave up
//
// The second run died on its fourth accept, so a cadence of five to seven never
// fired once - the mechanism that makes long passes work was never reached. No
// count protects both roles: small enough for 111 is wasteful on 20. But the
// pass already holds the one number that means the same thing on any size of
// role, which is how long the last accept took.
//
// 20 s, and every part of that is a measurement. The healthy band is 5-9 s and
// the two pauses this pass hands the driver account for up to 8 s of it, so an
// accept reaching 20 s spent at least 12 s inside the page against a healthy
// two or three - it is not ordinary variation, and there is more than a
// doubling of the healthy ceiling between the two. The relay's budget is 45 s,
// so 20 s leaves 25 s of headroom: the reload happens a whole accept before an
// accept could fail. The 35.9 s accept that preceded the failure trips it
// comfortably; nothing in either healthy run comes close.
//
// Wrong in the cheap direction if it is wrong at all: the cost of firing early
// is a page load, and the cost of firing late is a stalled run.
const SLOW_ACCEPT_MS = 20000;

// `review` is one call into the reviewer driver, `recordAccepted` is the
// ledger write, and both are injected for the same reason the download walk
// injects its own: this loop is the part worth testing, and neither a real tab
// nor a real message may be involved in testing it.
//
// `checkQueue` is the third, and it is the only one that is optional: a caller
// that cannot ask the API gets exactly the behaviour this pass had before it
// existed. It answers 'gone', 'queued' or 'unknown' for one userId, and it is
// never given the chance to answer anything about a send that was refused
// before the click.
//
// `reloadPage` is the fourth and is optional for the same reason: it reloads
// the working tab and does not return until the page can answer for this job
// again. The pass owns WHEN a reload happens; it owns nothing about how, which
// is the run controller's business because the tab is.
export async function runAcceptPass(deps, options) {
  const { review, recordAccepted, sleep, emit, checkQueue, reloadPage } = deps;
  const rand = deps.rand ?? Math.random;
  // The clock, injected for the same reason  is: a test that has to make
  // an accept take thirty-six seconds must not take thirty-six seconds.
  const now = deps.now ?? (() => Date.now());
  const {
    jobId,
    jobTitle,
    records = [],
    alreadyAccepted = [],
    template,
    signal,
    // The role's own number. Absent means unbounded, which is what a caller
    // that has no opinion should get - but the run controller always has one,
    // because every role on Home always carries either a number or Infinity.
    limit = Infinity,
  } = options;

  const plan = planAccepts({ records, alreadyAccepted, limit });
  const intended = plan.targets.length;
  const remaining = new Set(plan.targets);
  const totals = {
    accepted: 0,
    refusedNoResume: plan.refusedNoResume,
    alreadyAccepted: plan.alreadyAccepted,
    skipped: 0,
    failed: 0,
  };
  let stoppedBecause = 'finished';
  let error;

  // Progress is reported against `intended`, never against the reviewer's own
  // total: that total SHRINKS with every accept, so a percentage of it would
  // run backwards and forwards at once.
  emit({
    type: 'accept_started',
    jobId,
    jobTitle,
    intended,
    refusedNoResume: totals.refusedNoResume,
    alreadyAccepted: totals.alreadyAccepted,
  });

  const emitCandidate = (userId, outcome, extra = {}) =>
    emit({
      type: 'accept_candidate',
      jobId,
      userId,
      outcome,
      accepted: totals.accepted,
      intended,
      ...extra,
    });

  const mark = (userId, status, acceptedAt) => {
    for (const row of plan.rowsById.get(userId) ?? []) {
      row.acceptStatus = status;
      if (acceptedAt !== undefined) row.acceptedAt = acceptedAt;
    }
  };

  // The same reading-break model the download walk paces itself with, and
  // deliberately the same constants: reading a profile before deciding is what
  // a human does here anyway, so this rhythm needs no new numbers.
  let sinceBreak = 0;
  let breakAt = sampleInt(PACING.breakEvery, rand);
  async function pace() {
    sinceBreak += 1;
    if (sinceBreak >= breakAt) {
      const ms = sample(PACING.breakMs[0], PACING.breakMs[1], rand);
      emit({ type: 'break', jobId, ms });
      await sleep(ms, signal);
      sinceBreak = 0;
      breakAt = sampleInt(PACING.breakEvery, rand);
    } else {
      const ms = sample(PACING.downloadMs[0], PACING.downloadMs[1], rand);
      emit({ type: 'resting', jobId, ms });
      await sleep(ms, signal);
    }
  }

  // An accept spends most of its time paused inside the page, where the run's
  // AbortSignal cannot reach: signals do not cross into a content script. So a
  // stop is forwarded as its own message. It is very likely to arrive while an
  // accept is mid-pause, which is exactly the case it exists for - the pause
  // ends there and then, and no send follows it. Its failure is ignored: a tab
  // that has gone away cannot send anything either.
  const forwardStop = () => {
    Promise.resolve(review({ type: CX.STOP_REVIEWER })).catch(() => {});
  };
  signal?.addEventListener('abort', forwardStop, { once: true });

  // Set immediately BEFORE the reviewer is opened, not after it answers: an
  // open that fails part-way - the modal up but at the wrong position - is
  // exactly the case that leaves something behind to close.
  let touchedReviewer = false;

  const finish = async () => {
    // Every exit from this pass runs through here, including the two that
    // return rather than throw, which is why the teardown lives in it. Its own
    // failure is swallowed: this pass may already be carrying the error the
    // operator needs to read, and a teardown that threw over it would replace a
    // message about a candidate with a message about a button.
    if (touchedReviewer) {
      try {
        await review({ type: CX_CLOSE_REVIEWER });
      } catch {
        // Nothing to say and nowhere useful to say it. A tab that has gone away
        // has no composer left open on it either.
      }
    }
    signal?.removeEventListener('abort', forwardStop);
    emit({
      type: 'accept_done',
      jobId,
      jobTitle,
      intended,
      ...totals,
      stoppedBecause,
      ...(error === undefined ? {} : { error }),
    });
    return { intended, ...totals, stoppedBecause, ...(error === undefined ? {} : { error }) };
  };

  // Nobody to accept is not a failure and is not a reason to open the reviewer
  // at all: an accept-only run over a job whose resumes were never captured
  // must touch Wellfound's UI not once.
  if (intended === 0) return finish();
  if (signal?.aborted) {
    stoppedBecause = 'aborted';
    return finish();
  }

  // The refresh cycle. One mechanism, one counter, one call site.
  //
  // There were briefly two - a cheap reopen of the modal every couple of
  // accepts, and a reload of the page underneath it less often. The reload does
  // everything the reopen did and more: it discards the modal as a side effect
  // of discarding the document, and the pass reopens and re-reads position
  // afterwards either way. Two cycles at different scales, both claiming to be
  // why the page is fresh, is a thing no reader could reason about later - so
  // the cheap one is gone rather than nested underneath.
  //
  // `refreshAt` is redrawn every cycle from PACING.reloadEvery, exactly as the
  // reading break redraws `breakEvery`: a refresh that arrived on every sixth
  // accept without fail would be a rhythm nothing human produces, and the
  // bounds live in PACING with the rest of the timing rather than here.
  let acceptsSinceRefresh = 0;
  let refreshAt = sampleInt(PACING.reloadEvery, rand);
  let refreshPending = false;
  let queueChecksLeft = QUEUE_CHECKS_PER_PASS;

  // The state guardReload above reads. Holds a userId from the moment before
  // the send is clicked until the moment after that accept has been written to
  // the ledger - the whole of the window in which this pass does not yet
  // durably know what happened to a real person.
  let unresolvedSend = null;

  // Who this pass has already walked past, by identity rather than by visit.
  //
  // A reload lands the reviewer back at position 1, so every skipped person is
  // read again on the way back to the front of the queue. That used to disable
  // the whole refresh cycle: `skipped` was a count of visits, and re-walking
  // them counted the same people twice. The count was defended and the
  // mechanism that keeps a long pass alive was switched off - on the owner's
  // primary workflow, where an accept-only run over a whole role refuses
  // anybody whose resume was never captured and therefore skips somebody within
  // the first few positions.
  //
  // Counting per person makes the re-walk harmless, so nothing has to be
  // switched off. Re-encountering somebody this pass has already passed over is
  // recognised, not prevented.
  const skippedIds = new Set();

  // Let go of the page and take hold of it again.
  //
  // The composer is closed first even though the load discards it anyway: the
  // promise that this pass never leaves the operator's message sitting in a box
  // holds at every instant, not only at the convenient ones.
  //
  // `reloadPage` does not return until the page can answer for THIS job again.
  // That is the run controller's business and it reuses the readiness probe
  // every navigation in this extension already goes through - the one that
  // answers which jobId is live, because a stale document mid-navigation
  // answers a bare "are you there?" perfectly well and takes the run down with
  // it. A caller that cannot reload still gets the close and the open, which is
  // strictly less but costs nothing and keeps the cadence honest.
  //
  // A reload that does not come back throws, and the throw leaves this loop
  // through the same handler a failed open or a failed read does: the pass
  // stops, says so in the panel's own words, and the ledger is already correct
  // because nothing gets here with an accept outstanding.
  //
  // It reads nothing back and assumes nothing about who is on screen. The
  // loop's next act is READ_CANDIDATE, which is the only thing that decides
  // that, so a refresh cannot step over anybody.
  const refresh = async () => {
    guardReload(unresolvedSend);
    emit({
      type: reloadPage ? 'accept_reload' : 'accept_reopen',
      jobId,
      accepted: totals.accepted,
      intended,
    });
    await review({ type: CX_CLOSE_REVIEWER });
    if (reloadPage) await reloadPage();
    // A beat before the click, because a person who reloads a slow page looks
    // at it before doing anything else.
    await pace();
    await review({ type: CX.OPEN_REVIEWER });
    acceptsSinceRefresh = 0;
    refreshAt = sampleInt(PACING.reloadEvery, rand);
    refreshPending = false;
  };

  // Called from exactly one place: the top of the loop, before READ_CANDIDATE
  // has even chosen who the next candidate is. That is what makes a refresh
  // mid-accept unrepresentable rather than merely avoided - and the interlock
  // above is what keeps it unrepresentable after somebody edits this file.
  //
  // A refresh cannot loop and cannot lose anybody. Every refresh is asked for
  // by an accept - the counted cadence counts accepts, and both immediate
  // triggers follow one - so the queue has strictly shrunk since the last one,
  // and a skip never asks for anything. What a refresh costs is re-walking the
  // people already skipped, which is a handful of reads and the pace between
  // them; what it cannot do is accept anybody twice, because `remaining` no
  // longer holds anyone this pass has messaged and the ledger holds them all.
  const refreshIfDue = async () => {
    if (!refreshPending && acceptsSinceRefresh < refreshAt) return;
    await refresh();
  };

  // Booking a confirmed accept: the ledger first, then everything in memory.
  //
  // The order is the second interlock and it is not a convention: at the moment
  // recordAccepted is called this person's row still reads NOT_REACHED and they
  // are still in `remaining`, so nothing can advance past an accept that is not
  // yet written down. A test asserts that state from inside the ledger write.
  //
  // A confirmed send is a fact, and nothing that happens afterwards may retract
  // it. So the write has its own catch, and its failure is NOT the walk's
  // failure: reporting it as `error` - this pass's word for "the pass stopped
  // and nothing went out" - told the operator the opposite of what happened,
  // left the CSV saying `not attempted`, and left the next run free to message
  // that person a second time.
  //
  // Returns whether the pass may carry on, and on a failed write it may not.
  // The ledger is the only thing standing between these people and a second
  // message, so a ledger that has stopped working turns every further accept
  // into another unrecorded message. One is a person to check by hand; a
  // hundred is not recoverable. It stops on the first.
  const bookAccept = async (userId, extra = {}) => {
    let recorded = true;
    let reason = null;
    try {
      await recordAccepted(jobId, userId);
    } catch (ledgerError) {
      recorded = false;
      reason = String(ledgerError.message || ledgerError);
    }
    // Booked either way, because either way the message went out. When the
    // ledger refused it, the CSV row is the only surviving record of the send,
    // so it says accepted and says when.
    unresolvedSend = null;
    remaining.delete(userId);
    mark(userId, ACCEPT_STATUS.ACCEPTED, localDateTimeText());
    totals.accepted += 1;
    emitCandidate(userId, 'accepted', { ...extra, ...(recorded ? {} : { recorded: false }) });
    if (recorded) return true;
    stoppedBecause = 'unrecorded';
    error = unrecordedReason(userId, reason);
    emit({ type: 'accept_unrecorded', jobId, userId, error });
    return false;
  };

  try {
    touchedReviewer = true;
    await review({ type: CX.OPEN_REVIEWER });

    while (remaining.size > 0) {
      if (signal?.aborted) {
        stoppedBecause = 'aborted';
        break;
      }

      await refreshIfDue();

      const at = await review({ type: CX.READ_CANDIDATE });
      const userId = at?.userId == null ? '' : String(at.userId);
      emit({
        type: 'accept_considering',
        jobId,
        userId,
        index: at?.index ?? null,
        total: at?.total ?? null,
        accepted: totals.accepted,
        intended,
      });

      if (!remaining.has(userId)) {
        // The only path that navigates. A skip advances the index and leaves
        // the bucket alone, which is why it is safe here and catastrophic
        // after an accept.
        await review({ type: CX.SKIP_CANDIDATE });
        // Counted by person, not by visit: a reload returns the reviewer to
        // position 1, so these same people are walked past again on the way
        // back to the front, and a pass that skipped four must not report
        // twelve because it reloaded twice.
        const seenBefore = skippedIds.has(userId);
        skippedIds.add(userId);
        totals.skipped = skippedIds.size;
        // Said once per person, for the same reason. The trace and the panel
        // both read these, and a second sentence about the same skip is noise
        // that reads as a second person.
        if (!seenBefore) emitCandidate(userId, 'skipped');
        await pace();
        continue;
      }

      let message;
      try {
        message = composeMessage({
          template,
          firstName: resolveFirstName(plan.rowsById.get(userId)?.[0]),
          roleName: jobTitle,
        });
      } catch (composeError) {
        // A message that would go out with a literal token in it is not sent,
        // and this candidate is not accepted. The pass carries on past them:
        // the fault is in the wording, not in the page, and skipping is the
        // one navigation that costs nobody anything.
        const reason = String(composeError.message || composeError);
        remaining.delete(userId);
        mark(userId, acceptFailure(reason));
        totals.failed += 1;
        emitCandidate(userId, 'failed', { error: reason });
        await review({ type: CX.SKIP_CANDIDATE });
        await pace();
        continue;
      }

      // The interlock closes HERE, before the click, and opens again only once
      // this person is in the ledger. Everything in between is the window where
      // a real message may exist that nothing durable knows about, and no
      // reload may happen inside it.
      unresolvedSend = userId;
      const sendStartedAt = now();
      try {
        await review({
          type: CX.ACCEPT_CANDIDATE,
          // Sampled here, per candidate, from the same PACING every other pause
          // in the run draws from. The driver is a classic content script with
          // no imports: it cannot reach jitter.js, and copying the numbers into
          // it would put one concept in two places. So pacing stays the panel's
          // and the DOM stays the driver's, and these two numbers are the whole
          // of what crosses.
          payload: {
            expectedUserId: userId,
            message,
            beforePasteMs: sample(PACING.beforePasteMs[0], PACING.beforePasteMs[1], rand),
            afterPasteMs: sample(PACING.afterPasteMs[0], PACING.afterPasteMs[1], rand),
          },
        });
      } catch (sendError) {
        // Nothing is ever retried here. The whole of what follows is about
        // LEARNING what happened, never about trying again: the send has either
        // gone out or it has not, and a second click would be a second message
        // to a real person.
        //
        // What differs is what the operator is told. The driver knows whether
        // it refused before clicking and says so; the panel used to flatten
        // both cases into the alarming one.
        const reason = String(sendError.message || sendError);

        // The one case worth another question. `error` means the driver refused
        // BEFORE the click - certain, nothing went out, and asking the API
        // about it could only produce a wrong answer. `unclear` means the click
        // happened and the DOM never confirmed it, which is the case the API
        // can settle.
        let verdict = null;
        let looks = 0;
        let waitedMs = 0;
        if (sendOutcome(reason) === 'unclear' && checkQueue && queueChecksLeft > 0) {
          queueChecksLeft -= 1;
          emit({ type: 'accept_unconfirmed', jobId, userId, error: reason });
          // Looked at more than once, with the waits growing between looks.
          // One look establishes only where the candidate was at that instant,
          // and a send still in flight puts them in the queue exactly as a send
          // that never happened does. `gone` is the only answer that settles
          // anything, so it is the only one that ends the loop early; both of
          // the others are worth asking again after a wait.
          //
          // Its failure is an answer, not an exception: a check that cannot
          // reach the API has learnt nothing, which is the same position the
          // pass was in before it asked.
          const look = async () => {
            looks += 1;
            let seen = 'unknown';
            try {
              seen = String((await checkQueue(userId)) ?? 'unknown');
            } catch {
              seen = 'unknown';
            }
            emit({ type: 'accept_checked', jobId, userId, verdict: seen, look: looks });
            return seen;
          };
          verdict = await look();
          for (const waitMs of QUEUE_SETTLE_WAITS_MS) {
            if (verdict === 'gone') break;
            // A stop ends the settling where it stands. Nothing is sent either
            // way, and an operator who has pressed Stop is not waiting another
            // minute to be told something the run will report as unclear.
            if (signal?.aborted) break;
            emit({ type: 'resting', jobId, ms: waitMs });
            await sleep(waitMs, signal);
            waitedMs += waitMs;
            verdict = await look();
          }
          if (verdict === 'gone') {
            // They are not in NEEDS_REVIEW any more, and the click that would
            // remove them from it is the one this pass just made. The send
            // landed. Booked exactly as a confirmed one - ledger first, so a
            // later run cannot message them again - and the pass carries on.
            //
            // The page could not vouch for this send, so the page is not
            // trusted for another one: the refresh below is asked for now
            // rather than at the next multiple of the cadence.
            const carryOn = await bookAccept(userId, { confirmedBy: 'queue', looks });
            if (!carryOn) break;
            refreshPending = true;
            await pace();
            continue;
          }
        }

        // Still queued after settling, never asked, or asked and unanswerable.
        // The pass stops here and is never followed by a skip either: if the
        // message may have gone out, advancing past them loses the fact; and if
        // the driver refused before clicking, whatever made it refuse is likely
        // to refuse for the next person too.
        //
        // `stoppedBecause` is decided from the driver's ORIGINAL sentence and
        // not from the enriched one below. What was learnt afterwards changes
        // what the operator reads; it does not change which of the two things
        // the driver said happened at the click.
        const told = unresolvedReason(reason, { verdict, looks, waitedMs });
        mark(userId, acceptFailure(told));
        totals.failed += 1;
        emitCandidate(userId, 'failed', { error: told });
        stoppedBecause = sendOutcome(reason);
        error = told;
        break;
      }

      // How long the page took over that accept, and what it says about the
      // page. This is the trigger that works on a role of any size: the counted
      // cadence below cannot know that a 111-applicant list degrades five times
      // faster than a 20-applicant one, and a single slow accept says it
      // outright, one whole accept before the relay would give up.
      //
      // Read AFTER the send resolved and BEFORE the ledger write, so it is a
      // measurement of what already happened and never a reason to touch the
      // page while this accept is outstanding. It only ever asks for a refresh
      // at the top of the next turn, exactly as the counter does.
      const tookMs = now() - sendStartedAt;
      if (tookMs >= SLOW_ACCEPT_MS) {
        refreshPending = true;
        emit({ type: 'accept_slow', jobId, userId, ms: tookMs });
      }
      // Recorded before anything else can interrupt, exactly as a download is:
      // an accept the ledger does not know about gets sent a second time. The
      // interlock opens on the far side of that write, inside bookAccept.
      const carryOn = await bookAccept(userId);
      if (!carryOn) break;
      acceptsSinceRefresh += 1;

      // No skip here, ever. A confirmed accept has already auto-advanced -
      // measured live as `1 of 116` becoming `1 of 115` with the next person
      // in the slot - so advancing again would step over somebody unseen.
      await pace();
    }
  } catch (walkError) {
    // Opening the reviewer, reading a position or skipping. None of these send
    // anything, so the pass simply stops and says so; the rows it never
    // reached keep NOT_REACHED.
    stoppedBecause = 'error';
    error = String(walkError.message || walkError);
  }

  return finish();
}
