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
// Declared here rather than beside the other CX names purely because this pass
// is the only sender; bridge.js carries the same literal in its table, exactly
// as the message types are duplicated into it, and a test asserts the two agree.
export const CX_CLOSE_REVIEWER = 'CX_CLOSE_REVIEWER';

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
export function planAccepts({ records = [], alreadyAccepted = [] } = {}) {
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

  return { targets, rowsById, refusedNoResume, alreadyAccepted: alreadyCount };
}

// `review` is one call into the reviewer driver, `recordAccepted` is the
// ledger write, and both are injected for the same reason the download walk
// injects its own: this loop is the part worth testing, and neither a real tab
// nor a real message may be involved in testing it.
export async function runAcceptPass(deps, options) {
  const { review, recordAccepted, sleep, emit } = deps;
  const rand = deps.rand ?? Math.random;
  const { jobId, jobTitle, records = [], alreadyAccepted = [], template, signal } = options;

  const plan = planAccepts({ records, alreadyAccepted });
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

  try {
    touchedReviewer = true;
    await review({ type: CX.OPEN_REVIEWER });

    while (remaining.size > 0) {
      if (signal?.aborted) {
        stoppedBecause = 'aborted';
        break;
      }

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
        totals.skipped += 1;
        emitCandidate(userId, 'skipped');
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
        // Either way the pass stops here. It is never retried and never
        // followed by a skip: if the message may have gone out, a second one is
        // a second message to a real person; and if the driver refused before
        // clicking, whatever made it refuse is likely to refuse for the next
        // person too.
        //
        // What differs is what the operator is told. The driver knows which of
        // the two happened and says so; the panel used to flatten both into the
        // alarming one.
        const reason = String(sendError.message || sendError);
        mark(userId, acceptFailure(reason));
        totals.failed += 1;
        emitCandidate(userId, 'failed', { error: reason });
        stoppedBecause = sendOutcome(reason);
        error = reason;
        break;
      }

      // Recorded before anything else can interrupt, exactly as a download is:
      // an accept the ledger does not know about gets sent a second time.
      await recordAccepted(jobId, userId);
      const acceptedAt = localDateTimeText();
      remaining.delete(userId);
      mark(userId, ACCEPT_STATUS.ACCEPTED, acceptedAt);
      totals.accepted += 1;
      emitCandidate(userId, 'accepted');

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
