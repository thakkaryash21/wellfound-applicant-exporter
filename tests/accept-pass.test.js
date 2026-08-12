import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  runAcceptPass,
  planAccepts,
  firstNameOf,
  resolveFirstName,
  sendOutcome,
  unresolvedReason,
  NOTHING_SENT,
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
// `failAccept` is the id whose send the page never confirms. `landed` is
// whether the message nevertheless went out - the question the driver cannot
// answer and the queue can. Nothing here models the post-accept DOM: it was
// never observed, so this fake reproduces only the outside view.
function fakeReviewer({
  people,
  // Called as each send lands, so a test can advance its own clock by exactly
  // the duration it wants that accept to have taken.
  onSend = null,
  failAccept = null,
  landed = false,
  // Whether the driver refused BEFORE the click. That is the certain half of
  // its contract and it carries the phrase; an unconfirmed send carries none.
  certain = false,
  closeFails = false,
} = {}) {
  const failing = new Set([failAccept].flat().filter(Boolean).map(String));
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
      if (onSend) onSend();
      if (failing.has(here.userId)) {
        if (certain) throw new Error(`The reviewer is showing somebody else; ${NOTHING_SENT}`);
        if (landed) queue.splice(index - 1, 1);
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
function harness({
  people,
  records,
  failAccept = null,
  landed = false,
  certain = false,
  checkQueue = null,
  // Absent means a caller that cannot reload, which is a supported shape: the
  // pass falls back to closing and opening the reviewer.
  reloadPage = false,
  // A reload that never comes back. The run controller's own reload does not
  // return until the page can answer for this job again, so its failure is a
  // page that never became ready - and this is that, in the panel's words.
  reloadFails = false,
  alreadyAccepted = [],
  now = null,
  onSend = null,
  signal,
  template,
  rand,
  limit,
} = {}) {
  const reviewer = fakeReviewer({ people, failAccept, landed, certain, onSend });
  const events = [];
  const ledger = [];
  const sleeps = [];
  const asked = [];
  const deps = {
    ...(checkQueue
      ? {
          checkQueue: async (userId) => {
            asked.push(userId);
            return checkQueue(userId);
          },
        }
      : {}),
    ...(reloadPage
      ? {
          // Logged beside the reviewer's own messages, because WHERE a reload
          // falls among them is the whole of what these tests assert: never
          // between a send and its outcome, always before a fresh read.
          reloadPage: async () => {
            reviewer.log.push({ type: 'RELOAD' });
            if (reloadFails) throw new Error('The Wellfound applicant list did not finish loading');
          },
        }
      : {}),
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
    ...(now ? { now } : {}),
  };
  const run = () =>
    runAcceptPass(deps, {
      jobId: JOB,
      jobTitle: 'Platform Engineer',
      records,
      alreadyAccepted,
      template,
      signal,
      ...(limit === undefined ? {} : { limit }),
    });
  return { run, reviewer, events, ledger, sleeps, asked };
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

// The defect the operator hit, at the level of the loop that has to survive it.
// A send whose DOM confirmation never arrives is not the end of what this
// extension knows: an accepted candidate leaves NEEDS_REVIEW, and the queue is
// already being read. So the pass asks, once, before it spends the one word
// that sends the operator to Wellfound.
describe('an unconfirmed send', () => {
  const three = ['1', '2', '3'];
  const rowsFor = (ids) => ids.map((id) => captured(id));

  it('books the accept and carries on when the queue says they are gone', async () => {
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: '1',
      landed: true,
      checkQueue: () => 'gone',
    });
    const result = await h.run();

    expect(h.asked).toEqual(['1']);
    expect(result).toMatchObject({ accepted: 3, failed: 0, stoppedBecause: 'finished' });
    // Ledger first, exactly as a confirmed accept is booked: an accept the
    // ledger does not know about gets sent a second time by a later run.
    expect(h.ledger.map((e) => e.userId)).toEqual(three);
    // One click each. This is the rule nothing may ever break.
    const sends = h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE);
    expect(sends.map((e) => e.expectedUserId)).toEqual(three);
  });

  it('writes accepted in the cell, not failed', async () => {
    const records = rowsFor(three);
    await harness({
      people: three,
      records,
      failAccept: '1',
      landed: true,
      checkQueue: () => 'gone',
    }).run();
    expect(records.map((r) => r.acceptStatus)).toEqual(new Array(3).fill(ACCEPT_STATUS.ACCEPTED));
  });

  it('says how it was settled, so a resolved run still leaves the evidence', async () => {
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: '1',
      landed: true,
      checkQueue: () => 'gone',
    });
    await h.run();
    expect(h.events.find((e) => e.type === 'accept_unconfirmed')).toMatchObject({ userId: '1' });
    expect(h.events.find((e) => e.type === 'accept_checked')).toMatchObject({ verdict: 'gone' });
    expect(h.events.find((e) => e.type === 'accept_candidate' && e.userId === '1')).toMatchObject({
      outcome: 'accepted',
      confirmedBy: 'queue',
    });
  });

  // The page's confirmation signal has just been demonstrably wrong. Carrying
  // on against it would be trusting a structure that has already failed once.
  it('refreshes the page before it reads the next candidate', async () => {
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: '1',
      landed: true,
      checkQueue: () => 'gone',
    });
    await h.run();
    const types = typesOf(h.reviewer.log);
    const settled = types.indexOf(CX.ACCEPT_CANDIDATE);
    const reopened = types.indexOf(CX_CLOSE_REVIEWER);
    expect(reopened).toBeGreaterThan(settled);
    expect(types[reopened + 1]).toBe(CX.OPEN_REVIEWER);
    // And it re-reads who is there rather than assuming position 1 holds the
    // next target, which is what makes a reopen unable to skip anybody.
    expect(types[reopened + 2]).toBe(CX.READ_CANDIDATE);
  });

  for (const [name, answer] of [
    ['still shows them', () => 'queued'],
    ['cannot answer', () => 'unknown'],
    ['fails outright', () => Promise.reject(new Error('Page did not respond in time'))],
  ]) {
    it(`stays unclear and stops when the queue ${name}`, async () => {
      const h = harness({
        people: three,
        records: rowsFor(three),
        failAccept: '1',
        checkQueue: answer,
      });
      const result = await h.run();
      expect(result).toMatchObject({ accepted: 0, failed: 1, stoppedBecause: 'unclear' });
      expect(h.ledger).toEqual([]);
      expect(h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE)).toHaveLength(1);
    });
  }

  // The check pages the whole collection, so it is by far the most expensive
  // thing this pass can do. It settles the failure that was actually observed -
  // one send - and a pass producing a second is a pass whose page state is
  // beyond what this module can reason about.
  it('asks at most once in a pass', async () => {
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: ['1', '2'],
      landed: true,
      checkQueue: () => 'gone',
    });
    const result = await h.run();
    expect(h.asked).toEqual(['1']);
    expect(result).toMatchObject({ accepted: 1, failed: 1, stoppedBecause: 'unclear' });
  });

  // The other half of the driver's contract. A refusal raised before the click
  // is certain - nothing went out - and asking the queue about it could only
  // produce a wrong answer, since the candidate is still in it either way.
  it('never asks about a send the driver refused before clicking', async () => {
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: '1',
      certain: true,
      checkQueue: () => 'gone',
    });
    const result = await h.run();
    expect(h.asked).toEqual([]);
    expect(result.stoppedBecause).toBe('error');
  });

  // A caller with no way to ask gets exactly the behaviour this pass had
  // before the check existed.
  it('is unclear, as before, when no queue check was given', async () => {
    const h = harness({ people: three, records: rowsFor(three), failAccept: '1', landed: true });
    expect(await h.run()).toMatchObject({ failed: 1, stoppedBecause: 'unclear' });
  });
});


