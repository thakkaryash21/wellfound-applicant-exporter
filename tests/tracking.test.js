import { describe, expect, it } from 'vitest';
import { deriveTracking } from '../src/lib/tracking.js';

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
  it('separates new, recovery, eligible, and ordered limited targets by identity', () => {
    const result = deriveTracking({
      jobId: '9100001',
      snapshot: snapshot(),
      historicallyCaptured: ['ready', 'recover', 'accepted', 'provisional', 'left-review'],
      availableCaptured: ['ready', 'accepted', 'provisional', 'left-review'],
      accepted: ['accepted'],
      provisional: ['provisional'],
      limit: 1,
    });

    expect(result).toMatchObject({ exact: true, unidentified: 0 });
    expect(result.newUserIds).toEqual(['new']);
    expect(result.needsRecoveryUserIds).toEqual(['recover']);
    expect(result.eligibleUserIds).toEqual(['ready']);
    expect(result.plannedUserIds).toEqual(['ready']);
  });

  it.each([
    ['partial scan', snapshot({ complete: false })],
    ['foreign bucket', snapshot({ bucket: 'SHORTLISTED' })],
    ['missing completion time', snapshot({ scannedAt: null })],
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
    expect(result.plannedUserIds).toEqual([]);
  });

  it('fails closed when evidence belongs to another job', () => {
    const result = deriveTracking({
      jobId: '9100002',
      snapshot: snapshot(),
      historicallyCaptured: ['ready'],
      availableCaptured: ['ready'],
    });
    expect(result).toMatchObject({ exact: false, eligibleUserIds: [], plannedUserIds: [] });
  });
});
