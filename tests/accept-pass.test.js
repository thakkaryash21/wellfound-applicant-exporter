import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  runAcceptPass,
  planAccepts,
  firstNameOf,
  resolveFirstName,
  sendOutcome,
  unresolvedReason,
  guardReload,
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
  // The shape the live 101-applicant role produced, and the one the fast path
  // deliberately no longer tries to cover: the click lands, the driver's own
  // window runs out, and the page catches up some looks later. The driver hands
  // this back as `pending` rather than throwing, so `slowAccept` is NOT a
  // failure - it is an ordinary slow accept, and the pass is expected to book
  // it as one.
  slowAccept = null,
  // How many position reads happen before the page shows the send. Each read is
  // one wait in the pass's watch, so 3 here is an accept that lands about 30s
  // after the click and 6 is one that lands around 125s.
  landsAfterLooks = 2,
  // The half-signal, and the reason the watch's predicate has two halves. While
  // a send is outstanding the reviewer MOVES - somebody else is on screen - but
  // the bucket does not drain. That is the shape of a skip, not of a send, and
  // a watch that took a changed candidate as proof would book a message that
  // never went out. Measured on the live page as two different signals; this is
  // the fake refusing to let one stand in for the other.
  drifts = false,
  // The other half-signal, and the mirror of `drifts`: the bucket DRAINS while
  // a send is outstanding, but somebody else is what left it - a human working
  // the same queue by hand, an application expiring - and the candidate this
  // pass is waiting on is still on screen. A watch that took a dropped total
  // alone as proof would book that person's message as delivered on the
  // strength of a stranger leaving.
  drainsElsewhere = false,
  brokenSkips = 0,
  brokenSkipAt = null,
} = {}) {
  const failing = new Set([failAccept].flat().filter(Boolean).map(String));
  const slow = new Set([slowAccept].flat().filter(Boolean).map(String));
  // Sends the page has taken but not yet shown, and how many reads are left
  // before it does.
  const inFlight = new Map();
  const queue = people.map(String);
  const log = [];
  let index = 1;
  let opened = false;
  let brokenSkipsLeft = brokenSkips;
  let skipAttempts = 0;

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
    if (message.type === CX.READ_CANDIDATE) {
      // The page catching up, one read at a time. This is the only place a
      // slow send becomes visible, which is what makes the pass's watch the
      // thing under test rather than the fake's generosity.
      if (drifts && inFlight.size > 0) {
        // Somebody else on screen, the same number of people in the bucket.
        queue.push(queue.shift());
        return at();
      }
      if (drainsElsewhere && inFlight.size > 0 && queue.length > 1) {
        // The bucket shrinks behind the person still on screen.
        queue.splice(1, 1);
        return at();
      }
      for (const [id, left] of inFlight) {
        if (left > 1) {
          inFlight.set(id, left - 1);
          continue;
        }
        inFlight.delete(id);
        const spot = queue.indexOf(id);
        if (spot !== -1) queue.splice(spot, 1);
      }
      return at();
    }
    if (message.type === CX.SKIP_CANDIDATE) {
      skipAttempts += 1;
      if (brokenSkipsLeft > 0 && (brokenSkipAt === null || skipAttempts >= brokenSkipAt)) {
        brokenSkipsLeft -= 1;
        throw new Error('Could not find the Next applicant control (1 matched by text, none usable)');
      }
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
      if (slow.has(here.userId)) {
        // Clicked, taken by the page, and not yet shown. Exactly what the
        // driver returns when its fast path runs out.
        inFlight.set(here.userId, landsAfterLooks);
        return {
          userId: here.userId,
          accepted: false,
          pending: true,
          total: queue.length,
          reason:
            `Could not confirm the accept for ${here.userId}. It may or may not have been ` +
            'sent - check the candidate in Wellfound before running again. Nothing was retried.',
        };
      }
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
  slowAccept = null,
  landsAfterLooks = 2,
  drifts = false,
  drainsElsewhere = false,
  brokenSkips = 0,
  brokenSkipAt = null,
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
  // The userId whose ledger write rejects, and what it says. The realistic
  // trigger is Chrome reloading the extension mid-run, which severs
  // chrome.storage.local while the panel's promise chain is still live.
  ledgerFails = null,
  provisionalFails = null,
  ledgerError = 'Extension context invalidated.',
  // Questions a previous run left in the ledger with nobody to answer them.
  heldOver = [],
  // Called with the userId as the ledger write BEGINS, so a test can read what
  // the pass has and has not done at that exact moment.
  onLedger = null,
  signal,
  template,
  rand,
  limit,
} = {}) {
  const reviewer = fakeReviewer({
    people,
    failAccept,
    slowAccept,
    landsAfterLooks,
    drifts,
    drainsElsewhere,
    brokenSkips,
    brokenSkipAt,
    landed,
    certain,
    onSend,
  });
  const events = [];
  const ledger = [];
  // What the ledger holds that is a question rather than a claim, and who a
  // sweep decided was never messaged at all.
  const provisional = [];
  const released = [];
  const sleeps = [];
  const asked = [];
  // `'page'` is the honest fake: the API and the reviewer are two views of one
  // collection, so the queue answers from the same list the modal is showing.
  // A fixed answer is still available for the cases that are ABOUT disagreement
  // between them.
  const answerQueue =
    checkQueue === 'page'
      ? async (userId) => (reviewer.queue.includes(String(userId)) ? 'queued' : 'gone')
      : checkQueue;
  const deps = {
    ...(answerQueue
      ? {
          checkQueue: async (userId) => {
            asked.push(userId);
            return answerQueue(userId);
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
    recordProvisional: async (jobId, userId) => {
      reviewer.log.push({ type: 'PROVISIONAL', userId });
      if (provisionalFails !== null && String(provisionalFails) === String(userId)) {
        throw new Error(ledgerError);
      }
      provisional.push(String(userId));
    },
    confirmAccepted: async (jobId, userId) => {
      reviewer.log.push({ type: 'CONFIRM', userId });
      if (onLedger) onLedger(String(userId));
      if (ledgerFails !== null && String(ledgerFails) === String(userId)) {
        throw new Error(ledgerError);
      }
      provisional.splice(provisional.indexOf(String(userId)), 1);
      ledger.push({ jobId, userId });
    },
    releaseAccepted: async (jobId, userId) => {
      reviewer.log.push({ type: 'RELEASE', userId });
      const at = provisional.indexOf(String(userId));
      if (at !== -1) provisional.splice(at, 1);
      released.push(String(userId));
    },
    listProvisional: async () => heldOver,
    recordAccepted: async (jobId, userId) => {
      // Written into the same log the reviewer writes to, so the ORDER of a
      // ledger write against the next reviewer message is assertable.
      reviewer.log.push({ type: 'LEDGER', userId });
      // Read BEFORE the write is allowed to succeed or fail: the ordering rule
      // is about what the pass has already done to its own state by the time it
      // reaches here, and that is invisible in any message log.
      if (onLedger) onLedger(String(userId));
      if (ledgerFails !== null && String(ledgerFails) === String(userId)) {
        throw new Error(ledgerError);
      }
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
  return { run, reviewer, events, ledger, sleeps, asked, provisional, released };
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

  // Rule 4. An unclear outcome is never retried, and with no way left to ask
  // about it the pass stops rather than sending into a page it cannot read.
  // What it does NOT do any more is forget the person: they go into the ledger
  // first, which is the only thing that stops the next attempt reaching them.
  it('stops on an unclear send, retries nothing, and touches nobody after it', async () => {
    const records = [captured('1'), captured('2')];
    const { run, reviewer, ledger, events, provisional } = harness({
      people: ['1', '2'],
      records,
      failAccept: '1',
    });
    const result = await run();

    expect(result.stoppedBecause).toBe('unclear');
    expect(result.accepted).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(result.failed).toBe(0);
    expect(reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE)).toHaveLength(1);
    expect(typesOf(reviewer.log)).not.toContain(CX.SKIP_CANDIDATE);
    // A question, not a claim: the send is in the provisional map, and nothing
    // has been written into the accepted one.
    expect(provisional).toEqual(['1']);
    expect(ledger).toEqual([]);
    expect(records[0].acceptStatus).toMatch(/^unresolved: /);
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
  // What the ledger holds that is a question rather than a claim, and who a
  // sweep decided was never messaged at all.
  const provisional = [];
  const released = [];
    const result = await runAcceptPass(
      {
        review: async (message) => {
          if (message.type === CX.ACCEPT_CANDIDATE) {
            throw new Error('The response composer did not open; nothing was sent');
          }
          return reviewer.review(message);
        },
        recordAccepted: async () => ledger.push(1),
        recordProvisional: async () => provisional.push(1),
        confirmAccepted: async () => ledger.push(1),
        releaseAccepted: async () => provisional.splice(0),
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

  it('refuses to arm when no provisional ledger writer was supplied', async () => {
    const records = [captured('1')];
    const reviewer = fakeReviewer({ people: ['1'] });
    const result = await runAcceptPass(
      {
        review: reviewer.review,
        recordAccepted: async () => {},
        sleep: async () => {},
        emit: () => {},
      },
      { jobId: JOB, jobTitle: 'Platform Engineer', records },
    );
    expect(result.stoppedBecause).toBe('error');
    expect(result.error).toMatch(/provisional ledger writer.*nothing was sent/i);
    expect(typesOf(reviewer.log)).not.toContain(CX.ACCEPT_CANDIDATE);
  });

  // Rule 5. The ledger write lands before anything else can interrupt - an
  // accept the ledger does not know about is a second message to a stranger.
  it('records the accept before it reads the next candidate', async () => {
    const records = [captured('1'), captured('2')];
    const { run, reviewer } = harness({ people: ['1', '2'], records });
    await run();

    const order = typesOf(reviewer.log);
    const firstAccept = order.indexOf(CX.ACCEPT_CANDIDATE);
    const provisional = order.indexOf('PROVISIONAL');
    const confirmed = order.indexOf('CONFIRM');
    const nextRead = order.indexOf(CX.READ_CANDIDATE, firstAccept);
    expect(provisional).toBeLessThan(firstAccept);
    expect(confirmed).toBeGreaterThan(firstAccept);
    expect(confirmed).toBeLessThan(nextRead);
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
        recordProvisional: async () => {},
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
        recordProvisional: async () => {},
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
        recordProvisional: async () => {},
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

  it('closes it after a refusal raised before Send was armed', async () => {
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
        recordProvisional: async () => {},
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
        recordProvisional: async () => {},
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
        recordProvisional: async () => {},
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
        recordProvisional: async () => {},
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

  // The two answers that are not `gone` are not the same answer, and the pass
  // no longer treats them as one. `queued` is what a page that is merely slow
  // looks like: the candidate is exactly where a send in flight leaves them,
  // and the API answered, so both instruments still work. Everything else means
  // the pass has lost the only instrument it had left.
  for (const [name, answer] of [
    ['cannot answer', () => 'unknown'],
    ['fails outright', () => Promise.reject(new Error('Page did not respond in time'))],
  ]) {
    it(`stops on the spot when the queue ${name}`, async () => {
      const h = harness({
        people: three,
        records: rowsFor(three),
        failAccept: '1',
        checkQueue: answer,
      });
      const result = await h.run();
      expect(result).toMatchObject({ accepted: 0, unresolved: 1, stoppedBecause: 'unclear' });
      // A question is written before anything else, even here: it is what stops
      // the next attempt reaching this person while nobody knows, and the pass
      // being about to give up is not a reason to leave them unprotected. It is
      // NOT an accept - nothing has vouched for this send.
      expect(h.provisional).toEqual(['1']);
      expect(h.ledger).toEqual([]);
      expect(h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE)).toHaveLength(1);
    });
  }

  // The other half of the driver's contract. A refusal raised before the click
  // is certain - nothing went out - and asking the queue about it could only
  // produce a wrong answer, since the candidate is still in it either way. It
  // is also the one failure that leaves NO ledger entry: there is nothing to
  // remember.
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
    expect(result).toMatchObject({ failed: 1, unresolved: 0, stoppedBecause: 'error' });
    expect(h.ledger).toEqual([]);
  });

  // A caller with no way to ask has no way to carry on either, so the pass
  // stops exactly as it did before the check existed - but the person is
  // written down, which is the part that did not exist before.
  it('stops, and still records them, when no queue check was given', async () => {
    const h = harness({ people: three, records: rowsFor(three), failAccept: '1', landed: true });
    expect(await h.run()).toMatchObject({ unresolved: 1, stoppedBecause: 'unclear' });
    expect(h.provisional).toEqual(['1']);
    expect(h.ledger).toEqual([]);
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
    // Everyone accepted, and nothing left as a question.
    expect(h.ledger.map((e) => e.userId).sort()).toEqual(three);
    expect(h.provisional).toEqual([]);
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

  // Shorter than it was, twice over. By the time the queue is asked at all the
  // pass has already watched the page for up to 125s, so there is nothing left
  // for a settle window to wait out - the growing waits now live in the watch,
  // where they cost no requests.
  it('does not wait the page out twice', async () => {
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: '1',
      checkQueue: () => 'queued',
    });
    await h.run();
    expect(h.sleeps.filter((ms) => ms >= 5000)).toEqual([15000, 15000, 45000, 90000]);
  });

  it('defers rather than concluding when the window runs out', async () => {
    const h = harness({
      people: three,
      records: rowsFor(three),
      failAccept: '1',
      checkQueue: () => 'queued',
    });
    const result = await h.run();
    // Two looks on the spot, then the sweep asks again once the pass is over.
    expect(h.asked.length).toBeGreaterThan(2);
    // And it carries on: the two behind the deferral are accepted, which is
    // exactly what the old settle window cost the operator. The deferral itself
    // is released by the sweep - still queued after all of it means the send
    // never happened - so it ends as a failure and not as a question.
    expect(result).toMatchObject({ accepted: 2, failed: 1, unresolved: 0 });
    expect(h.released).toEqual(['1']);
    // One click each, and never a second to the deferred one.
    const sends = h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE);
    expect(sends.map((e) => e.expectedUserId)).toEqual(three);
  });

  // An operator who has pressed Stop is not waiting another two minutes. One
  // look still happens on the way out: it is a single query, it cannot send
  // anything, and if it comes back `gone` the run books a correct accept
  // instead of leaving a person unresolved.
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
    expect(h.asked).toHaveLength(2);
    expect(result.stoppedBecause).toBe('unclear');
    expect(h.sleeps.filter((ms) => ms >= 15000)).toEqual([]);
  });

  // The wording, and the sentence this whole change exists to stop printing.
  // "Still queued" read as evidence the message never left. It was reasonable
  // and it was wrong twice: this page commits an accept minutes after the
  // click, and the candidate sits in the queue throughout looking exactly like
  // somebody who was never messaged.
  describe('what the operator is told', () => {
    const original = 'Could not confirm the accept for 70000001.';

    it('says what the queue showed without reading it as evidence either way', () => {
      const told = unresolvedReason(original, { verdict: 'queued', looks: 4, waitedMs: 50000 });
      expect(told).toContain(original);
      expect(told).toContain('4 times over the following 50s');
      expect(told).toContain('not evidence the message never left');
      expect(told).not.toContain('leans towards');
    });

    it('says plainly when nothing was learnt at all', () => {
      const told = unresolvedReason(original, { verdict: 'unknown', looks: 4 });
      expect(told).toContain('nothing was learnt');
    });

    // The promise that replaces the guess. Whatever the queue said, the one
    // thing this pass can state outright is that nobody will be messaged again.
    it('always says they are recorded, whatever the queue answered', () => {
      for (const verdict of ['queued', 'unknown', null]) {
        expect(unresolvedReason(original, { verdict, looks: 1 })).toContain(
          'nothing will prepare them again while that stands',
        );
      }
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
      // `unknown` is the answer that leaves the question open. `queued` no
      // longer does - see the release, below.
      const result = await harness({
        people: three,
        records,
        failAccept: '1',
        checkQueue: () => 'unknown',
      }).run();
      expect(records[0].acceptStatus).toMatch(/^unresolved: /);
      expect(records[0].acceptStatus).toContain('nothing will prepare them again while that');
      expect(result.error).toContain('nothing will prepare them again while that');
    });
  });
});

// The defect this round fixes, and the two populations that made it visible.
//
// One run left two deferrals. Checked against the API afterwards, one had left
// NEEDS_REVIEW - the send landed, slowly - and the other was still queued forty
// minutes later, because nothing had been sent to them at all. The pass wrote
// BOTH into the ledger as accepted, so the second person was permanently
// written off by a run that had failed to message them.
describe('the two kinds of deferral', () => {
  const four = ['70000001', '70000002', '70000003', '70000004'];
  const rowsFor = (ids) => ids.map((id) => captured(id));

  // Answers in order, then the last one forever.
  const answers = (...seq) => {
    let i = 0;
    return () => seq[Math.min(i++, seq.length - 1)];
  };

  // The slow success. Still queued through the settle window - so it really
  // does become a deferral, rather than being resolved on the spot - and gone
  // by the time the sweep asks at the end of the role.
  it('books a deferral the sweep finds gone, permanently', async () => {
    const records = rowsFor(four);
    const h = harness({
      people: four,
      records,
      failAccept: four[0],
      landed: true,
      checkQueue: answers('queued', 'queued', 'gone'),
    });
    const result = await h.run();
    // It was a deferral first, which is the state this test is about.
    expect(h.events.some((e) => e.type === 'accept_candidate' && e.outcome === 'deferred')).toBe(
      true,
    );

    expect(result).toMatchObject({ accepted: 4, unresolved: 0, failed: 0 });
    // Out of the questions and into the accepts, where it is final.
    expect(h.provisional).toEqual([]);
    expect(h.released).toEqual([]);
    expect(h.ledger.map((e) => e.userId)).toContain(four[0]);
    expect(records[0].acceptStatus).toBe(ACCEPT_STATUS.ACCEPTED);
  });

  // The outright failure. Still queued through the whole sweep, which is what
  // a send that never happened looks like and what a landed one never does.
  it('releases a deferral the sweep still finds queued, leaving them eligible', async () => {
    const records = rowsFor(four);
    const h = harness({
      people: four,
      records,
      failAccept: four[0],
      landed: false,
      checkQueue: () => 'queued',
    });
    const result = await h.run();

    // Not accepted, not unresolved. Nothing was sent to them.
    expect(result).toMatchObject({ unresolved: 0, failed: 1 });
    expect(h.released).toEqual([four[0]]);
    // The question is gone and NOTHING was written in its place. That is what
    // makes them eligible again.
    expect(h.provisional).toEqual([]);
    expect(h.ledger.map((e) => e.userId)).not.toContain(four[0]);
    expect(records[0].acceptStatus).toMatch(/^failed: /);
    expect(records[0].acceptStatus).toContain('nothing went out to them');
  });

  // The run this changed. Ten of seventy-four accepted, and then the pass ended
  // reporting `error` - because one deferral had been released.
  //
  // That is backwards. A release is the most recoverable state this system has:
  // no message went out, no claim was made, the person is untouched and stays in
  // the queue for the next run. The outcome that ends a pass is the one where
  // somebody MAY have been messaged, and a release is precisely the outcome
  // where nobody was.
  it('finishes the role after releasing somebody, and attempts everyone behind them', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => String(70000001 + i));
    const records = twelve.map((id) => captured(id));
    const h = harness({
      people: twelve,
      records,
      // The release lands on the FIRST candidate, so everybody who comes after
      // them is only reached if the pass carried on.
      failAccept: twelve[0],
      checkQueue: () => 'queued',
    });
    const result = await h.run();

    // The role finished. It did not stop, and nothing about it is an error.
    expect(result.stoppedBecause).toBe('finished');
    expect(result.stoppedBecause).not.toBe('error');
    // Every remaining candidate was attempted, not abandoned behind the one
    // that could not be confirmed.
    const sends = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sends).toEqual(twelve);
    expect(result).toMatchObject({ accepted: 11, failed: 1, unresolved: 0 });
    // And the released person is eligible, not written off.
    expect(h.released).toEqual([twelve[0]]);
    expect(h.ledger.map((e) => e.userId)).not.toContain(twelve[0]);
  });

  // The bound that actually stopped that run, and why counting these was wrong:
  // a send the queue settles is a SUCCESS. Four of the five unconfirmed sends on
  // that role were resolved on the spot and booked as ordinary accepts; the
  // ceiling counted them anyway and stopped the pass on the fifth.
  it('does not stop because several sends needed the queue to settle them', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => String(70000001 + i));
    // The live sequence, exactly: four unconfirmed sends that the queue settles
    // on the spot - ordinary accepts, every one - and then a fifth that becomes
    // a deferral. The old ceiling counted all five and stopped on the fifth.
    const settled = [twelve[0], twelve[1], twelve[2], twelve[3]];
    const deferredOne = twelve[4];
    const h = harness({
      people: twelve,
      records: twelve.map((id) => captured(id)),
      failAccept: [...settled, deferredOne],
      landed: true,
      checkQueue: (id) => (String(id) === deferredOne ? 'queued' : 'gone'),
    });
    const result = await h.run();

    // Five sends the page could not confirm, and the role still finished.
    expect(h.events.filter((e) => e.type === 'accept_unconfirmed')).toHaveLength(5);
    expect(result.stoppedBecause).toBe('finished');
    expect(h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE)).toHaveLength(12);
    // Four of them were successes, and only the fifth was a release.
    expect(result).toMatchObject({ accepted: 11, failed: 1 });
    expect(h.released).toEqual([deferredOne]);
  });

  // Both at once, which is the run as it actually happened.
  it('tells the two apart in the same pass', async () => {
    const records = rowsFor(four);
    const h = harness({
      people: four,
      records,
      failAccept: [four[0], four[1]],
      checkQueue: (id) => (String(id) === four[0] ? 'gone' : 'queued'),
    });
    await h.run();
    expect(h.ledger.map((e) => e.userId)).toContain(four[0]);
    expect(h.released).toEqual([four[1]]);
    expect(records[0].acceptStatus).toBe(ACCEPT_STATUS.ACCEPTED);
    expect(records[1].acceptStatus).toMatch(/^failed: /);
  });

  // The rule that did not change, and the one the release could most easily
  // have broken. A released person is eligible for a LATER run; nothing may
  // reach them again inside this one.
  it('never sends to a released person again within the same pass', async () => {
    const h = harness({
      people: four,
      records: rowsFor(four),
      failAccept: four[0],
      checkQueue: () => 'queued',
    });
    await h.run();
    const sends = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sends.filter((id) => id === four[0])).toHaveLength(1);
    expect(sends).toEqual(four);
  });

  // And the point of releasing at all: the next run may try them.
  it('leaves a released person a target for the next run', async () => {
    const first = harness({
      people: four,
      records: rowsFor(four),
      failAccept: four[0],
      checkQueue: () => 'queued',
    });
    await first.run();

    const records = rowsFor(four);
    const second = harness({
      people: four,
      records,
      // Everything the first run actually established: the accepts it made,
      // and no entry at all for the person it released.
      alreadyAccepted: first.ledger.map((e) => e.userId),
      checkQueue: () => 'gone',
    });
    await second.run();
    const sends = second.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sends).toEqual([four[0]]);
    expect(records[0].acceptStatus).toBe(ACCEPT_STATUS.ACCEPTED);
  });

  // A sweep the operator cut short has not asked its question: the conclusion
  // rests on the whole interval, not on whichever look happened to be last.
  // Releasing on that would write off somebody whose send was simply still
  // going out.
  it('releases nobody when the sweep is cut short by a stop', async () => {
    const controller = new AbortController();
    const h = harness({
      people: four,
      records: rowsFor(four),
      failAccept: four[0],
      signal: controller.signal,
      checkQueue: () => {
        controller.abort();
        return 'queued';
      },
    });
    const result = await h.run();
    expect(h.released).toEqual([]);
    expect(h.provisional).toEqual([four[0]]);
    expect(result.unresolved).toBe(1);
  });
});