// The second real run. The queue check refused to claim the send had landed,
// which was the right answer to the question it asked - and the wrong answer
// about the send, because the message went out while the check was still
// walking. One look establishes only where somebody was at that instant, and a
// send in flight puts them in the queue exactly as a send that never happened
// does.
describe('settling an unconfirmed send', () => {
  const three = ['1', '2', '3'];
  const rowsFor = (ids) => ids.map((id) => captured(id));

  // Answers in order, then the last one forever.
  const answers = (...seq) => {
    let i = 0;
    return () => seq[Math.min(i++, seq.length - 1)];
  };

  it('books the accept when a later look shows them gone', async () => {
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: '1',
      landed: true,
      checkQueue: answers('queued', 'queued', 'gone'),
    });
    const result = await h.run();

    expect(h.asked).toEqual(['1', '1', '1']);
    expect(result).toMatchObject({ accepted: 3, failed: 0, stoppedBecause: 'finished' });
    expect(h.ledger.map((e) => e.userId)).toEqual(three);
    // The rule nothing may ever break, across three looks and a minute of
    // waiting: one click each.
    const sends = h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE);
    expect(sends.map((e) => e.expectedUserId)).toEqual(three);
  });

  it('writes accepted in the cell for a send the queue settled late', async () => {
    const records = rowsFor(three);
    await harness({
      people: three,
      records,
      failAccept: '1',
      landed: true,
      checkQueue: answers('queued', 'gone'),
    }).run();
    expect(records.map((r) => r.acceptStatus)).toEqual(new Array(3).fill(ACCEPT_STATUS.ACCEPTED));
  });

  // Geometric, so the common case - it landed a moment later - costs the
  // operator five seconds, and only the genuinely stuck case spends the minute.
  it('waits longer before each look than before the last', async () => {
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: '1',
      checkQueue: () => 'queued',
    });
    await h.run();
    expect(h.sleeps.filter((ms) => ms >= 5000)).toEqual([5000, 15000, 30000]);
  });

  it('gives up only after the whole settle window, and stays unclear', async () => {
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: '1',
      checkQueue: () => 'queued',
    });
    const result = await h.run();
    expect(h.asked).toHaveLength(4);
    expect(result).toMatchObject({ accepted: 0, failed: 1, stoppedBecause: 'unclear' });
    expect(h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE)).toHaveLength(1);
  });

  // An operator who has pressed Stop is not waiting another minute to be told
  // something the run will report as unclear either way.
  it('stops looking when the operator presses stop', async () => {
    const controller = new AbortController();
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: '1',
      signal: controller.signal,
      checkQueue: () => {
        controller.abort();
        return 'queued';
      },
    });
    const result = await h.run();
    expect(h.asked).toHaveLength(1);
    expect(result.stoppedBecause).toBe('unclear');
  });

  // The wording. "Still queued after settling" is evidence and the operator can
  // act on it; "could not be read" is the absence of evidence and leaves them
  // where they were. The two used to read the same.
  describe('what the operator is told', () => {
    const original = 'Could not confirm the accept for 70000001.';

    it('says what the queue showed, and what it cannot prove', () => {
      const told = unresolvedReason(original, { verdict: 'queued', looks: 4, waitedMs: 50000 });
      expect(told).toContain(original);
      expect(told).toContain('4 times over the following 50s');
      expect(told).toContain('leans towards');
      expect(told).toContain('cannot prove');
    });

    it('says plainly when nothing was learnt at all', () => {
      const told = unresolvedReason(original, { verdict: 'unknown', looks: 4 });
      expect(told).toContain('nothing was learnt');
      expect(told).not.toContain('leans towards');
    });

    // The one word that sends the operator to Wellfound is decided from the
    // driver's own sentence. Nothing added afterwards may disturb it - an
    // appended phrase that happened to read as the driver's certainty mark
    // would turn an alarm into a shrug.
    it('never changes which of the two the driver said happened', () => {
      for (const verdict of ['queued', 'unknown', null]) {
        expect(sendOutcome(unresolvedReason(original, { verdict, looks: 4 }))).toBe('unclear');
      }
    });

    it('reaches the CSV cell and the run report', async () => {
      const records = rowsFor(three);
      const result = await harness({
        people: three,
        records,
        failAccept: '1',
        checkQueue: () => 'queued',
      }).run();
      expect(records[0].acceptStatus).toContain('leans towards');
      expect(result.error).toContain('leans towards');
    });
  });
});

