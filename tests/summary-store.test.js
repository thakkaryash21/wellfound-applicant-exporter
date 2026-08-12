import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import {
  SUMMARY_KEY,
  RUNNING_KEY,
  storeSummary,
  loadStoredSummary,
  markRunStarted,
  clearRunMarker,
  clearRun,
  takeInterruptedRun,
} from '../src/panel/summary-store.js';
import { summarize } from '../src/panel/summary.js';
import { createLedger } from '../src/lib/ledger.js';

let fake;

beforeEach(() => {
  fake = installFakeChrome();
});

afterEach(() => {
  fake.restore();
  vi.restoreAllMocks();
});

describe('the last summary', () => {
  // Comes back as it went in, with nothing added: it used to be tagged
  // `stale: true` for a Home screen that showed the last run under the job list,
  // and Home no longer shows it at all.
  it('survives the panel being closed, and comes back as it went in', async () => {
    await storeSummary({ at: 'now', headline: '3 downloaded', notes: [] });
    expect(await loadStoredSummary()).toEqual({ at: 'now', headline: '3 downloaded', notes: [] });
  });

  it('is null when nothing has been stored', async () => {
    expect(await loadStoredSummary()).toBe(null);
  });

  it('writes the scrubbed copy, never the one that names people', async () => {
    const summary = summarize({
      type: 'done',
      downloaded: 1,
      failed: 1,
      stoppedBecause: 'finished',
      failedNames: ['Jane Doe'],
    });
    await storeSummary(summary);
    expect(JSON.stringify(fake.store[SUMMARY_KEY])).not.toContain('Jane Doe');
    expect(summary.notes.join(' ')).toContain('Jane Doe');
  });

});

describe('the run marker', () => {
  it('is written when a run starts', async () => {
    await markRunStarted();
    expect(fake.store[RUNNING_KEY]).toMatchObject({ running: true });
    expect(typeof fake.store[RUNNING_KEY].startedAt).toBe('number');
  });

  it('is gone once the run reports', async () => {
    await markRunStarted();
    await clearRunMarker();
    expect(RUNNING_KEY in fake.store).toBe(false);
  });

  // Reading it is what reports the interruption, so a second read must not
  // report a second one.
  it('is read and cleared in one step', async () => {
    await markRunStarted();
    expect(await takeInterruptedRun()).toMatchObject({ running: true });
    expect(await takeInterruptedRun()).toBe(null);
  });

  it('is nothing to report when no run was in flight', async () => {
    expect(await takeInterruptedRun()).toBe(null);
  });
});

// Done is what disposes of a run. What it must dispose of, and what it must not
// touch, are two halves of the same promise: the record of a run goes, the
// record of who has been downloaded stays.
describe('Done', () => {
  it('clears the stored summary, so candidate-adjacent data does not outlive the screen', async () => {
    const summary = summarize({
      type: 'done',
      downloaded: 1,
      failed: 1,
      stoppedBecause: 'finished',
      failedNames: ['A. Applicant'],
    });
    await storeSummary(summary);
    await clearRun();
    expect(SUMMARY_KEY in fake.store).toBe(false);
    expect(await loadStoredSummary()).toBe(null);
    expect(JSON.stringify(fake.store)).not.toContain('A. Applicant');
  });

  // An interruption reaches the same screen, so pressing Done there has to
  // finish the marker off too or the notice returns on the next open.
  it('clears the run marker as well, so an interruption is reported once', async () => {
    await markRunStarted();
    await clearRun();
    expect(RUNNING_KEY in fake.store).toBe(false);
    expect(await takeInterruptedRun()).toBe(null);
  });

  it('never clears the dedup ledger: who has been downloaded is the Library\u2019s record', async () => {
    const ledger = createLedger(fake.chrome.storage.local);
    await ledger.markDownloaded('9100001', ['u1', 'u2', 'u3'], { jobTitle: 'Test Role' });
    await ledger.finishRun('9100001', { downloaded: 3, folder: 'wellfound-resumes' });
    await storeSummary({ headline: '3 downloaded', notes: [] });
    await markRunStarted();

    await clearRun();

    const record = await ledger.get('9100001');
    expect(record.seenUserIds).toEqual(['u1', 'u2', 'u3']);
    expect(record.jobTitle).toBe('Test Role');
    expect('job:9100001' in fake.store).toBe(true);
  });
});

// Six byte-identical try/catch blocks became one helper. What matters is the
// property they shared: storage here is a convenience, and losing it costs a
// notice, never the run.
describe('when chrome.storage is unavailable', () => {
  const boom = () => {
    throw new Error('storage gone');
  };

  beforeEach(() => {
    chrome.storage.local.get = boom;
    chrome.storage.local.set = boom;
    chrome.storage.local.remove = boom;
  });

  it('never throws out of any of them', async () => {
    await expect(storeSummary({ headline: 'x' })).resolves.toBeUndefined();
    await expect(clearRun()).resolves.toBeUndefined();
    await expect(markRunStarted()).resolves.toBeUndefined();
    await expect(clearRunMarker()).resolves.toBeUndefined();
  });

  it('reads as "nothing stored" rather than as an error', async () => {
    await expect(loadStoredSummary()).resolves.toBe(null);
    await expect(takeInterruptedRun()).resolves.toBe(null);
  });
});
