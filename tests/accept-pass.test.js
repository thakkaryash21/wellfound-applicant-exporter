import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  runAcceptPass,
  planAccepts,
  firstNameOf,
  resolveFirstName,
  sendOutcome,
  CX_CLOSE_REVIEWER,
} from '../src/panel/accept-pass.js';
import { ACCEPT_STATUS, RESUME_STATUS } from '../src/lib/csv.js';
import { CX } from '../src/lib/messages.js';
import { PACING } from '../src/lib/jitter.js';

const JOB = '9100001';

// The reviewer as it was measured on the live page, and only as it was
// measured: a QUEUE, not a list. A confirmed accept removes the candidate and
// leaves the index alone (1 of 116 -> 1 of 115); a skip advances the index and
// leaves the total alone (1 of 115 -> 2 of 115). Every message the pass sends
// is logged, because half of what these tests assert is what was NOT sent.
function fakeReviewer({ people, failAccept = null, closeFails = false } = {}) {
  const queue = people.map(String);
  const log = [];
  let index = 1;
  let opened = false;

  const at = () => {
    if (index > queue.length) throw new Error('The reviewer has no candidate at this position');
    return { userId: queue[index - 1], index, total: queue.length };
  };

  const review = async (message) => {
    log.push({ type: message.type, ...(message.payload ?? {}) });
    if (message.type === CX.OPEN_REVIEWER) {
      opened = true;
      index = 1;
      return { opened: true, ...at() };
    }
    // Teardown, answered whether or not anything is open - the driver's own
    // teardown is safe to call when there is nothing to tear down, and a fake
    // that insisted on an open modal would be a stricter page than the real one.
    // `opened` is what a test reads to ask whether the pass left the reviewer
    // sitting there with a composed message in it.
    if (message.type === CX_CLOSE_REVIEWER) {
      if (closeFails) throw new Error('Page did not respond in time');
      opened = false;
      return { cancelled: false, closed: true, notes: [] };
    }
    if (!opened) throw new Error('The reviewer is not open');
    if (message.type === CX.READ_CANDIDATE) return at();
    if (message.type === CX.SKIP_CANDIDATE) {
      index += 1;
      return at();
    }
    if (message.type === CX.STOP_REVIEWER) return { stopped: true };
    if (message.type === CX.ACCEPT_CANDIDATE) {
      const here = at();
      if (here.userId !== String(message.payload.expectedUserId)) {
        throw new Error(`The reviewer is showing ${here.userId}`);
      }
      if (failAccept === here.userId) {
        throw new Error(`Could not confirm the accept for ${here.userId}`);
      }
      queue.splice(index - 1, 1);
      return { userId: here.userId, accepted: true, next: queue[index - 1] ? at() : null };
    }
    throw new Error(`unexpected message ${message.type}`);
  };

  return { review, log, queue, isOpen: () => opened };
}

const captured = (userId, name = `Person ${userId}`) => ({
  userId,
  name,
  resumeStatus: RESUME_STATUS.DOWNLOADED,
});