// The page degrades underneath the modal across a long session, so the pass
// reloads it periodically. That is a deliberate destruction of the page context
// several times per pass, in the middle of an operation whose failure mode is
// messaging a real person twice or losing the record that they were messaged
// once - so it is treated as a fault to survive by construction.
describe('the periodic reload', () => {
  const nine = Array.from({ length: 9 }, (_, i) => String(70000001 + i));
  const rows = () => nine.map((id) => captured(id));
  // A fixed source, so the jittered cadence is a known number in a test rather
  // than a range. 0.5 draws the middle of every PACING band, which for
  // reloadEvery is six.
  const MIDDLE = () => 0.5;

  const reloadRun = (extra = {}) =>
    harness({ people: nine, records: rows(), reloadPage: true, rand: MIDDLE, ...extra });

  it('reloads the page on the cadence PACING draws, and only then', async () => {
    const h = reloadRun();
    const result = await h.run();
    expect(result).toMatchObject({ accepted: 9, stoppedBecause: 'finished' });
    const reloads = h.events.filter((e) => e.type === 'accept_reload');
    expect(reloads.map((e) => e.accepted)).toEqual([6]);
  });

  // Not a fixed number. The bounds live in PACING beside every other pace this
  // extension keeps, and the draw is redrawn each cycle through the same helper
  // the reading break uses.
  it('draws the cadence from PACING, within its stated bounds', async () => {
    const [min, max] = PACING.reloadEvery;
    expect(min).toBeLessThan(max);
    for (const rand of [() => 0.01, () => 0.99]) {
      const h = harness({ people: nine, records: rows(), reloadPage: true, rand });
      await h.run();
      const first = h.events.find((e) => e.type === 'accept_reload');
      expect(first.accepted).toBeGreaterThanOrEqual(min);
      expect(first.accepted).toBeLessThanOrEqual(max);
    }
  });

  // A reload throws the reviewer away, so nothing afterwards may assume
  // anything about who is on screen.
  it('closes, reloads, opens again and re-reads the position', async () => {
    const h = reloadRun();
    await h.run();
    const types = typesOf(h.reviewer.log);
    const at = types.indexOf('RELOAD');
    expect(types[at - 1]).toBe(CX_CLOSE_REVIEWER);
    expect(types[at + 1]).toBe(CX.OPEN_REVIEWER);
    expect(types[at + 2]).toBe(CX.READ_CANDIDATE);
  });

  it('is paced, not snapped', async () => {
    const h = reloadRun();
    await h.run();
    // The pause between letting go of the page and taking hold of it again is
    // drawn from the same PACING as the rest of the run.
    expect(h.events.filter((e) => e.type === 'resting' || e.type === 'break').length).toBeGreaterThan(
      9,
    );
  });

  // The reviewer is positional and a reload returns it to the front, so a pass
  // that has skipped anybody would walk those people again - re-reading them,
  // re-skipping them, and counting the skips twice.
  it('leaves a pass that has skipped somebody alone', async () => {
    const people = [nine[0], '99', ...nine.slice(1)];
    const h = harness({ people, records: rows(), reloadPage: true, rand: MIDDLE });
    const result = await h.run();
    expect(result).toMatchObject({ accepted: 9, skipped: 1 });
    expect(typesOf(h.reviewer.log)).not.toContain('RELOAD');
  });

  it('falls back to closing and opening when the caller cannot reload', async () => {
    const h = harness({ people: nine, records: rows(), rand: MIDDLE });
    const result = await h.run();
    expect(result).toMatchObject({ accepted: 9, stoppedBecause: 'finished' });
    expect(typesOf(h.reviewer.log)).not.toContain('RELOAD');
    expect(h.events.filter((e) => e.type === 'accept_reopen')).toHaveLength(1);
  });

  // The page could not vouch for that send, so the page is not trusted for
  // another one: the refresh is asked for now rather than at the next multiple
  // of the cadence.
  it('refreshes immediately after a send the queue had to settle', async () => {
    const h = harness({
      people: nine,
      records: rows(),
      reloadPage: true,
      rand: MIDDLE,
      failAccept: nine[0],
      landed: true,
      checkQueue: () => 'gone',
    });
    await h.run();
    expect(h.events.find((e) => e.type === 'accept_reload')).toMatchObject({ accepted: 1 });
  });
});