// A run that dies before its sweep leaves questions behind. They are answerable
// later - a landed send has left the queue and stays gone, a failed one leaves
// the person queued indefinitely - so the next pass over that role asks them,
// before it plans anything.
describe('questions a previous run left behind', () => {
  const four = ['70000001', '70000002', '70000003', '70000004'];
  const rowsFor = (ids) => ids.map((id) => captured(id));

  it('books a held-over entry the queue now says is gone, and messages nobody twice', async () => {
    const records = rowsFor(four);
    const h = harness({
      people: four.slice(1),
      records,
      heldOver: [four[0]],
      checkQueue: () => 'gone',
    });
    await h.run();
    expect(h.ledger.map((e) => e.userId)).toContain(four[0]);
    expect(records[0].acceptStatus).toBe(ACCEPT_STATUS.ALREADY);
    const sends = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sends).not.toContain(four[0]);
  });

  it('releases a held-over entry the queue still shows, and tries them', async () => {
    const records = rowsFor(four);
    const h = harness({
      people: four,
      records,
      heldOver: [four[0]],
      checkQueue: () => 'queued',
    });
    await h.run();
    expect(h.released).toContain(four[0]);
    const sends = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sends).toContain(four[0]);
    expect(records[0].acceptStatus).toBe(ACCEPT_STATUS.ACCEPTED);
  });

  // The third answer, and the reason it is not folded into either of the other
  // two: a queue that could not be read has taught this run nothing, so the
  // person is neither messaged nor written off.
  it('holds one it still cannot resolve, and does not message them', async () => {
    const records = rowsFor(four);
    const h = harness({
      people: four,
      records,
      heldOver: [four[0]],
      checkQueue: () => 'unknown',
    });
    const result = await h.run();
    expect(h.released).toEqual([]);
    expect(records[0].acceptStatus).toBe(ACCEPT_STATUS.UNRESOLVED);
    expect(result.unresolved).toBe(1);
    const sends = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sends).not.toContain(four[0]);
  });

  // The property that makes dying safe. A pass that never reaches its sweep
  // must not have claimed anything about anybody.
  it('claims nothing permanent about a deferral when the pass dies first', async () => {
    const h = harness({
      people: four,
      records: rowsFor(four),
      failAccept: four[0],
      // The reviewer breaks straight after the deferral, so the walk throws and
      // the pass unwinds without a queue it can ask.
      checkQueue: null,
    });
    const result = await h.run();
    expect(result.stoppedBecause).toBe('unclear');
    // In the questions, not in the accepts. A later run can still resolve this
    // person either way; nothing has been forfeited.
    expect(h.provisional).toEqual([four[0]]);
    expect(h.ledger.map((e) => e.userId)).not.toContain(four[0]);
  });
});

