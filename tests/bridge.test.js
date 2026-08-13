// The relay between the panel and the page. It ships as a classic content
// script, so it is loaded the way Chrome loads it and driven from its two real
// edges - chrome.runtime.onMessage on one side, window messages on the other.
// It exposes nothing on purpose: it has no logic to reach into.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadClassicScript, createFakeWindow } from './helpers/classic-script.js';

function load() {
  const fakeWindow = createFakeWindow();
  const runtimeListeners = [];
  const chrome = { runtime: { onMessage: { addListener: (fn) => runtimeListeners.push(fn) } } };
  const { exposed } = loadClassicScript('src/content/bridge.js', {
    globals: { window: fakeWindow.window, chrome },
    expose: '__WFX_BRIDGE__',
  });
  const listener = runtimeListeners[0];
  return {
    ...fakeWindow,
    budget: exposed,
    // What the panel sends. The returned value is the one Chrome reads to
    // decide whether sendResponse may still be called.
    send(message) {
      let response;
      const returned = listener(message, {}, (value) => {
        response = value;
      });
      return { returned, read: () => response };
    },
    // What the MAIN world would post back.
    reply(id, payload) {
      fakeWindow.deliver({ source: 'wfx-page', id, ...payload });
    },
    // The last request the bridge forwarded to the page.
    lastAsk: () => fakeWindow.posted[fakeWindow.posted.length - 1],
  };
}

// Lets the .then(sendResponse) chain run.
const flush = () => Promise.resolve().then(() => {});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the bridge', () => {
  it('keeps sendResponse alive by returning true for every message it forwards', () => {
    const bridge = load();
    // The whole extension rests on this. Returning anything falsy from an
    // onMessage listener closes the channel the moment it returns, so every
    // answer arrives as undefined - and a suite that only checked the page side
    // would still be green.
    for (const type of ['CX_LIST_JOBS', 'CX_FETCH_PAGE', 'CX_QUERY_READY']) {
      expect(bridge.send({ type }).returned).toBe(true);
    }
  });

  it('forwards only the three types it is allowed to', () => {
    const bridge = load();
    const before = bridge.posted.length;
    for (const message of [{ type: 'EVAL' }, { type: 'CX_ANYTHING' }, {}, null]) {
      expect(bridge.send(message).returned).toBe(false);
    }
    // A relay that forwarded whatever it was handed would let anything with
    // access to the extension run against the recruiter's own Apollo client.
    expect(bridge.posted.length).toBe(before);
  });

  it('asks the page in the page own vocabulary, carrying the payload', () => {
    const bridge = load();
    bridge.send({ type: 'CX_FETCH_PAGE', payload: { jobId: '9100001', pageSize: 50 } });
    expect(bridge.lastAsk()).toMatchObject({
      source: 'wfx-cs',
      type: 'FETCH_PAGE',
      payload: { jobId: '9100001', pageSize: 50 },
    });
  });

  it('gives every request its own id, so two in flight cannot cross', async () => {
    const bridge = load();
    const jobs = bridge.send({ type: 'CX_LIST_JOBS' });
    const first = bridge.lastAsk().id;
    const page = bridge.send({ type: 'CX_FETCH_PAGE', payload: {} });
    const second = bridge.lastAsk().id;
    expect(first).not.toBe(second);

    bridge.reply(second, { ok: true, data: { edges: [] } });
    bridge.reply(first, { ok: true, data: [{ jobId: '9100001' }] });
    await flush();
    expect(jobs.read()).toEqual({ ok: true, data: [{ jobId: '9100001' }] });
    expect(page.read()).toEqual({ ok: true, data: { edges: [] } });
  });

  it('passes a page failure back as an answer, not as a rejection', async () => {
    const bridge = load();
    const sent = bridge.send({ type: 'CX_QUERY_READY' });
    bridge.reply(bridge.lastAsk().id, { ok: false, error: 'RecruitJobListingApplicants is not active yet' });
    await flush();
    expect(sent.read()).toEqual({
      ok: false,
      error: 'RecruitJobListingApplicants is not active yet',
    });
  });

  it('answers not-ok when the page goes quiet, rather than hanging the run forever', async () => {
    const bridge = load();
    const sent = bridge.send({ type: 'CX_LIST_JOBS' });
    await vi.advanceTimersByTimeAsync(bridge.budget.TIMEOUT_MS - 1);
    expect(sent.read()).toBe(undefined);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    // A MAIN world script that never loaded answers nothing at all. Without
    // this the panel waits on a promise that will never settle and the run
    // parks with the stop button inert.
    expect(sent.read()).toEqual({ ok: false, error: 'Page did not respond in time' });
  });

  it('drops the timeout the moment the page answers', async () => {
    const bridge = load();
    bridge.send({ type: 'CX_LIST_JOBS' });
    expect(vi.getTimerCount()).toBe(1);
    bridge.reply(bridge.lastAsk().id, { ok: true, data: [] });
    await flush();
    // The pending entry and its timer are both released; a run of a thousand
    // pages would otherwise hold a thousand live timers.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a second answer to a request it has already settled', async () => {
    const bridge = load();
    const sent = bridge.send({ type: 'CX_LIST_JOBS' });
    const id = bridge.lastAsk().id;
    bridge.reply(id, { ok: true, data: 'first' });
    await flush();
    expect(() => bridge.reply(id, { ok: false, error: 'second' })).not.toThrow();
    await flush();
    expect(sent.read()).toEqual({ ok: true, data: 'first' });
  });

  it('forwards the teardown message, which is how a composer ever gets closed', async () => {
    const bridge = load();
    expect(bridge.send({ type: 'CX_CLOSE_REVIEWER' }).returned).toBe(true);
    expect(bridge.lastAsk()).toMatchObject({ source: 'wfx-cs', type: 'CLOSE_REVIEWER' });
  });

  it('ignores traffic from other frames, other senders and unknown ids', async () => {
    const bridge = load();
    const sent = bridge.send({ type: 'CX_LIST_JOBS' });
    const id = bridge.lastAsk().id;
    bridge.deliver({ source: 'wfx-page', id, ok: true, data: 'elsewhere' }, { other: 'frame' });
    bridge.deliver({ source: 'somebody-else', id, ok: true, data: 'spoofed' });
    bridge.reply('wfx-999', { ok: true, data: 'nobody asked' });
    await flush();
    expect(sent.read()).toBe(undefined);
  });
});