// The two rules whose failure costs a real person a duplicate message or an
// unrecorded one. Both are structural: an interlock that throws, not a
// convention about where a call site sits.
describe('a reload can never land inside an accept', () => {
  const nine = Array.from({ length: 9 }, (_, i) => String(70000001 + i));
  const rows = () => nine.map((id) => captured(id));
  const MIDDLE = () => 0.5;

  // Rule 1 and rule 2 in one assertion, because they are one window: from the
  // click to the ledger write there must be nothing else at all. A reload in
  // there destroys the only context that could say whether the message went
  // out, or leaves somebody messaged and unrecorded.
  it('nothing at all comes between a send and its ledger write', async () => {
    const h = harness({ people: nine, records: rows(), reloadPage: true, rand: MIDDLE });
    await h.run();
    const types = typesOf(h.reviewer.log);
    expect(types).toContain('RELOAD');
    types.forEach((type, i) => {
      if (type === CX.ACCEPT_CANDIDATE) expect(types[i + 1]).toBe('LEDGER');
    });
  });

  it('and the same holds for a send the queue settled afterwards', async () => {
    const h = harness({
      people: nine,
      records: rows(),
      reloadPage: true,
      rand: MIDDLE,
      failAccept: nine[0],
      landed: true,
      checkQueue: () => 'gone',
    });
    await h.run();
    const types = typesOf(h.reviewer.log);
    const send = types.indexOf(CX.ACCEPT_CANDIDATE);
    // The settling happens off this log - it is API traffic, not the page - so
    // the next thing the PAGE sees after the click is the ledger write, and the
    // reload only after that.
    expect(types[send + 1]).toBe('LEDGER');
    expect(types.indexOf('RELOAD')).toBeGreaterThan(send + 1);
  });

  it('every accepted person is in the ledger exactly once', async () => {
    const h = harness({ people: nine, records: rows(), reloadPage: true, rand: MIDDLE });
    const result = await h.run();
    expect(h.ledger.map((e) => e.userId)).toEqual(nine);
    expect(new Set(h.ledger.map((e) => e.userId)).size).toBe(result.accepted);
  });

  // Nobody is stepped over by a reload landing them back at position 1: the
  // loop re-reads who is actually there, so the walk is driven by the page
  // rather than by an index the pass remembers.
  it('messages everybody exactly once across a reload, and skips nobody', async () => {
    const h = harness({ people: nine, records: rows(), reloadPage: true, rand: MIDDLE });
    await h.run();
    const sent = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sent).toEqual(nine);
    expect(h.reviewer.queue).toEqual([]);
  });
});