// The 101-applicant role, where every accept is slow and none of them is a
// symptom of anything.
//
// 98 targets, accepts measured at 25-66s, and the slow ones happening on
// documents reloaded seconds earlier - so it is not degradation and no reload
// recovers it. Against a fast path that decided the outcome, a large fraction
// of the role came back unconfirmed, each one spent a deferral, and two
// deferrals ended the pass. The role could never finish; it stopped at 16 of
// 98.
//
// What this describe asserts is that a role of nothing but slow accepts now
// completes, and completes WITHOUT spending anything scarce on it: no
// deferrals, no queue walks, no reloads asked for by the slowness.
describe('a role where every accept is slow', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => String(70000001 + i));
  const rowsFor = (ids) => ids.map((id) => captured(id));

  // Every accept takes the fast path's window and then some, exactly as the
  // real role did. `landsAfterLooks: 2` is a send the page shows on the second
  // look, which the watch reaches after 15s of waiting.
  const wholeSlowRole = (extra = {}) =>
    harness({
      people: twelve,
      records: rowsFor(twelve),
      slowAccept: twelve,
      landsAfterLooks: 2,
      checkQueue: 'page',
      ...extra,
    });

  it('finishes the whole role', async () => {
    const h = wholeSlowRole();
    const result = await h.run();
    expect(result).toMatchObject({
      accepted: 12,
      unresolved: 0,
      failed: 0,
      stoppedBecause: 'finished',
    });
    // One click each, twelve times over. The rule nothing may ever break.
    const sends = h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE);
    expect(sends.map((e) => e.expectedUserId)).toEqual(twelve);
    expect(h.ledger.map((e) => e.userId)).toEqual(twelve);
  });

  it('books them as ordinary accepts, not as rescues', async () => {
    const records = rowsFor(twelve);
    const h = wholeSlowRole({ records });
    await h.run();
    expect(records.map((r) => r.acceptStatus)).toEqual(new Array(12).fill(ACCEPT_STATUS.ACCEPTED));
    // Nobody was deferred, so nobody is in limbo and the operator is asked to
    // check nothing.
    expect(
      h.events.filter((e) => e.type === 'accept_candidate' && e.outcome === 'deferred'),
    ).toHaveLength(0);
    // One send reached the queue rung - the last candidate, whom the page
    // cannot show - and it resolved there. Eleven of the twelve never got
    // further than the watch, which costs nothing.
    expect(h.events.filter((e) => e.type === 'accept_unconfirmed')).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'accept_pending')).toHaveLength(12);
  });

  // The cost, which is the whole argument for watching the page rather than
  // asking Wellfound. A position read is a DOM read inside the page; it is not
  // a request. Twelve slow accepts spend one question between them, and that
  // one is not about slowness at all - see below.
  it('spends one question on the wire for the whole role, not one per accept', async () => {
    const h = wholeSlowRole();
    await h.run();
    expect(h.asked).toEqual([twelve[11]]);
  });

  // Why that one. The watch confirms a send by the candidate leaving the slot
  // AND the denominator dropping - and on the LAST person of a role there is no
  // next candidate to slide in, so there is nothing left for the modal to show.
  // What the reviewer does at that moment has never been observed (accepting a
  // hundred real people is the only way to find out), so the pass does not
  // guess: it asks the collection, which can always answer.
  //
  // That makes the request cost of this design one question per ROLE rather
  // than one per accept, and it falls on the one candidate the page cannot
  // speak for.
  it('asks the queue about the last candidate, whom the page cannot show', async () => {
    const h = wholeSlowRole();
    const result = await h.run();
    expect(result.accepted).toBe(12);
    const settled = h.events.find(
      (e) => e.type === 'accept_candidate' && e.userId === twelve[11] && e.outcome === 'accepted',
    );
    expect(settled).toMatchObject({ confirmedBy: 'queue' });
  });

  // And the reload the old slowness trigger would have asked for on every one
  // of these, on a page that had just been reloaded and was slow anyway.
  it('does not ask for a reload on account of the slowness', async () => {
    const h = wholeSlowRole({ reloadPage: true, rand: () => 0.99 });
    await h.run();
    expect(h.events.filter((e) => e.type === 'accept_slow')).toHaveLength(0);
  });

  // The watch re-applies the driver's predicate, and it has two halves for a
  // measured reason: an accept holds the index and drops the total, a skip
  // raises the index and holds the total. Half of it is the shape of a
  // reviewer that MOVED, which is not the shape of one that SENT - and taking
  // it as proof would book a message that never went out, then walk on past
  // somebody without ever having messaged them.
  it('does not take a moved reviewer as proof that the send landed', async () => {
    const records = rowsFor(twelve);
    const records0 = () => records[0].acceptStatus;
    const h = harness({
      people: twelve,
      records,
      slowAccept: twelve[0],
      // The person on screen keeps changing; the bucket never drains.
      drifts: true,
      checkQueue: () => 'queued',
    });
    await h.run();
    // Not booked as an accept on the strength of half a signal. It falls through
    // to the queue, which still shows them, so the sweep concludes the send
    // never happened - and nobody has been claimed for.
    expect(h.ledger.map((e) => e.userId)).not.toContain(twelve[0]);
    expect(h.released).toEqual([twelve[0]]);
    const about = h.events.filter((e) => e.type === 'accept_candidate' && e.userId === twelve[0]);
    expect(about.map((e) => e.outcome)).toEqual(['deferred', 'failed']);
    expect(records0()).toMatch(/^failed: /);
  });

  // And the mirror. A dropped denominator is not proof either, because it does
  // not say WHO left: a recruiter working the same queue by hand, or an
  // application expiring, drains the bucket without this pass's message having
  // gone anywhere.
  it('does not take a drained bucket as proof while the candidate is still shown', async () => {
    const records = rowsFor(twelve);
    const h = harness({
      people: twelve,
      records,
      slowAccept: twelve[0],
      drainsElsewhere: true,
      checkQueue: () => 'queued',
    });
    await h.run();
    expect(h.ledger.map((e) => e.userId)).not.toContain(twelve[0]);
    expect(h.released).toEqual([twelve[0]]);
    const about = h.events.filter((e) => e.type === 'accept_candidate' && e.userId === twelve[0]);
    expect(about.map((e) => e.outcome)).toEqual(['deferred', 'failed']);
    expect(records[0].acceptStatus).toMatch(/^failed: /);
  });

  // Patience has an end, and past it nothing has changed: the send is deferred,
  // recorded so nobody can ever be messaged twice, and the queue is asked.
  it('still defers one the page never shows at all', async () => {
    const h = harness({
      people: twelve,
      records: rowsFor(twelve),
      slowAccept: twelve[0],
      // More looks than the watch has waits, so the page never catches up.
      landsAfterLooks: 99,
      // Unreadable, so the sweep learns nothing and the question stays open.
      checkQueue: () => 'unknown',
    });
    const result = await h.run();
    expect(result.unresolved).toBe(1);
    expect(h.provisional).toEqual([twelve[0]]);
    // A queue that cannot be read is a pass with no instrument left, so it
    // stops there rather than sending into the dark.
    expect(h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE)).toHaveLength(1);
  });
});