// The relationship that used to be arithmetic in nobody's comment.
//
// One ACCEPT_CANDIDATE can legitimately occupy most of this budget: the composer
// wait, both operator-shaped pauses, and the confirmation wait. If the budget
// expires around one, the panel is told the page went quiet WHILE THE MESSAGE IS
// GOING OUT - booked as failed, never written to the ledger, and a candidate for
// being messaged a second time on a later run. It was 30000 against a driver
// worst case of 28000: two seconds, in two files, related by nothing.
//
// It is now stated on both sides and checked here, against the driver's real
// constant read out of the real file rather than a number retyped into a test.
describe('the budget against the driver it has to cover', () => {
  // reviewer.js is a classic MAIN-world script like the bridge, so it is loaded
  // the same way. It touches `document` only inside its functions, so a window
  // is all it needs to publish its constants.
  function reviewerBudget() {
    const { exposed } = loadClassicScript('src/content/reviewer.js', {
      globals: { window: createFakeWindow().window },
      expose: '__WFX_REVIEWER__',
    });
    return exposed.ACCEPT_WORST_CASE_MS;
  }

  it('covers the driver worst case the driver itself declares', () => {
    const { budget } = load();
    // Not "roughly equal to": the same number. The bridge's copy is a claim
    // about another file, and a claim nothing checks is a comment.
    expect(budget.DRIVER_WORST_CASE_MS).toBe(reviewerBudget());
  });

  it('leaves margin on top of it rather than sitting flush against it', () => {
    const { budget } = load();
    expect(budget.TIMEOUT_MS).toBe(budget.DRIVER_WORST_CASE_MS + budget.MARGIN_MS);
    // The driver's figure is SCHEDULED time; the margin is the allowance for the
    // page starving the thread it is scheduled on. That was measured at more
    // than half again over a 30 s budget (a 47 s accept), so the margin has to
    // be at least half the driver's worst case - not because halves are
    // meaningful, but because that is what the page has actually been seen to
    // add. Below that the relay gives up first and hands the panel an outcome
    // the driver could have named.
    expect(budget.MARGIN_MS).toBeGreaterThanOrEqual(budget.DRIVER_WORST_CASE_MS / 2);
  });

  it('adds the visible typing duration to an accept request timeout', () => {
    const { budget } = load();
    const short = budget.timeoutFor('ACCEPT_CANDIDATE', { message: 'Hi' });
    const long = budget.timeoutFor('ACCEPT_CANDIDATE', { message: 'Hello world' });
    expect(short).toBeGreaterThan(budget.TIMEOUT_MS);
    expect(long).toBeGreaterThan(short);
    expect(budget.timeoutFor('READ_CANDIDATE', {})).toBe(budget.TIMEOUT_MS);
  });
});