// A reload that does not come back. The run controller's reload does not
// return until the page can answer for this job again, so this is a page that
// never became ready.
describe('a reload that never comes back', () => {
  const nine = Array.from({ length: 9 }, (_, i) => String(70000001 + i));
  const rows = () => nine.map((id) => captured(id));
  const MIDDLE = () => 0.5;

  const brokenRun = () => {
    const records = rows();
    const h = harness({
      people: nine,
      records,
      reloadPage: true,
      reloadFails: true,
      rand: MIDDLE,
    });
    return { h, records };
  };

  it('stops the run rather than carrying on against a dead page', async () => {
    const { h } = brokenRun();
    const result = await h.run();
    expect(result.stoppedBecause).toBe('error');
    expect(result.error).toContain('did not finish loading');
    // It stopped where the reload was due. Nothing was attempted afterwards.
    const types = typesOf(h.reviewer.log);
    expect(types.lastIndexOf(CX.ACCEPT_CANDIDATE)).toBeLessThan(types.indexOf('RELOAD'));
  });

  it('leaves the ledger holding exactly who was messaged, and nobody else', async () => {
    const { h } = brokenRun();
    const result = await h.run();
    const sent = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(h.ledger.map((e) => e.userId)).toEqual(sent);
    expect(result.accepted).toBe(sent.length);
  });

  it('says in the CSV what happened to everybody it never reached', async () => {
    const { h, records } = brokenRun();
    await h.run();
    const reached = new Set(h.ledger.map((e) => e.userId));
    for (const row of records) {
      expect(row.acceptStatus).toBe(
        reached.has(row.userId) ? ACCEPT_STATUS.ACCEPTED : ACCEPT_STATUS.NOT_REACHED,
      );
    }
  });
});