// The run that made all of this necessary, at the level of the loop that has to
// survive it.
//
// Accept-only over a 102-applicant role, 99 targets. The first Send was armed,
// the relay gave up on it, the candidate was still in the review queue at every
// look of the settle window - and the accept committed 111 s after the click.
// The role reported 0 of 99 accepted, the person was recorded nowhere, and the
// next attempt would have reached them first all over again.
describe('the send that commits long after everybody stopped looking', () => {
  const five = ['70000001', '70000002', '70000003', '70000004', '70000005'];
  const rowsFor = (ids) => ids.map((id) => captured(id));

  // Queued for every look the pass takes on the spot, gone by the time it asks
  // again at the end. That is the shape of the real failure: not ambiguity,
  // just a page finishing something minutes later.
  const queuedThenGone = (looksBeforeItLands) => {
    let seen = 0;
    return () => (++seen > looksBeforeItLands ? 'gone' : 'queued');
  };

  it('finishes the role and books the slow accept when the queue settles it later', async () => {
    const records = rowsFor(five);
    const h = harness({
      people: five,
      records,
      failAccept: five[0],
      // The page never advanced, so this person is still sitting at the front
      // of the reviewer's queue for the rest of the pass, exactly as observed.
      landed: false,
      checkQueue: queuedThenGone(3),
    });
    const result = await h.run();

    // The whole role, not zero of it.
    expect(result).toMatchObject({
      accepted: 5,
      unresolved: 0,
      failed: 0,
      stoppedBecause: 'finished',
    });
    expect(records.map((r) => r.acceptStatus)).toEqual(new Array(5).fill(ACCEPT_STATUS.ACCEPTED));
    // THE RULE. One click per person, and the slow one is not among the
    // clicks a second time.
    const sends = h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE);
    expect(sends.map((e) => e.expectedUserId)).toEqual(five);
    // Everyone in the ledger, the slow one included, and written when the send
    // was deferred rather than when it was settled.
    expect(h.ledger.map((e) => e.userId).sort()).toEqual([...five].sort());
    // The deferral's accept is written when the sweep answers it, not when the
    // Send was armed - arming only ever wrote the question.
    expect(h.ledger.at(-1).userId).toBe(five[0]);
    expect(h.provisional).toEqual([]);
  });

  it('says deferred while it is unresolved, and accepted once it is not', async () => {
    const h = harness({
      people: five,
      records: rowsFor(five),
      failAccept: five[0],
      checkQueue: queuedThenGone(3),
    });
    await h.run();
    const about = h.events.filter((e) => e.type === 'accept_candidate' && e.userId === five[0]);
    expect(about.map((e) => e.outcome)).toEqual(['deferred', 'accepted']);
    expect(about[1]).toMatchObject({ confirmedBy: 'queue' });
    // And never a second, milder account of the same person as merely skipped.
    expect(about.some((e) => e.outcome === 'skipped')).toBe(false);
    expect(h.events.find((e) => e.type === 'accept_settling')).toMatchObject({ count: 1 });
  });

  // The blocking problem, stated as the thing it actually was: the same person
  // is reached first on every attempt, so a pass that cannot get past them can
  // never get past them.
  it('is not reached again by the next attempt once the sweep has vouched for it', async () => {
    const first = harness({
      people: five,
      records: rowsFor(five),
      failAccept: five[0],
      landed: true,
      // The sweep finds them gone, so the send landed and the accept is final.
      checkQueue: () => 'gone',
    });
    const firstResult = await first.run();
    expect(firstResult.accepted).toBe(5);

    // The second attempt, given the ledger the first one left behind.
    const records = rowsFor(five);
    const second = harness({
      people: five,
      records,
      alreadyAccepted: first.ledger.map((e) => e.userId),
      checkQueue: () => 'gone',
    });
    const secondResult = await second.run();
    const sends = second.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE);
    expect(sends.map((e) => e.expectedUserId)).not.toContain(five[0]);
    // Everyone: the first attempt got past the deferral and finished the role.
    expect(secondResult.alreadyAccepted).toBe(5);
    expect(records[0].acceptStatus).toBe(ACCEPT_STATUS.ALREADY);
  });

  // The page has just been demonstrably wrong about a send, so it is not asked
  // for another one until it has been thrown away and reloaded.
  it('reloads the page before it sends to anybody else', async () => {
    const h = harness({
      people: five,
      records: rowsFor(five),
      failAccept: five[0],
      reloadPage: true,
      checkQueue: queuedThenGone(3),
    });
    await h.run();
    const types = typesOf(h.reviewer.log);
    const deferredAt = types.indexOf(CX.ACCEPT_CANDIDATE);
    const reloadedAt = types.indexOf('RELOAD');
    const nextSendAt = types.indexOf(CX.ACCEPT_CANDIDATE, deferredAt + 1);
    expect(reloadedAt).toBeGreaterThan(deferredAt);
    expect(nextSendAt).toBeGreaterThan(reloadedAt);
  });

  // One is a slow page. Two is a page this module can no longer reason about,
  // and it will not keep sending irreversible messages into one.
  it('stops after three deferrals in a row rather than piling them up', async () => {
    const h = harness({
      people: five,
      records: rowsFor(five),
      failAccept: [five[0], five[1], five[2]],
      checkQueue: () => 'queued',
    });
    const result = await h.run();
    // Three sends the page would not confirm, back to back, is a page that has
    // stopped completing them - so it gets no fourth real person.
    expect(h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE)).toHaveLength(3);
    // And the sweep then found all three still queued, so nothing went out to
    // any of them. `unclear` would send the operator to check three people who
    // were never messaged; `error` is this pass's existing word for "it stopped
    // and nothing went out", which is now exactly what is known.
    expect(result).toMatchObject({ unresolved: 0, failed: 3, stoppedBecause: 'error' });
    expect(h.released).toEqual([five[0], five[1], five[2]]);
  });

  // The counterpart, and the reason the bound counts a RUN of deferrals rather
  // than their total: a confirmed accept says the page is still completing
  // sends, so the count starts again. At two-per-pass this role stopped after
  // five accepts of eighty on a run that was working.
  it('carries on when confirmed accepts keep coming between the deferrals', async () => {
    const many = Array.from({ length: 9 }, (_, i) => String(70000001 + i));
    const h = harness({
      people: many,
      records: many.map((id) => captured(id)),
      // Every other one, so no two deferrals are ever adjacent. The queue says
      // `queued` throughout, so each really does become a deferral rather than
      // being settled on the spot.
      failAccept: [many[0], many[2], many[4], many[6]],
      checkQueue: () => 'queued',
    });
    const result = await h.run();
    // Four deferrals - well past the bound - and the pass never stopped,
    // because a confirmed accept arrived between each pair of them.
    expect(h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE)).toHaveLength(9);
    expect(result.accepted).toBe(5);
    expect(h.released).toHaveLength(4);
  });

  // The report the operator reads must never be the one they got last time:
  // "0 accepted" beside an alert saying the message may or may not have gone.
  it('never tells the operator nothing was sent about a person who may have been', async () => {
    const records = rowsFor(five);
    const result = await harness({
      people: five,
      records,
      failAccept: five[0],
      // Unreadable, so nothing is concluded in either direction and the person
      // stays a question.
      checkQueue: () => 'unknown',
    }).run();
    expect(result.unresolved).toBe(1);
    expect(result.error).not.toContain('nothing was sent');
    expect(records[0].acceptStatus).not.toContain('nothing was sent');
    expect(records[0].acceptStatus).not.toMatch(/^failed: /);
  });

  // The ledger entry is the only thing standing between this person and a
  // message from the next run, and on this path it is also the only thing that
  // would remember the attempt at all.
  it('stops before dispatch when the ledger cannot remember the pending accept', async () => {
    const h = harness({
      people: five,
      records: rowsFor(five),
      failAccept: five[0],
      provisionalFails: five[0],
      checkQueue: () => 'queued',
    });
    const result = await h.run();
    expect(result.stoppedBecause).toBe('error');
    expect(result.error).toContain('nothing was sent');
    expect(h.reviewer.log.filter((e) => e.type === CX.ACCEPT_CANDIDATE)).toHaveLength(0);
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

  // The owner's primary workflow: an accept-only run over a whole role, where
  // the review queue holds somebody whose resume was never captured. The pass
  // skips them within the first few positions, and that used to switch the
  // whole refresh cycle off for the remaining hundred accepts - the mechanism
  // that keeps a long pass alive, disarmed by a counter. It reloads anyway.
  it('still reloads after skipping somebody', async () => {
    const people = [nine[0], '99', ...nine.slice(1)];
    const h = harness({ people, records: rows(), reloadPage: true, rand: MIDDLE });
    const result = await h.run();
    expect(result).toMatchObject({ accepted: 9, stoppedBecause: 'finished' });
    expect(typesOf(h.reviewer.log)).toContain('RELOAD');
  });

  // A reload lands the reviewer at position 1, so the skipped person is walked
  // past again on the way back to the front. That is the cost the old gate was
  // avoiding, and it is paid by counting people rather than visits.
  it('counts a skipped person once however often a reload walks past them', async () => {
    const people = [nine[0], '99', ...nine.slice(1)];
    const h = harness({ people, records: rows(), reloadPage: true, rand: MIDDLE });
    const result = await h.run();
    // Walked past more than once - so this is the re-walk, not a pass that
    // happened to see them only the once.
    const skips = h.reviewer.log.filter((e) => e.type === CX.SKIP_CANDIDATE);
    expect(skips.length).toBeGreaterThan(1);
    expect(result.skipped).toBe(1);
    // And said once, for the same reason: a second sentence about the same
    // skip reads as a second person.
    const said = h.events.filter((e) => e.type === 'accept_candidate' && e.outcome === 'skipped');
    expect(said).toHaveLength(1);
    expect(said[0].userId).toBe('99');
  });

  // The whole point of allowing the reload: nobody is messaged twice and
  // nobody is stepped over, even though the walk goes back over ground it has
  // already covered.
  it('messages everybody exactly once across a reload that re-walks a skip', async () => {
    const people = [nine[0], '99', ...nine.slice(1)];
    const h = harness({ people, records: rows(), reloadPage: true, rand: MIDDLE });
    await h.run();
    const sent = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sent).toEqual(nine);
    expect(h.ledger.map((e) => e.userId)).toEqual(nine);
    expect(h.reviewer.queue).toEqual(['99']);
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

describe('a malformed Wellfound layout before any send', () => {
  it('reloads once, resumes by identity, and accepts the captured candidate', async () => {
    const target = '70000001';
    const h = harness({
      people: ['98', '99', target],
      records: [captured(target)],
      reloadPage: true,
      brokenSkips: 1,
      brokenSkipAt: 2,
      rand: () => 0.5,
    });

    const result = await h.run();

    expect(result).toMatchObject({ accepted: 1, stoppedBecause: 'finished' });
    expect(typesOf(h.reviewer.log)).toEqual(
      expect.arrayContaining([CX.SKIP_CANDIDATE, CX.CLOSE_REVIEWER, 'RELOAD', CX.OPEN_REVIEWER]),
    );
    expect(
      h.reviewer.log.filter((entry) => entry.type === CX.ACCEPT_CANDIDATE),
    ).toHaveLength(1);
    expect(h.reviewer.log.filter((entry) => entry.type === CX.SKIP_CANDIDATE)).toHaveLength(4);
    expect(result.skipped).toBe(2);
    expect(h.ledger.map((entry) => entry.userId)).toEqual([target]);
  });

  it('stops after two reloads when the layout remains malformed', async () => {
    const target = '70000001';
    const h = harness({
      people: ['99', target],
      records: [captured(target)],
      reloadPage: true,
      brokenSkips: 3,
      rand: () => 0.5,
    });

    const result = await h.run();

    expect(result).toMatchObject({ accepted: 0, stoppedBecause: 'error' });
    expect(result.error).toMatch(/Next applicant.*none usable/);
    expect(typesOf(h.reviewer.log).filter((type) => type === 'RELOAD')).toHaveLength(2);
    expect(
      h.reviewer.log.filter((entry) => entry.type === CX.ACCEPT_CANDIDATE),
    ).toHaveLength(0);
  });
});

// The two rules whose failure costs a real person a duplicate message or an
// unrecorded one. Both are structural: an interlock that throws, not a
// convention about where a call site sits.
describe('a reload can never land inside an accept', () => {
  const nine = Array.from({ length: 9 }, (_, i) => String(70000001 + i));
  const rows = () => nine.map((id) => captured(id));
  const MIDDLE = () => 0.5;

  // The operator can send as soon as the control is focused, so the durable
  // question must exist before the page is armed. Confirmation follows only
  // after the queue transition is observed.
  it('arms only between a provisional write and its confirmation', async () => {
    const h = harness({ people: nine, records: rows(), reloadPage: true, rand: MIDDLE });
    await h.run();
    const types = typesOf(h.reviewer.log);
    expect(types).toContain('RELOAD');
    types.forEach((type, i) => {
      if (type === CX.ACCEPT_CANDIDATE) {
        expect(types[i - 1]).toBe('PROVISIONAL');
        expect(types[i + 1]).toBe('CONFIRM');
      }
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
    expect(types[send - 1]).toBe('PROVISIONAL');
    expect(types[send + 1]).toBe('CONFIRM');
    expect(types.indexOf('RELOAD')).toBeGreaterThan(send + 1);
  });

  // Rule 1, on its own, because no walk this pass can perform reaches it: the
  // refresh is called from one place, the top of the loop, where nothing is
  // ever outstanding. That is what makes it a backstop against a later edit
  // rather than a live branch - and it is exactly why it survived deletion with
  // the whole suite green. It is a function now, so breaking it breaks a test.
  it('refuses a reload while an accept is unresolved, and names the person', () => {
    expect(() => guardReload('70000001')).toThrow(/70000001/);
    expect(() => guardReload('70000001')).toThrow(/unresolved/i);
  });

  it('lets a reload through when nothing is outstanding', () => {
    expect(() => guardReload(null)).not.toThrow();
    expect(() => guardReload(undefined)).not.toThrow();
  });

  // The call site, which no behaviour can exercise, asserted where it lives.
  // Without this, deleting the one line that consults the interlock leaves
  // every test above green while the interlock protects nothing.
  it('is consulted by the refresh path, before anything touches the page', () => {
    const source = readFileSync(new URL('../src/panel/accept-pass.js', import.meta.url), 'utf8');
    expect(source).toMatch(/const refresh = async \(\) => \{\s*guardReload\(unresolvedSend\);/);
  });

  // Rule 2, asserted from INSIDE the ledger write, which is the only place it is
  // visible. Reordering the write past the advance changes nothing in any
  // message log: `mark`, `remaining.delete` and `totals.accepted` are all off
  // the wire.
  it('has advanced past nobody at the moment the ledger write begins', async () => {
    const records = rows();
    const seen = [];
    const h = harness({
      people: nine,
      records,
      reloadPage: true,
      rand: MIDDLE,
      onLedger: (userId) => {
        const row = records.find((r) => String(r.userId) === userId);
        seen.push({
          userId,
          status: row.acceptStatus,
          acceptedAt: row.acceptedAt ?? null,
          announced: h.events.filter(
            (e) => e.type === 'accept_candidate' && e.userId === userId,
          ).length,
        });
      },
    });
    await h.run();

    expect(seen.map((s) => s.userId)).toEqual(nine);
    for (const entry of seen) {
      // Still "the run was accepting and has not reached this candidate": the
      // cell must not read `accepted` before the ledger says it is.
      expect(entry.status).toBe(ACCEPT_STATUS.NOT_REACHED);
      expect(entry.acceptedAt).toBe(null);
      // And nothing has been announced about them either, so no counter has
      // moved ahead of the record.
      expect(entry.announced).toBe(0);
    }
    // The far side: once the write is done, every one of them says accepted.
    expect(records.map((r) => r.acceptStatus)).toEqual(
      new Array(nine.length).fill(ACCEPT_STATUS.ACCEPTED),
    );
  });

  it('and the same holds on the path where the queue settled the send', async () => {
    const records = rows();
    const seen = [];
    const h = harness({
      people: nine,
      records,
      reloadPage: true,
      rand: MIDDLE,
      failAccept: nine[0],
      landed: true,
      checkQueue: () => 'gone',
      onLedger: (userId) => {
        const row = records.find((r) => String(r.userId) === userId);
        seen.push({ userId, status: row.acceptStatus, acceptedAt: row.acceptedAt ?? null });
      },
    });
    await h.run();
    expect(seen[0]).toMatchObject({
      userId: nine[0],
      status: ACCEPT_STATUS.NOT_REACHED,
      acceptedAt: null,
    });
    for (const entry of seen) expect(entry.status).toBe(ACCEPT_STATUS.NOT_REACHED);
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

// A confirmed send is a fact, and nothing that happens afterwards may retract
// it. The ledger write used to sit inside the walk's own try, whose catch says
// `error` - this pass's word for "the pass stopped and nothing went out". So a
// storage failure a moment after a real message left the panel asserting the
// opposite of what happened, and the next run messaged that person again.
describe('a ledger write that fails after a confirmed send', () => {
  const three = ['70000001', '70000002', '70000003'];
  const rows = () => three.map((id) => captured(id));

  const brokenLedger = (extra = {}) => {
    const records = rows();
    const h = harness({
      people: three,
      records,
      ledgerFails: three[1],
      ...extra,
    });
    return { h, records };
  };

  it('is its own outcome, and never `error`', async () => {
    const { h } = brokenLedger();
    const result = await h.run();
    expect(result.stoppedBecause).toBe('unrecorded');
  });

  it('says the message went out, and never that nothing was sent', async () => {
    const { h } = brokenLedger();
    const result = await h.run();
    expect(result.error).toContain('was sent');
    expect(result.error).toContain(three[1]);
    expect(result.error.toLowerCase()).not.toContain(NOTHING_SENT);
    // The one thing the operator can do about it: the ledger is what stops a
    // second message, so the sentence has to send them to check.
    expect(result.error).toContain('second time');
  });

  it('counts the person as accepted, because they were', async () => {
    const { h, records } = brokenLedger();
    const result = await h.run();
    expect(result.accepted).toBe(2);
    // The CSV row is now the only surviving record of that message.
    const row = records.find((r) => r.userId === three[1]);
    expect(row.acceptStatus).toBe(ACCEPT_STATUS.ACCEPTED);
    expect(row.acceptedAt).toBeTruthy();
  });

  it('sends nothing more once the ledger has stopped working', async () => {
    const { h, records } = brokenLedger();
    await h.run();
    const sent = h.reviewer.log
      .filter((e) => e.type === CX.ACCEPT_CANDIDATE)
      .map((e) => String(e.expectedUserId));
    expect(sent).toEqual(three.slice(0, 2));
    // And the person never reached says so, rather than reading as a refusal.
    expect(records[2].acceptStatus).toBe(ACCEPT_STATUS.NOT_REACHED);
  });

  it('leaves the reviewer closed, like every other way out', async () => {
    const { h } = brokenLedger();
    await h.run();
    expect(h.reviewer.isOpen()).toBe(false);
  });

  it('says it out loud, so the running screen and the trace both have it', async () => {
    const { h } = brokenLedger();
    await h.run();
    const said = h.events.find((e) => e.type === 'accept_unrecorded');
    expect(said).toMatchObject({ userId: three[1] });
    // The person is still announced as accepted, with the record's failure
    // beside it rather than instead of it.
    const announced = h.events.find(
      (e) => e.type === 'accept_candidate' && e.userId === three[1],
    );
    expect(announced).toMatchObject({ outcome: 'accepted', recorded: false });
  });

  // The other half of C1: the same write on the path where the queue settled an
  // unconfirmed send. That one books an accept on inferred evidence, so its
  // ledger failure is if anything the worse of the two.
  it('holds on the path where the queue settled the send', async () => {
    const { h } = brokenLedger({
      failAccept: three[1],
      landed: true,
      checkQueue: () => 'gone',
    });
    const result = await h.run();
    expect(result.stoppedBecause).toBe('unrecorded');
    expect(result.error).toContain(three[1]);
    expect(result.accepted).toBe(2);
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
    const h = slowingRun([8300, 7100, 120000, 6000, 6000, 6000]);
    const result = await h.run();
    expect(result).toMatchObject({ accepted: 10, stoppedBecause: 'finished' });

    const slow = h.events.filter((e) => e.type === 'accept_slow');
    expect(slow).toHaveLength(1);
    expect(slow[0].ms).toBe(120000);
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

  // What the threshold has to be clear of, and the reason it moved. It used to
  // sit at 20s, above a healthy band of 5-9s - and then a 101-applicant role
  // was measured taking 25s, 32s, 42s, 46s, 50s and 66s per accept ON FRESHLY
  // RELOADED DOCUMENTS. At 20s the trigger fired on nearly every accept of that
  // role and asked for a reload that recovered nothing, because there was
  // nothing to recover: a large role is just slow.
  it('ignores the band a large role simply has', async () => {
    // Every duration here is one this project has measured on a page that was
    // working. None of them is a page asking to be thrown away.
    const large = slowingRun([25038, 31955, 41926, 45988, 50385, 66594], {
      people: ten.slice(0, 6),
    });
    await large.run();
    expect(large.events.filter((e) => e.type === 'accept_slow')).toHaveLength(0);
    expect(large.events.filter((e) => e.type === 'accept_reload')).toHaveLength(0);
  });

  it('still fires on an accept far outside even that', async () => {
    const stuck = slowingRun([9000, 120000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000]);
    await stuck.run();
    const slow = stuck.events.filter((e) => e.type === 'accept_slow');
    expect(slow).toHaveLength(1);
    expect(slow[0].ms).toBe(120000);
  });

  // Everything the reload already promised still holds when slowness is what
  // asked for it.
  it('still reloads only between candidates, with the ledger already written', async () => {
    const h = slowingRun([8300, 7100, 120000, 6000, 6000, 6000]);
    await h.run();
    const types = typesOf(h.reviewer.log);
    types.forEach((type, i) => {
      if (type === CX.ACCEPT_CANDIDATE) {
        expect(types[i - 1]).toBe('PROVISIONAL');
        expect(types[i + 1]).toBe('CONFIRM');
      }
    });
    const at = types.indexOf('RELOAD');
    expect(types[at - 1]).toBe(CX_CLOSE_REVIEWER);
    expect(types[at + 1]).toBe(CX.OPEN_REVIEWER);
    expect(types[at + 2]).toBe(CX.READ_CANDIDATE);
  });

  it('messages everybody exactly once, and skips nobody, across a slow patch', async () => {
    const h = slowingRun([8300, 7100, 120000, 130000, 6000, 6000]);
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
