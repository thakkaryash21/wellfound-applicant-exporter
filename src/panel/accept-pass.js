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

// The two Resume outcomes that mean "we have their file". Anything else -
// no resume, locked, previewed, failed, never reached - means accepting them
// would forfeit their resume forever, because an accepted candidate leaves
// NEEDS_REVIEW and no query this extension has can ever reach them again.
const CAPTURED = new Set([RESUME_STATUS.DOWNLOADED, RESUME_STATUS.ALREADY]);

// `[first_name]` is a greeting, not an identity: the record carries one `name`
// field and the first whitespace-separated word of it is what a human would
// type. An empty result is fine - composeMessage drops the name and keeps the
// comma rather than skipping the candidate.
export function firstNameOf(name) {
  return String(name ?? '').trim().split(/\s+/)[0] ?? '';
}

// Who this pass will try, who it refuses and why - decided before a single
// keystroke, from the rows pass 1 built. Every row gets an Accept cell here, so
// no row can reach the CSV with a blank one and leave the reader guessing
// whether it was refused, missed, or never attempted.
export function planAccepts({ records = [], alreadyAccepted = [] } = {}) {
  const already = new Set(alreadyAccepted.map(String));
  // One person can hold two rows on the same page, so the plan is keyed by
  // userId and every row for that id moves together.
  const rowsById = new Map();
  const targets = [];
  let refusedNoResume = 0;
  let alreadyCount = 0;

  for (const record of records) {
    const userId = record.userId == null ? null : String(record.userId);
    // Nobody without an id can be accepted: the interlock in the reviewer
    // matches on the id and there is no name-based fallback anywhere.
    if (!userId || !CAPTURED.has(record.resumeStatus)) {
      record.acceptStatus = ACCEPT_STATUS.NO_RESUME;
      refusedNoResume += 1;
      continue;
    }
    if (already.has(userId)) {
      record.acceptStatus = ACCEPT_STATUS.ALREADY;
      alreadyCount += 1;
      continue;
    }
    if (rowsById.has(userId)) {
      rowsById.get(userId).push(record);
    } else {
      rowsById.set(userId, [record]);
      targets.push(userId);
    }
    // Held until the walk reaches them. A pass that stops early leaves this
    // word in the cell, which is the honest one.
    record.acceptStatus = ACCEPT_STATUS.NOT_REACHED;
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

  const finish = () => {
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
          firstName: firstNameOf(plan.rowsById.get(userId)?.[0]?.name),
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
          payload: { expectedUserId: userId, message },
        });
      } catch (sendError) {
        // An unclear outcome stops the pass and reports it. It is never
        // retried and never followed by a skip: the message may have gone out,
        // and a second one is a second message to a real person.
        const reason = String(sendError.message || sendError);
        mark(userId, acceptFailure(reason));
        totals.failed += 1;
        emitCandidate(userId, 'failed', { error: reason });
        stoppedBecause = 'unclear';
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