// Whatever interrupted the pass - a failed reload, a stop, a closed panel - the
// next attempt starts from the ledger, which was written per person as the pass
// went. Nobody already messaged may be messaged again.
describe('picking a broken pass up again', () => {
  const nine = Array.from({ length: 9 }, (_, i) => String(70000001 + i));
  const MIDDLE = () => 0.5;

  it('never messages anybody the first attempt already recorded', async () => {
    const first = harness({
      people: nine,
      records: nine.map((id) => captured(id)),
      reloadPage: true,
      reloadFails: true,
      rand: MIDDLE,
    });
    await first.run();
    const done = first.ledger.map((e) => e.userId);
    expect(done.length).toBeGreaterThan(0);
    expect(done.length).toBeLessThan(nine.length);

    // The second attempt sees the ledger and the drained queue, which are two
    // independent defences against a second message. The queue here has already
    // lost the accepted people, exactly as Wellfound's has.
    const second = harness({
      people: nine.filter((id) => !done.includes(id)),
      records: nine.map((id) => captured(id)),
      alreadyAccepted: done,
      reloadPage: true,
      rand: MIDDLE,
    });
    const result = await second.run();

    const sent = second.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    for (const id of done) expect(sent).not.toContain(id);
    // And it made progress: everybody left is messaged, so the two attempts
    // together cover the role exactly once.
    expect([...done, ...sent].sort()).toEqual([...nine].sort());
    expect(result).toMatchObject({ stoppedBecause: 'finished' });
  });

  // The ledger is not the only defence, and neither is trusted alone. A ledger
  // that lost its memory still cannot produce a second message for somebody
  // Wellfound has already removed from the queue, because the pass acts on who
  // the page says is there.
  it('does not message somebody the queue has already lost, ledger or no ledger', async () => {
    const h = harness({
      people: nine.slice(3),
      records: nine.map((id) => captured(id)),
      reloadPage: true,
      rand: MIDDLE,
    });
    await h.run();
    const sent = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sent).toEqual(nine.slice(3));
  });
});

