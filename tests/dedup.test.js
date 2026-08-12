import { describe, it, expect } from 'vitest';
import { diffPage, createEarlyStop, EARLY_STOP_PAGES } from '../src/lib/dedup.js';

const rec = (id) => ({ applicantId: `JP${id}`, userId: String(id), name: `n${id}` });

describe('diffPage', () => {
  it('returns records not already seen', () => {
    const { fresh } = diffPage([rec(1), rec(2)], new Set(['1']));
    expect(fresh.map((r) => r.userId)).toEqual(['2']);
  });

  it('flags a page where everything was already seen', () => {
    const { allSeen, fresh } = diffPage([rec(1)], new Set(['1']));
    expect(allSeen).toBe(true);
    expect(fresh).toEqual([]);
  });

  it('treats an empty page as fully seen so the walk can terminate', () => {
    expect(diffPage([], new Set()).allSeen).toBe(true);
  });

  it('keys on userId, so a second application from the same person is skipped', () => {
    const first = { applicantId: 'JP-jobA', userId: '99' };
    const again = { applicantId: 'JP-later', userId: '99' };
    expect(diffPage([first, again], new Set(['99'])).fresh).toEqual([]);
    expect(diffPage([first, again], new Set()).fresh).toEqual([first, again]);
  });

  it('never returns a record with no userId as fresh', () => {
    const nameless = { applicantId: 'JP1', userId: null, name: 'Masked' };
    const empty = { applicantId: 'JP2', userId: '', name: 'Blank' };
    expect(diffPage([nameless, empty], new Set()).fresh).toEqual([]);
  });

  it('does not call a page of only masked applicants fully seen', () => {
    const masked = [
      { applicantId: 'JP1', userId: null, name: 'Masked' },
      { applicantId: 'JP2', userId: '', name: 'Blank' },
    ];
    // A queue can open with a whole page of locked candidates. Calling that
    // "fully seen" would advance the early-stop streak and end the run before
    // it reached the real people behind them.
    expect(diffPage(masked, new Set()).allSeen).toBe(false);
  });

  it('judges a mixed page on its identifiable records alone', () => {
    const masked = { applicantId: 'JP0', userId: null, name: 'Masked' };
    const seenPage = diffPage([masked, rec(1)], new Set(['1']));
    expect(seenPage.fresh).toEqual([]);
    expect(seenPage.allSeen).toBe(true);

    const freshPage = diffPage([masked, rec(2)], new Set(['1']));
    expect(freshPage.fresh.map((r) => r.userId)).toEqual(['2']);
    expect(freshPage.allSeen).toBe(false);
  });
});

describe('createEarlyStop', () => {
  it(`stops after ${EARLY_STOP_PAGES} consecutive fully-seen pages`, () => {
    const stop = createEarlyStop({});
    stop.observe(true);
    stop.observe(true);
    expect(stop.shouldStop()).toBe(false);
    stop.observe(true);
    expect(stop.shouldStop()).toBe(true);
  });

  it('resets the streak when a page has fresh records', () => {
    const stop = createEarlyStop({});
    stop.observe(true);
    stop.observe(true);
    stop.observe(false);
    stop.observe(true);
    expect(stop.shouldStop()).toBe(false);
  });

  it('never stops early when forceFullWalk is set', () => {
    const stop = createEarlyStop({ forceFullWalk: true });
    for (let i = 0; i < 10; i += 1) stop.observe(true);
    expect(stop.shouldStop()).toBe(false);
  });
});
