import { describe, expect, it } from 'vitest';
import { deriveTracking } from '../src/lib/tracking.js';

// The equations in docs/TRACKING_MODEL.md, tested where they live.
//
// They were covered end to end through run-controller and nowhere else, which
// is how a whole class of case went unnoticed: every one of those tests passed
// `limit: Infinity`, so nothing ever asked what a bounded role does. Set
// arithmetic is cheap to test directly and expensive to test through a walk.

const snapshot = (over = {}) => ({
  jobId: '9100001',
  bucket: 'NEEDS_REVIEW',
  complete: true,
  scannedAt: '2026-08-13T18:00:00.000Z',
  userIds: ['new', 'ready', 'recover', 'accepted', 'provisional'],
  unidentified: 0,
  ...over,
});

describe('deriveTracking', () => {
  it('separates new, recovery and eligible by identity', () => {
    const result = deriveTracking({
      jobId: '9100001',
      snapshot: snapshot(),
      historicallyCaptured: ['ready', 'recover', 'accepted', 'provisional', 'left-review'],
      availableCaptured: ['ready', 'accepted', 'provisional', 'left-review'],
      accepted: ['accepted'],
      provisional: ['provisional'],
    });

    expect(result).toMatchObject({ exact: true, unidentified: 0 });
    expect(result.newUserIds).toEqual(['new']);
    expect(result.needsRecoveryUserIds).toEqual(['recover']);
    expect(result.eligibleUserIds).toEqual(['ready']);
  });

  // `actionableCount - knownCount` is not a valid estimate, and this is why:
  // people leave Needs Review by being accepted, rejected or moved by hand, and
  // they stay in capture history for ever afterwards. Subtracting one count from
  // the other charges their absence to somebody who is still waiting.
  it('does not let a capture who has left Review reduce the new count for anybody else', () => {
    const result = deriveTracking({
      jobId: '9100001',
      snapshot: snapshot({ userIds: ['new-one', 'new-two'] }),
      historicallyCaptured: ['gone-one', 'gone-two', 'gone-three'],
      availableCaptured: ['gone-one', 'gone-two', 'gone-three'],
    });
    expect(result.newUserIds).toEqual(['new-one', 'new-two']);
    expect(result.needsRecoveryUserIds).toEqual([]);
  });

  // Historical capture answers "is this person new". It never, by itself,
  // answers "do we hold their resume". An imported or legacy id carries no file
  // evidence, so it is not new and not eligible: it needs recovery.
  it('refuses an imported or legacy identity that no file evidence supports', () => {
    const result = deriveTracking({
      jobId: '9100001',
      snapshot: snapshot({ userIds: ['imported'] }),
      historicallyCaptured: ['imported'],
      availableCaptured: [],
    });
    expect(result.newUserIds).toEqual([]);
    expect(result.needsRecoveryUserIds).toEqual(['imported']);
    expect(result.eligibleUserIds).toEqual([]);
  });

  it('keeps accepted and provisional out of the eligible set, though neither is counted on screen', () => {
    const result = deriveTracking({
      jobId: '9100001',
      snapshot: snapshot({ userIds: ['accepted', 'provisional', 'ready'] }),
      historicallyCaptured: ['accepted', 'provisional', 'ready'],
      availableCaptured: ['accepted', 'provisional', 'ready'],
      accepted: ['accepted'],
      provisional: ['provisional'],
    });
    expect(result.eligibleUserIds).toEqual(['ready']);
    // Neither is new and neither needs recovery: their files are present and
    // this extension has already dealt with them.
    expect(result.newUserIds).toEqual([]);
    expect(result.needsRecoveryUserIds).toEqual([]);
  });

  // One person, two applications to the same role. Identity is the userId, so
  // they are one member of every set - counted once, offered once.
  it('collapses the repeated rows of one person into a single identity', () => {
    const result = deriveTracking({
      jobId: '9100001',
      snapshot: snapshot({ userIds: ['twice', 'twice', 'once'] }),
      historicallyCaptured: [],
      availableCaptured: [],
    });
    expect(result.newUserIds).toEqual(['twice', 'once']);
  });

  // Numbers and strings both arrive from Wellfound; which one was never
  // observed reliably, so neither may be identity on its own terms.
  it('reads a numeric id and a string id as the same person', () => {
    const result = deriveTracking({
      jobId: 9100001,
      snapshot: snapshot({ userIds: [70000001] }),
      historicallyCaptured: ['70000001'],
      availableCaptured: [70000001],
    });
    expect(result.newUserIds).toEqual([]);
    expect(result.eligibleUserIds).toEqual(['70000001']);
  });

  it('reports unidentified rows without folding them into any identity set', () => {
    const result = deriveTracking({
      jobId: '9100001',
      snapshot: snapshot({ userIds: ['ready'], unidentified: 2 }),
      historicallyCaptured: [],
      availableCaptured: ['ready'],
    });
    expect(result.unidentified).toBe(2);
    expect(result.newUserIds).toEqual(['ready']);
    expect(result.eligibleUserIds).toEqual(['ready']);
  });

  it.each([
    ['partial scan', snapshot({ complete: false })],
    ['foreign bucket', snapshot({ bucket: 'SHORTLISTED' })],
    ['missing completion time', snapshot({ scannedAt: null })],
    ['absent scan', null],
  ])('makes no exact claim and authorizes nobody for a %s', (_name, invalid) => {
    const result = deriveTracking({
      jobId: '9100001',
      snapshot: invalid,
      historicallyCaptured: ['ready'],
      availableCaptured: ['ready'],
    });

    expect(result.exact).toBe(false);
    expect(result.newUserIds).toBeNull();
    expect(result.needsRecoveryUserIds).toBeNull();
    expect(result.eligibleUserIds).toEqual([]);
  });

  // A count is refused, but the exception is still reported: an incomplete scan
  // that saw two unreadable rows knows that much, and hiding it would make the
  // screen quieter than the truth.
  it('still reports unidentified rows from a scan too incomplete to count', () => {
    const result = deriveTracking({
      jobId: '9100001',
      snapshot: snapshot({ complete: false, unidentified: 3 }),
    });
    expect(result.exact).toBe(false);
    expect(result.unidentified).toBe(3);
  });

  it('fails closed when evidence belongs to another job', () => {
    const result = deriveTracking({
      jobId: '9100002',
      snapshot: snapshot(),
      historicallyCaptured: ['ready'],
      availableCaptured: ['ready'],
    });
    expect(result).toMatchObject({ exact: false, eligibleUserIds: [] });
  });

  it('fails closed when asked about no job at all', () => {
    const result = deriveTracking({ snapshot: snapshot() });
    expect(result).toMatchObject({ exact: false, eligibleUserIds: [] });
  });
});