// One row per person, in the shape pass 1 leaves behind.
function harness({ people, records, failAccept = null, signal, template, rand, limit } = {}) {
  const reviewer = fakeReviewer({ people, failAccept });
  const events = [];
  const ledger = [];
  const sleeps = [];
  const deps = {
    review: reviewer.review,
    recordAccepted: async (jobId, userId) => {
      // Written into the same log the reviewer writes to, so the ORDER of a
      // ledger write against the next reviewer message is assertable.
      reviewer.log.push({ type: 'LEDGER', userId });
      ledger.push({ jobId, userId });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    emit: (event) => events.push(event),
    ...(rand ? { rand } : {}),
  };
  const run = () =>
    runAcceptPass(deps, {
      jobId: JOB,
      jobTitle: 'Platform Engineer',
      records,
      alreadyAccepted: [],
      template,
      signal,
      ...(limit === undefined ? {} : { limit }),
    });
  return { run, reviewer, events, ledger, sleeps };
}

const typesOf = (log) => log.map((entry) => entry.type);

describe('planAccepts', () => {
  it('refuses anybody whose resume was never captured, and says why in the cell', () => {
    const rows = [
      captured('1'),
      { userId: '2', name: 'No Resume', resumeStatus: RESUME_STATUS.NO_RESUME },
      { userId: '3', name: 'Locked', resumeStatus: RESUME_STATUS.LOCKED },
      { userId: '4', name: 'Previewed', resumeStatus: RESUME_STATUS.PREVIEW },
      { userId: null, name: 'Nameless', resumeStatus: RESUME_STATUS.NO_ID },
      { userId: '5', name: 'Failed', resumeStatus: 'failed: NETWORK_FAILED' },
    ];
    const plan = planAccepts({ records: rows });
    expect(plan.targets).toEqual(['1']);
    expect(plan.refusedNoResume).toBe(5);
    expect(rows.slice(1).map((r) => r.acceptStatus)).toEqual(
      new Array(5).fill(ACCEPT_STATUS.NO_RESUME),
    );
    expect(rows[0].acceptStatus).toBe(ACCEPT_STATUS.NOT_REACHED);
  });

  it('leaves anyone the ledger already accepted out of the walk', () => {
    const rows = [captured('1'), captured('2')];
    const plan = planAccepts({ records: rows, alreadyAccepted: [2] });
    expect(plan.targets).toEqual(['1']);
    expect(rows[1].acceptStatus).toBe(ACCEPT_STATUS.ALREADY);
  });

  it('moves both of one person s rows together', () => {
    const rows = [captured('1'), captured('1')];
    const plan = planAccepts({ records: rows });
    expect(plan.targets).toEqual(['1']);
    expect(plan.rowsById.get('1')).toHaveLength(2);
  });

  // The shape the review found and nothing covered: ONE person, TWO rows, and
  // the row whose download was attempted failed. The other row only points at
  // it. Deciding row by row refused the first and accepted the second - the
  // same person, both cells in the same CSV, and a resume gone for good,
  // because accepting removes them from the only query this extension has.
  it('refuses a person whose other row failed its download, however the second row reads', () => {
    const rows = [
      { userId: '7', name: 'Person 7', resumeStatus: 'failed: NETWORK_FAILED' },
      { userId: '7', name: 'Person 7', resumeStatus: RESUME_STATUS.ANOTHER_ROW },
    ];
    const plan = planAccepts({ records: rows });
    expect(plan.targets).toEqual([]);
    expect(plan.refusedNoResume).toBe(2);
    // Both cells agree. One row saying "refused" beside another saying
    // "accepted" was the CSV this bug wrote, and the CSV is the only surviving
    // record of an accepted person.
    expect(rows.map((r) => r.acceptStatus)).toEqual([
      ACCEPT_STATUS.NO_RESUME,
      ACCEPT_STATUS.NO_RESUME,
    ]);
  });

  // The accept-only corollary: nobody was downloaded at all, so the first row
  // is a preview and the second points at it. Neither is evidence of a file.
  it('refuses a person whose only real row was a preview', () => {
    const rows = [
      { userId: '7', resumeStatus: RESUME_STATUS.PREVIEW },
      { userId: '7', resumeStatus: RESUME_STATUS.ANOTHER_ROW },
    ];
    expect(planAccepts({ records: rows }).targets).toEqual([]);
  });

  // The pointer must not swing the other way either: a person whose real row
  // downloaded cleanly is acceptable, and their second row must not block them.
  it('accepts a person whose other row downloaded, and moves both rows together', () => {
    const rows = [captured('7'), { userId: '7', resumeStatus: RESUME_STATUS.ANOTHER_ROW }];
    const plan = planAccepts({ records: rows });
    expect(plan.targets).toEqual(['7']);
    expect(rows.map((r) => r.acceptStatus)).toEqual([
      ACCEPT_STATUS.NOT_REACHED,
      ACCEPT_STATUS.NOT_REACHED,
    ]);
  });

  // A row that points at nothing - the other row never arrived, a walk that
  // stopped between them - is not a capture. The default is refusal.
  it('refuses a person who has only a pointer row', () => {
    const rows = [{ userId: '7', resumeStatus: RESUME_STATUS.ANOTHER_ROW }];
    expect(planAccepts({ records: rows }).targets).toEqual([]);
    expect(rows[0].acceptStatus).toBe(ACCEPT_STATUS.NO_RESUME);
  });
});

// The one control the operator has over how many strangers get a message. It
// was read by pass 1 as "at most N new downloads" and by pass 2 as nothing at
// all, and in the operator's own workflow pass 1's counter never moved: every
// page was all-seen, so the limit never fired once, and the accept pass was
// handed every applicant in the role with every one of them captured. A limit
// of 3 on a 115-person role sent 115 messages.
describe('the role s limit bounds who is messaged', () => {
  // THE case. Accept-only over a role that was downloaded in full on an earlier
  // run: every record captured, nobody accepted yet, limit 3.
  it('messages three of a fully-downloaded role, not the whole role', async () => {
    const ids = Array.from({ length: 115 }, (_, i) => String(70000001 + i));
    const records = ids.map((id) => captured(id));
    const { run, reviewer, ledger } = harness({ people: ids, records, limit: 3 });

    const result = await run();

    expect(result.accepted).toBe(3);
    expect(result.intended).toBe(3);
    expect(result.stoppedBecause).toBe('finished');
    // What was actually sent, counted from the reviewer's own log rather than
    // from the pass's report of itself.
    const sent = reviewer.log.filter((entry) => entry.type === CX.ACCEPT_CANDIDATE);
    expect(sent).toHaveLength(3);
    expect(ledger.map((entry) => entry.userId)).toEqual(ids.slice(0, 3));
    // And 112 people are still in the queue, unmessaged.
    expect(reviewer.queue).toHaveLength(112);
  });

  // Queue order, carried through `records` and out again unchanged - not
  // whatever order a Map or an object happens to yield. The three taken are the
  // three at the front, which is where the reviewer already is, so a capped run
  // never skips past anybody to reach its targets.
  it('takes the first N in the order pass 1 handed them over', () => {
    const rows = ['70000005', '70000001', '70000009', '70000003'].map((id) => captured(id));
    expect(planAccepts({ records: rows, limit: 2 }).targets).toEqual(['70000005', '70000001']);
  });

  // Held back is not refused and not attempted. NOT_REACHED is already the word
  // for "the run was accepting and stopped (a limit, an abort) before reaching
  // this candidate", and that is exactly what happened to them.
  it('leaves everyone over the limit reading not reached, and refuses nobody', () => {
    const rows = ['70000001', '70000002', '70000003'].map((id) => captured(id));
    const plan = planAccepts({ records: rows, limit: 1 });
    expect(plan.refusedNoResume).toBe(0);
    expect(rows.map((row) => row.acceptStatus)).toEqual([
      ACCEPT_STATUS.NOT_REACHED,
      ACCEPT_STATUS.NOT_REACHED,
      ACCEPT_STATUS.NOT_REACHED,
    ]);
    expect(plan.targets).toEqual(['70000001']);
  });

  // A refusal is not a message, so it must not spend the number. Two people
  // with no resume ahead of three with one still means three messages: a cap
  // that counted refusals would let a limit of 3 send one.
  it('spends the number on messages only, not on refusals', () => {
    const rows = [
      { userId: '70000001', resumeStatus: RESUME_STATUS.NO_RESUME },
      { userId: '70000002', resumeStatus: RESUME_STATUS.PREVIEW },
      captured('70000003'),
      captured('70000004'),
      captured('70000005'),
    ];
    const plan = planAccepts({ records: rows, limit: 3 });
    expect(plan.targets).toEqual(['70000003', '70000004', '70000005']);
    expect(plan.refusedNoResume).toBe(2);
  });

  // Nor does somebody messaged on an earlier run. They get nothing this time,
  // so they cost nothing this time.
  it('spends nothing on the people an earlier run already messaged', () => {
    const rows = ['70000001', '70000002', '70000003', '70000004'].map((id) => captured(id));
    const plan = planAccepts({ records: rows, alreadyAccepted: ['70000001'], limit: 2 });
    expect(plan.targets).toEqual(['70000002', '70000003']);
    expect(plan.alreadyAccepted).toBe(1);
  });

  // A role set to "everyone" keeps accepting everyone. panel.js passes Infinity
  // for that mode, and an absent limit means the same thing.
  it('keeps the unlimited case genuinely unlimited', async () => {
    const ids = ['70000001', '70000002', '70000003', '70000004'];
    const records = ids.map((id) => captured(id));
    expect(planAccepts({ records, limit: Infinity }).targets).toEqual(ids);

    const { run, reviewer } = harness({ people: ids, records, limit: Infinity });
    expect((await run()).accepted).toBe(4);
    expect(reviewer.queue).toHaveLength(0);
  });

  // The number the pass reports itself against is the capped one, so progress
  // reads "1 of 3" rather than "1 of 115" on a run that will send three.
  it('reports progress against the capped number', async () => {
    const ids = ['70000001', '70000002', '70000003', '70000004', '70000005'];
    const { run, events } = harness({
      people: ids,
      records: ids.map((id) => captured(id)),
      limit: 2,
    });
    await run();
    expect(events.find((event) => event.type === 'accept_started')).toMatchObject({ intended: 2 });
    expect(events.find((event) => event.type === 'accept_done')).toMatchObject({
      intended: 2,
      accepted: 2,
    });
  });
});

// The driver knows two very different things and used to have one way to say
// them. `unclear` is the only state in this panel that tells the operator a
// stranger may have been messaged and sends them to Wellfound to check; every
// guard that fires BEFORE the send click knows for certain that nothing went
// out, and must not raise it.
describe('sendOutcome', () => {
  it('reads the driver s certain refusals as a plain stop', () => {
    for (const reason of [
      'The response composer did not open; nothing was sent',
      'The reviewer is showing 70000002, not 70000001; nothing was sent',
      'Refusing to send a message with an unsubstituted token; nothing was sent',
      'Refusing to click a reject control (asked for Accept, found "Reject"); nothing was sent',
    ]) {
      expect(sendOutcome(reason)).toBe('error');
    }
  });

  it('keeps unclear for the one failure that follows the click', () => {
    expect(
      sendOutcome(
        'Could not confirm the accept for 70000001. It may or may not have been sent - ' +
          'check the candidate in Wellfound before running again. Nothing was retried.',
      ),
    ).toBe('unclear');
  });

  // The polarity that matters. Only certainty is marked, so anything this
  // extension did not write - the relay's own timeout, an exception from
  // somewhere unforeseen - falls to the cautious reading rather than the
  // reassuring one.
  it('treats an outcome nobody vouched for as unclear', () => {
    expect(sendOutcome('Page did not respond in time')).toBe('unclear');
    expect(sendOutcome('')).toBe('unclear');
  });
});

describe('firstNameOf', () => {
  it('takes the first word, and nothing at all from an empty name', () => {
    expect(firstNameOf('Jane Q. Doe')).toBe('Jane');
    expect(firstNameOf(null)).toBe('');
  });
});

describe('resolveFirstName', () => {
  it('prefers the real firstName field over a split of the display name', () => {
    expect(resolveFirstName({ firstName: 'Jane', name: 'Dr. Jane Doe' })).toBe('Jane');
  });

  it('falls back to the first word of name when firstName is missing', () => {
    expect(resolveFirstName({ firstName: null, name: 'Jane Q. Doe' })).toBe('Jane');
    expect(resolveFirstName({ name: 'Jane Q. Doe' })).toBe('Jane');
  });

  it('falls back to the first word of name when firstName is empty', () => {
    expect(resolveFirstName({ firstName: '   ', name: 'Jane Q. Doe' })).toBe('Jane');
  });

  it('yields nothing when both firstName and name are missing', () => {
    expect(resolveFirstName({ firstName: null, name: null })).toBe('');
    expect(resolveFirstName(undefined)).toBe('');
  });
});

describe('runAcceptPass', () => {
  // Rule 3. Accepting everybody performs NO navigation: the confirm already
  // auto-advanced, and a skip after one steps over a person unseen.
  it('never follows a confirmed accept with a skip', async () => {
    const records = [captured('1'), captured('2'), captured('3')];
    const { run, reviewer, ledger } = harness({ people: ['1', '2', '3'], records });
    const result = await run();

    expect(result).toMatchObject({ accepted: 3, skipped: 0, stoppedBecause: 'finished' });
    expect(typesOf(reviewer.log)).not.toContain(CX.SKIP_CANDIDATE);
    expect(ledger.map((l) => l.userId)).toEqual(['1', '2', '3']);
    expect(records.every((r) => r.acceptStatus === ACCEPT_STATUS.ACCEPTED)).toBe(true);
    expect(records[0].acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  // Rule 2, at the loop rather than at the plan: the refused person is in the
  // bucket and on screen, and the pass must walk past them without a send.
  it('never sends to somebody whose resume was not captured', async () => {
    const records = [
      captured('1'),
      { userId: '2', name: 'No Resume', resumeStatus: RESUME_STATUS.NO_RESUME },
    ];
    const { run, reviewer } = harness({ people: ['2', '1'], records });
    const result = await run();

    expect(result).toMatchObject({ accepted: 1, refusedNoResume: 1 });
    const accepts = reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE);
    expect(accepts.map((a) => a.expectedUserId)).toEqual(['1']);
    expect(records[1].acceptStatus).toBe(ACCEPT_STATUS.NO_RESUME);
  });

  // Rule 4. An unclear outcome stops everything: it is never retried, and the
  // people behind it are left plainly unattempted rather than quietly missed.
  it('stops on an unclear send, retries nothing, and touches nobody after it', async () => {
    const records = [captured('1'), captured('2')];
    const { run, reviewer, ledger, events } = harness({
      people: ['1', '2'],
      records,
      failAccept: '1',
    });
    const result = await run();

    expect(result.stoppedBecause).toBe('unclear');
    expect(result.accepted).toBe(0);
    expect(result.failed).toBe(1);
    expect(reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE)).toHaveLength(1);
    expect(typesOf(reviewer.log)).not.toContain(CX.SKIP_CANDIDATE);
    expect(ledger).toEqual([]);
    expect(records[0].acceptStatus).toMatch(/^failed: /);
    expect(records[1].acceptStatus).toBe(ACCEPT_STATUS.NOT_REACHED);
    expect(events.at(-1)).toMatchObject({ type: 'accept_done', stoppedBecause: 'unclear' });
  });

  // The same halt, the other cause. The composer failed to open, so the driver
  // never clicked anything and says so. Calling this `unclear` sent the
  // operator to audit a role where provably nothing happened - and an alert
  // that cries wolf gets discounted on the run where it is real.
  it('stops without the alarm when the driver refused before clicking send', async () => {
    const records = [captured('1'), captured('2')];
    const reviewer = fakeReviewer({ people: ['1', '2'] });
    const events = [];
    const ledger = [];
    const result = await runAcceptPass(
      {
        review: async (message) => {
          if (message.type === CX.ACCEPT_CANDIDATE) {
            throw new Error('The response composer did not open; nothing was sent');
          }
          return reviewer.review(message);
        },
        recordAccepted: async () => ledger.push(1),
        sleep: async () => {},
        emit: (event) => events.push(event),
      },
      { jobId: JOB, jobTitle: 'Platform Engineer', records },
    );

    expect(result.stoppedBecause).toBe('error');
    expect(result.stoppedBecause).not.toBe('unclear');
    // Everything else about a halt is unchanged: nothing retried, nobody
    // behind them touched, the cell honest about which of the two it was.
    expect(result.failed).toBe(1);
    expect(ledger).toEqual([]);
    expect(typesOf(reviewer.log)).not.toContain(CX.SKIP_CANDIDATE);
    expect(records[0].acceptStatus).toMatch(/^failed: .*nothing was sent/);
    expect(records[1].acceptStatus).toBe(ACCEPT_STATUS.NOT_REACHED);
  });

  // Rule 5. The ledger write lands before anything else can interrupt - an
  // accept the ledger does not know about is a second message to a stranger.
  it('records the accept before it reads the next candidate', async () => {
    const records = [captured('1'), captured('2')];
    const { run, reviewer } = harness({ people: ['1', '2'], records });
    await run();

    const order = typesOf(reviewer.log);
    const firstAccept = order.indexOf(CX.ACCEPT_CANDIDATE);
    const firstLedger = order.indexOf('LEDGER');
    const nextRead = order.indexOf(CX.READ_CANDIDATE, firstAccept);
    expect(firstLedger).toBeGreaterThan(firstAccept);
    expect(firstLedger).toBeLessThan(nextRead);
  });

  // Rule 6. A message that cannot be composed is not a message that gets sent
  // half-substituted.
  it('does not send a message it could not compose', async () => {
    const records = [captured('1'), captured('2')];
    const { run, reviewer, ledger } = harness({
      // A third person nobody is targeting, so the skips past the two failures
      // land somewhere: what the reviewer does when the bucket empties under it
      // was never observed live, and no test may assert a guess about it.
      people: ['1', '2', '3'],
      records,
      template: 'Hey [first_name], about [typo_name]',
    });
    const result = await run();

    expect(result).toMatchObject({ accepted: 0, failed: 2, stoppedBecause: 'finished' });
    expect(typesOf(reviewer.log)).not.toContain(CX.ACCEPT_CANDIDATE);
    expect(ledger).toEqual([]);
    expect(records[0].acceptStatus).toMatch(/^failed: .*token/);
  });

  it('skips past somebody it was not asked to accept', async () => {
    const records = [captured('2')];
    const { run, reviewer } = harness({ people: ['1', '2'], records });
    const result = await run();

    expect(result).toMatchObject({ accepted: 1, skipped: 1 });
    expect(typesOf(reviewer.log).filter((t) => t === CX.SKIP_CANDIDATE)).toHaveLength(1);
    expect(
      reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE).map((e) => e.expectedUserId),
    ).toEqual(['2']);
  });

  it('opens nothing at all when there is nobody to accept', async () => {
    const records = [{ userId: '1', name: 'No Resume', resumeStatus: RESUME_STATUS.NO_RESUME }];
    const { run, reviewer, events } = harness({ people: ['1'], records });
    const result = await run();

    expect(reviewer.log).toEqual([]);
    expect(result).toMatchObject({ intended: 0, accepted: 0, stoppedBecause: 'finished' });
    expect(events.map((e) => e.type)).toEqual(['accept_started', 'accept_done']);
  });

  it('stops when the operator aborts, leaving the rest unattempted', async () => {
    const records = [captured('1'), captured('2'), captured('3')];
    const controller = new AbortController();
    const reviewer = fakeReviewer({ people: ['1', '2', '3'] });
    const events = [];
    const result = await runAcceptPass(
      {
        review: async (message) => {
          const answer = await reviewer.review(message);
          if (message.type === CX.ACCEPT_CANDIDATE) controller.abort();
          return answer;
        },
        recordAccepted: async () => {},
        sleep: async () => {},
        emit: (event) => events.push(event),
      },
      {
        jobId: JOB,
        jobTitle: 'Platform Engineer',
        records,
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({ accepted: 1, stoppedBecause: 'aborted' });
    expect(records[1].acceptStatus).toBe(ACCEPT_STATUS.NOT_REACHED);
  });

  it('stops and reports when the reviewer will not open, having sent nothing', async () => {
    const records = [captured('1')];
    const events = [];
    const result = await runAcceptPass(
      {
        review: async () => {
          throw new Error('The reviewer did not open');
        },
        recordAccepted: async () => {},
        sleep: async () => {},
        emit: (event) => events.push(event),
      },
      { jobId: JOB, jobTitle: 'Platform Engineer', records },
    );

    expect(result).toMatchObject({ accepted: 0, stoppedBecause: 'error' });
    expect(result.error).toContain('did not open');
    expect(records[0].acceptStatus).toBe(ACCEPT_STATUS.NOT_REACHED);
  });

  it('reports progress against the intended count, not the shrinking bucket', async () => {
    const records = [captured('1'), captured('2')];
    const { run, events } = harness({ people: ['1', '2'], records });
    await run();

    const considering = events.filter((e) => e.type === 'accept_considering');
    expect(considering.map((e) => ({ userId: e.userId, total: e.total, accepted: e.accepted }))).toEqual([
      { userId: '1', total: 2, accepted: 0 },
      { userId: '2', total: 1, accepted: 1 },
    ]);
    expect(considering.every((e) => e.intended === 2)).toBe(true);
    expect(events.filter((e) => e.type === 'accept_candidate')).toHaveLength(2);
  });

  it('paces itself between candidates, the same way the download walk does', async () => {
    const records = [captured('1'), captured('2')];
    const { run, sleeps, events } = harness({ people: ['1', '2'], records });
    await run();

    expect(sleeps).toHaveLength(2);
    expect(events.filter((e) => e.type === 'resting' || e.type === 'break')).toHaveLength(2);
  });

  // The two pauses inside an accept - a beat before the message goes in, a beat
  // to read it back - are sampled here rather than in the driver. The driver is
  // a classic content script and cannot import jitter.js, and a copy of the
  // numbers there would be the same concept in two files, drifting apart.
  it('samples a fresh pair of pauses for the paste, per candidate', async () => {
    let seed = 1;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const records = [captured('1'), captured('2')];
    const { run, reviewer } = harness({ people: ['1', '2'], records, rand });
    await run();

    const accepts = reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE);
    expect(accepts).toHaveLength(2);
    for (const accept of accepts) {
      expect(accept.beforePasteMs).toBeGreaterThanOrEqual(PACING.beforePasteMs[0]);
      expect(accept.beforePasteMs).toBeLessThanOrEqual(PACING.beforePasteMs[1]);
      expect(accept.afterPasteMs).toBeGreaterThanOrEqual(PACING.afterPasteMs[0]);
      expect(accept.afterPasteMs).toBeLessThanOrEqual(PACING.afterPasteMs[1]);
    }
    // Drawn again for the second person. A pair fixed for the whole run would
    // be a rhythm no human has, and the most fingerprintable shape of all.
    expect([accepts[0].beforePasteMs, accepts[0].afterPasteMs]).not.toEqual([
      accepts[1].beforePasteMs,
      accepts[1].afterPasteMs,
    ]);
  });

  // An accept spends most of its time paused inside the page, and an
  // AbortSignal does not cross that boundary. Without this the operator's stop
  // is only felt after the pause it interrupted - which is after the send.
  it('tells the page to stop as well, when the operator aborts', async () => {
    const records = [captured('1'), captured('2')];
    const controller = new AbortController();
    const reviewer = fakeReviewer({ people: ['1', '2'] });
    await runAcceptPass(
      {
        review: async (message) => {
          const answer = await reviewer.review(message);
          if (message.type === CX.ACCEPT_CANDIDATE) controller.abort();
          return answer;
        },
        recordAccepted: async () => {},
        sleep: async () => {},
        emit: () => {},
      },
      { jobId: JOB, jobTitle: 'Platform Engineer', records, signal: controller.signal },
    );

    expect(typesOf(reviewer.log)).toContain(CX.STOP_REVIEWER);
  });
});

// The pass used to end and leave the reviewer standing - and on the stop path,
// with the operator's message typed into the composer, one click from a real
// person. The panel showed a post-run summary; the tab showed a half-written
// message to a stranger. Closing it is the driver's job, but remembering to ask
// is this file's, on EVERY way out and not just the ones that throw.
describe('leaving Wellfound as the pass found it', () => {
  const closedOn = async (make) => {
    const { reviewer, result } = await make();
    expect(typesOf(reviewer.log)).toContain(CX_CLOSE_REVIEWER);
    expect(reviewer.isOpen()).toBe(false);
    return result;
  };

  it('closes the reviewer after a pass that finished normally', async () => {
    const records = [captured('1'), captured('2')];
    const { run, reviewer } = harness({ people: ['1', '2'], records });
    const result = await closedOn(async () => ({ reviewer, result: await run() }));
    expect(result).toMatchObject({ accepted: 2, stoppedBecause: 'finished' });
    // Last, after the work and before the pass reports: the page is quiet by
    // the time the operator is looking at the summary.
    expect(typesOf(reviewer.log).at(-1)).toBe(CX_CLOSE_REVIEWER);
  });

  it('closes it after the send the driver could not confirm', async () => {
    const records = [captured('1'), captured('2')];
    const { run, reviewer } = harness({ people: ['1', '2'], records, failAccept: '1' });
    const result = await closedOn(async () => ({ reviewer, result: await run() }));
    expect(result.stoppedBecause).toBe('unclear');
  });

  it('closes it after a refusal raised before the send was clicked', async () => {
    // The composer never opened, so the message is not in the box - but the
    // reviewer is still up, and the next thing to click it will be a person.
    const records = [captured('1')];
    const reviewer = fakeReviewer({ people: ['1'] });
    const result = await runAcceptPass(
      {
        review: async (message) => {
          if (message.type === CX.ACCEPT_CANDIDATE) {
            throw new Error('Stopped before the message was sent; nothing was sent');
          }
          return reviewer.review(message);
        },
        recordAccepted: async () => {},
        sleep: async () => {},
        emit: () => {},
      },
      { jobId: JOB, jobTitle: 'Platform Engineer', records },
    );
    expect(result.stoppedBecause).toBe('error');
    expect(typesOf(reviewer.log)).toContain(CX_CLOSE_REVIEWER);
    expect(reviewer.isOpen()).toBe(false);
  });

  // The path that mattered most: the operator pressed stop, and the composer
  // they were left staring at is the one thing the panel could not show them.
  it('closes it when the operator aborts, after telling the page to stop', async () => {
    const records = [captured('1'), captured('2')];
    const controller = new AbortController();
    const reviewer = fakeReviewer({ people: ['1', '2'] });
    await runAcceptPass(
      {
        review: async (message) => {
          const answer = await reviewer.review(message);
          if (message.type === CX.ACCEPT_CANDIDATE) controller.abort();
          return answer;
        },
        recordAccepted: async () => {},
        sleep: async () => {},
        emit: () => {},
      },
      { jobId: JOB, jobTitle: 'Platform Engineer', records, signal: controller.signal },
    );
    const types = typesOf(reviewer.log);
    // Stop first - it is a signal, and it has to reach an accept that is
    // mid-pause. Teardown second, once the pass has unwound and there is
    // nothing in flight for it to interrupt.
    expect(types.indexOf(CX.STOP_REVIEWER)).toBeLessThan(types.indexOf(CX_CLOSE_REVIEWER));
    expect(reviewer.isOpen()).toBe(false);
  });

  it('closes it even when opening it was what failed', async () => {
    // An open that fails part-way leaves the modal up at the wrong position,
    // which is precisely a state to leave rather than to abandon.
    const records = [captured('1')];
    const log = [];
    const result = await runAcceptPass(
      {
        review: async (message) => {
          log.push(message.type);
          if (message.type === CX.OPEN_REVIEWER) {
            throw new Error('The reviewer opened at position 2, not 1');
          }
          return { cancelled: false, closed: true, notes: [] };
        },
        recordAccepted: async () => {},
        sleep: async () => {},
        emit: () => {},
      },
      { jobId: JOB, jobTitle: 'Platform Engineer', records },
    );
    expect(result.stoppedBecause).toBe('error');
    expect(log).toEqual([CX.OPEN_REVIEWER, CX_CLOSE_REVIEWER]);
  });

  it('says nothing to the page when the pass never touched it', async () => {
    // Nobody to accept. The rule is unchanged: an accept-only run over a job
    // whose resumes were never captured touches Wellfound's UI not once, and a
    // teardown is a touch.
    const records = [{ userId: '1', name: 'No Resume', resumeStatus: RESUME_STATUS.NO_RESUME }];
    const { run, reviewer } = harness({ people: ['1'], records });
    await run();
    expect(reviewer.log).toEqual([]);
  });

  it('says nothing to the page when the operator aborted before it opened', async () => {
    const controller = new AbortController();
    controller.abort();
    const records = [captured('1')];
    const { run, reviewer } = harness({ people: ['1'], records, signal: controller.signal });
    const result = await run();
    expect(result.stoppedBecause).toBe('aborted');
    expect(reviewer.log).toEqual([]);
  });

  it('lets the pass report its own error when the teardown itself fails', async () => {
    // A teardown that threw would replace a message about a candidate with a
    // message about a button - and the candidate's is the one the operator
    // needs. It is swallowed, and the pass reports exactly what it would have.
    const records = [captured('1'), captured('2')];
    const reviewer = fakeReviewer({ people: ['1', '2'], failAccept: '1', closeFails: true });
    const events = [];
    const result = await runAcceptPass(
      {
        review: reviewer.review,
        recordAccepted: async () => {},
        sleep: async () => {},
        emit: (event) => events.push(event),
      },
      { jobId: JOB, jobTitle: 'Platform Engineer', records },
    );
    expect(result.stoppedBecause).toBe('unclear');
    expect(result.error).toContain('Could not confirm the accept');
    expect(events.at(-1)).toMatchObject({ type: 'accept_done', stoppedBecause: 'unclear' });
  });

  it('agrees with the bridge on the name of the teardown message', () => {
    // The bridge is a classic content script and carries the literal inline, as
    // it does for every other type. A divergence here is a teardown that is
    // never forwarded and a composer that is never closed - and nothing would
    // fail, because this pass swallows the refusal.
    const bridge = readFileSync(new URL('../src/content/bridge.js', import.meta.url), 'utf8');
    expect(bridge).toContain(`['${CX_CLOSE_REVIEWER}', 'CLOSE_REVIEWER']`);
  });
});