// The 111-applicant role. How fast the page degrades scales with how much of
// the list it is holding, so a cadence counted in accepts cannot protect every
// size of role: five to seven never fired once on a run that died on its
// fourth accept. The pass already holds the one number that means the same
// thing whatever the role's size - how long the last accept took.
describe('a page that is slowing down', () => {
  const ten = Array.from({ length: 10 }, (_, i) => String(70000001 + i));

  // The measured shape, in the order it was measured: healthy, healthy, then
  // the accept that took thirty-six seconds. The clock only moves when this
  // says so, so the test is instant.
  function slowingClock(durations) {
    let at = 0;
    let sends = 0;
    return {
      now: () => at,
      // Called by the fake reviewer as each send lands, so the elapsed time the
      // pass measures is exactly the duration handed in for that accept.
      onSend: () => {
        at += durations[Math.min(sends, durations.length - 1)] ?? 1000;
        sends += 1;
      },
    };
  }

  function slowingRun(durations, { people = ten, ...extra } = {}) {
    const clock = slowingClock(durations);
    const h = harness({
      people,
      records: people.map((id) => captured(id)),
      reloadPage: true,
      now: clock.now,
      onSend: clock.onSend,
      // Well above the counted cadence, so nothing here can be the counter
      // firing: a reload in these tests is the slowness trigger or nothing.
      rand: () => 0.99,
      ...extra,
    });
    return h;
  }

  it('reloads after one slow accept rather than waiting for the counter', async () => {
    const h = slowingRun([8300, 7100, 35900, 6000, 6000, 6000]);
    const result = await h.run();
    expect(result).toMatchObject({ accepted: 10, stoppedBecause: 'finished' });

    const slow = h.events.filter((e) => e.type === 'accept_slow');
    expect(slow).toHaveLength(1);
    expect(slow[0].ms).toBe(35900);
    // Immediately after that accept, and before the fourth was attempted. On
    // the real run the fourth accept is where the relay's budget expired.
    const order = h.events
      .filter((e) => ['accept_candidate', 'accept_reload'].includes(e.type))
      .map((e) => e.type);
    expect(order.slice(0, 4)).toEqual([
      'accept_candidate',
      'accept_candidate',
      'accept_candidate',
      'accept_reload',
    ]);
  });

  // The threshold has to sit clear of both bounds it was chosen between: far
  // enough above the healthy band not to fire on ordinary variation, and far
  // enough below the relay's 45s budget to act a whole accept early.
  it('ignores the healthy band, and fires well inside the relay budget', async () => {
    // Six accepts, under a counted cadence of seven, so nothing but slowness
    // could produce a reload here.
    const healthy = slowingRun([9000, 9000, 9000, 9000, 9000, 9000], { people: ten.slice(0, 6) });
    await healthy.run();
    expect(healthy.events.filter((e) => e.type === 'accept_slow')).toHaveLength(0);
    expect(healthy.events.filter((e) => e.type === 'accept_reload')).toHaveLength(0);

    // 20s trips it; the relay gives up at 45s, so the reload happens with more
    // than half the budget still unspent.
    const slowing = slowingRun([9000, 20000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000]);
    await slowing.run();
    const slow = slowing.events.filter((e) => e.type === 'accept_slow');
    expect(slow).toHaveLength(1);
    expect(slow[0].ms).toBeLessThan(45000);
  });

  // Everything the reload already promised still holds when slowness is what
  // asked for it.
  it('still reloads only between candidates, with the ledger already written', async () => {
    const h = slowingRun([8300, 7100, 35900, 6000, 6000, 6000]);
    await h.run();
    const types = typesOf(h.reviewer.log);
    types.forEach((type, i) => {
      if (type === CX.ACCEPT_CANDIDATE) expect(types[i + 1]).toBe('LEDGER');
    });
    const at = types.indexOf('RELOAD');
    expect(types[at - 1]).toBe(CX_CLOSE_REVIEWER);
    expect(types[at + 1]).toBe(CX.OPEN_REVIEWER);
    expect(types[at + 2]).toBe(CX.READ_CANDIDATE);
  });

  it('messages everybody exactly once, and skips nobody, across a slow patch', async () => {
    const h = slowingRun([8300, 7100, 35900, 40000, 6000, 6000]);
    await h.run();
    const sent = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sent).toEqual(ten);
    expect(h.ledger.map((e) => e.userId)).toEqual(ten);
  });

  // A page can rot without getting slower, so the operator's counted cadence
  // stays as the backstop it was.
  it('keeps the counted cadence for a page that degrades without slowing', async () => {
    const h = slowingRun([6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000], {
      rand: () => 0.5,
    });
    await h.run();
    expect(h.events.filter((e) => e.type === 'accept_slow')).toHaveLength(0);
    expect(h.events.filter((e) => e.type === 'accept_reload')).toHaveLength(1);
  });
});
