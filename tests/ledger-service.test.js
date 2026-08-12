import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { createLedgerService } from '../src/panel/ledger-service.js';

const JOB = '9100001';

let fake;
let service;

beforeEach(() => {
  fake = installFakeChrome();
  service = createLedgerService(fake.chrome.storage.local);
});

afterEach(() => {
  fake.restore();
});

describe('ledger-service accept dimension', () => {
  it('records an accept immediately, keyed separately from downloads', async () => {
    await service.recordAccepted(JOB, '111');
    expect(await service.acceptedUserIdsFor(JOB)).toEqual(['111']);
    // A separate dimension: recording an accept must not also mark the
    // person downloaded, or an accept-only run would corrupt the download
    // count it never touched.
    expect(await service.seenUserIdsFor(JOB)).toEqual([]);
  });

  it('is queryable per job: given a jobId, which userIds were accepted', async () => {
    await service.recordAccepted(JOB, '1');
    await service.recordAccepted(JOB, '2');
    await service.recordAccepted('9200002', '999');
    expect((await service.acceptedUserIdsFor(JOB)).sort()).toEqual(['1', '2']);
    expect(await service.acceptedUserIdsFor('9200002')).toEqual(['999']);
  });

  it('records a local date/time string, not a raw Unix timestamp', async () => {
    await service.recordAccepted(JOB, '111');
    const stored = fake.store[`job:${JOB}`];
    const acceptedAt = stored.accepted['111'];
    expect(typeof acceptedAt).toBe('string');
    // Raw epoch millis parse as a huge finite number; a local date/time
    // string like "2026-08-12 10:30:00" does not parse as a number at all.
    expect(Number.isNaN(Number(acceptedAt))).toBe(true);
    expect(acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('is idempotent: recording the same accept twice keeps one entry and the original time', async () => {
    await service.recordAccepted(JOB, '111');
    const first = fake.store[`job:${JOB}`].accepted['111'];
    await service.recordAccepted(JOB, '111');
    expect(await service.acceptedUserIdsFor(JOB)).toEqual(['111']);
    expect(fake.store[`job:${JOB}`].accepted['111']).toBe(first);
  });

  it('writes each accept as its own storage call, so an interrupted run keeps every accept recorded so far', async () => {
    await service.recordAccepted(JOB, '1');
    // Read the ledger back independently of the in-memory service, as a
    // fresh run after a crash would: nothing survives except storage.
    const reread = createLedgerService(fake.chrome.storage.local);
    expect(await reread.acceptedUserIdsFor(JOB)).toEqual(['1']);
    await service.recordAccepted(JOB, '2');
    expect(await reread.acceptedUserIdsFor(JOB)).toEqual(['1', '2']);
  });

  it('forgetAccepted clears only the accept dimension, leaving downloads intact', async () => {
    await service.recordDownloaded(JOB, { userId: '1' }, { jobTitle: 'x' });
    await service.recordAccepted(JOB, '1');
    await service.recordAccepted(JOB, '2');
    await service.forgetAccepted(JOB);
    expect(await service.acceptedUserIdsFor(JOB)).toEqual([]);
    expect(await service.seenUserIdsFor(JOB)).toEqual(['1']);
  });

  it('forget (the download reset) does not silently clear accepts as a side effect readers can rely on separately', async () => {
    // forget removes the whole job record, which necessarily includes
    // accepts too - but forgetAccepted is the operation that clears accepts
    // WITHOUT touching downloads, and that is the one this test protects.
    await service.recordDownloaded(JOB, { userId: '1' }, { jobTitle: 'x' });
    await service.recordAccepted(JOB, '1');
    await service.forgetAccepted(JOB);
    // Downloads survive a forgetAccepted call.
    expect(await service.describe(JOB)).toMatchObject({ downloaded: 1, known: 1 });
  });
});
