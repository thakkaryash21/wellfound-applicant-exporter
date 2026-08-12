import { describe, it, expect } from 'vitest';
import { runAcceptPass, planAccepts, firstNameOf } from '../src/panel/accept-pass.js';
import { ACCEPT_STATUS, RESUME_STATUS } from '../src/lib/csv.js';
import { CX } from '../src/lib/messages.js';

const JOB = '9100001';

// The reviewer as it was measured on the live page, and only as it was
// measured: a QUEUE, not a list. A confirmed accept removes the candidate and
// leaves the index alone (1 of 116 -> 1 of 115); a skip advances the index and
// leaves the total alone (1 of 115 -> 2 of 115). Every message the pass sends
// is logged, because half of what these tests assert is what was NOT sent.
function fakeReviewer({ people, failAccept = null } = {}) {
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
    if (!opened) throw new Error('The reviewer is not open');
    if (message.type === CX.READ_CANDIDATE) return at();
    if (message.type === CX.SKIP_CANDIDATE) {
      index += 1;
      return at();
    }
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

  return { review, log, queue };
}

const captured = (userId, name = `Person ${userId}`) => ({
  userId,
  name,
  resumeStatus: RESUME_STATUS.DOWNLOADED,
});

// One row per person, in the shape pass 1 leaves behind.
function harness({ people, records, failAccept = null, signal, template } = {}) {
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
  };
  const run = () =>
    runAcceptPass(deps, {
      jobId: JOB,
      jobTitle: 'Platform Engineer',
      records,
      alreadyAccepted: [],
      template,
      signal,
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
});

describe('firstNameOf', () => {
  it('takes the first word, and nothing at all from an empty name', () => {
    expect(firstNameOf('Jane Q. Doe')).toBe('Jane');
    expect(firstNameOf(null)).toBe('');
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
});
