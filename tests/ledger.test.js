import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLedger } from '../src/lib/ledger.js';

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(key) {
      delete data[key];
    },
  };
}

let storage;
let ledger;

beforeEach(() => {
  storage = fakeStorage();
  ledger = createLedger(storage);
});

describe('ledger.get', () => {
  it('returns an empty record for an unknown job', async () => {
    const record = await ledger.get('9100001');
    expect(record).toMatchObject({ jobId: '9100001', seenUserIds: [], totalDownloaded: 0 });
  });

  it('migrates legacy seen ids into the canonical capture registry', async () => {
    await storage.set({
      'job:9100001': {
        jobId: '9100001',
        seenUserIds: ['1', '2'],
        totalDownloaded: 2,
      },
    });

    const record = await ledger.get('9100001');

    expect(record.captures).toEqual({ 1: 'legacy', 2: 'legacy' });
    expect(storage.data['job:9100001'].captures).toEqual({ 1: 'legacy', 2: 'legacy' });
    expect(storage.data['job:9100001'].seenUserIds).toBeUndefined();
  });

  it('marks a lossy legacy registry as migration-incomplete', async () => {
    await storage.set({
      'job:9100001': {
        jobId: '9100001',
        seenUserIds: ['1'],
        totalDownloaded: 2,
      },
    });
    expect((await ledger.describe('9100001')).migrationIncomplete).toBe(true);
  });

  it('clears migration-incomplete only through an explicit completed recovery', async () => {
    await storage.set({
      'job:9100001': {
        jobId: '9100001',
        seenUserIds: ['1'],
        totalDownloaded: 2,
      },
    });
    await ledger.markMigrationComplete('9100001');
    expect((await ledger.describe('9100001')).migrationIncomplete).toBe(false);
  });
});

describe('ledger.markDownloaded', () => {
  it('records ids and the job title', async () => {
    await ledger.markDownloaded('9100001', ['1', '2'], { jobTitle: 'Backend Engineer' });
    const record = await ledger.get('9100001');
    expect(record.seenUserIds).toEqual(['1', '2']);
    expect(record.jobTitle).toBe('Backend Engineer');
    expect(record.totalDownloaded).toBe(2);
  });

  it('does not duplicate ids across calls', async () => {
    await ledger.markDownloaded('9100001', ['1'], { jobTitle: 'x' });
    await ledger.markDownloaded('9100001', ['1', '2'], { jobTitle: 'x' });
    expect((await ledger.get('9100001')).seenUserIds).toEqual(['1', '2']);
    expect((await ledger.get('9100001')).totalDownloaded).toBe(2);
  });

  it('never silently evicts captured identities beyond the old 5,000-id cap', async () => {
    const many = Array.from({ length: 5010 }, (_, i) => String(i));
    await ledger.markDownloaded('9100001', many, { jobTitle: 'x' });
    const { seenUserIds } = await ledger.get('9100001');
    expect(seenUserIds).toHaveLength(5010);
    expect(seenUserIds[0]).toBe('0');
    expect(seenUserIds.at(-1)).toBe('5009');
  });

  it('writes under a namespaced key so it never collides with settings', async () => {
    await ledger.markDownloaded('9100001', ['1'], { jobTitle: 'x' });
    expect(Object.keys(storage.data)).toEqual(['job:9100001']);
  });

  it('counts one person once even when they hold two applications', async () => {
    await ledger.markDownloaded('9100001', ['111', '111'], { jobTitle: 'x' });
    const record = await ledger.get('9100001');
    expect(record.seenUserIds).toEqual(['111']);
    expect(record.totalDownloaded).toBe(1);
  });
});

describe('ledger.adopt', () => {
  // Adopt takes bare userIds, which is all a CSV import has: the CSV carries
  // userIds and nothing else, and the ledger keys on userId alone.
  it('adds ids without changing totalDownloaded', async () => {
    await ledger.adopt('9100001', ['1', '2']);
    const record = await ledger.get('9100001');
    expect(record.seenUserIds).toEqual(['1', '2']);
    expect(record.totalDownloaded).toBe(0);
  });

  it('adoption never claims a lossy migration is complete', async () => {
    await storage.set({
      'job:9100001': { jobId: '9100001', seenUserIds: ['1'], totalDownloaded: 2 },
    });
    await ledger.adopt('9100001', ['1', '2'], 'imported');
    expect((await ledger.describe('9100001')).migrationIncomplete).toBe(true);
  });
});

describe('ledger.finishRun', () => {
  it('stamps the run time', async () => {
    await ledger.markDownloaded('9100001', ['1'], { jobTitle: 'x' });
    await ledger.finishRun('9100001', {});
    const record = await ledger.get('9100001');
    expect(typeof record.lastRunAt).toBe('string');
    // The run's own count is deliberately not stored: nothing ever read it,
    // and totalDownloaded is the number the Library shows.
    expect('lastRunCount' in record).toBe(false);
  });

  it('remembers the folder the run wrote to, so re-downloads land beside it', async () => {
    await ledger.finishRun('9100001', { folder: 'clients/acme' });
    expect((await ledger.get('9100001')).folder).toBe('clients/acme');
  });

  it('keeps the previous folder when a later run does not name one', async () => {
    await ledger.finishRun('9100001', { folder: 'clients/acme' });
    await ledger.finishRun('9100001', {});
    expect((await ledger.get('9100001')).folder).toBe('clients/acme');
  });
});

// Moved from ledger.all, which handed the stored records back whole. The
// Library then read totalDownloaded, jobTitle and lastRunAt straight off the
// storage shape, which is exactly what describeAll exists to stop.
describe('ledger.describeAll', () => {
  it('normalizes legacy records before describing them', async () => {
    await storage.set({
      'job:9100001': { jobId: '9100001', seenUserIds: ['1'], totalDownloaded: 2 },
    });
    expect(await ledger.describeAll()).toEqual([
      expect.objectContaining({ jobId: '9100001', migrationIncomplete: true }),
    ]);
    expect(storage.data['job:9100001'].captures).toEqual({ 1: 'legacy' });
  });

  it('returns every job and ignores unrelated keys', async () => {
    await ledger.markDownloaded('1', ['1'], { jobTitle: 'a' });
    await ledger.markDownloaded('2', ['2'], { jobTitle: 'b' });
    await storage.set({ settings: { folder: 'x' } });
    const all = await ledger.describeAll();
    expect(all.map((r) => r.jobId).sort()).toEqual(['1', '2']);
  });

  it('describes each job in named fields, not in the stored shape', async () => {
    await ledger.markDownloaded('1', ['1'], { jobTitle: 'a' });
    const [job] = await ledger.describeAll();
    expect(job).toEqual({
      jobId: '1',
      jobTitle: 'a',
      downloaded: 1,
      migrationIncomplete: false,
      lastRunAt: null,
      folder: null,
    });
    expect(job.seenUserIds).toBeUndefined();
  });
});

describe('ledger.seenUserIds', () => {
  it('is everyone the ledger will not fetch again', async () => {
    await ledger.markDownloaded('1', ['1'], { jobTitle: 'a' });
    await ledger.adopt('1', ['2']);
    expect((await ledger.seenUserIds('1')).sort()).toEqual(['1', '2']);
  });

  it('is empty for a job the ledger has never seen', async () => {
    expect(await ledger.seenUserIds('nope')).toEqual([]);
  });
});

describe('ledger.describe', () => {
  it('separates what was downloaded from everyone the registry holds', async () => {
    await ledger.markDownloaded('1', ['1'], { jobTitle: 'a' });
    // An import teaches the ledger about people without fetching a file, so the
    // capture registry grows and `downloaded` deliberately does not. The
    // registry is read as identities now; the count that used to sit on
    // `describe` had no reader left.
    await ledger.adopt('1', ['2']);
    expect((await ledger.describe('1')).downloaded).toBe(1);
    expect((await ledger.seenUserIds('1')).sort()).toEqual(['1', '2']);
  });

  it('describes a job that has never run without inventing anything', async () => {
    expect(await ledger.describe('nope')).toEqual({
      jobId: 'nope',
      jobTitle: null,
      downloaded: 0,
      migrationIncomplete: false,
      lastRunAt: null,
      folder: null,
    });
  });
});

describe('ledger.forget', () => {
  it('removes the job entirely', async () => {
    await ledger.markDownloaded('1', ['1'], { jobTitle: 'a' });
    await ledger.forget('1');
    expect(await ledger.describeAll()).toEqual([]);
    expect((await ledger.get('1')).seenUserIds).toEqual([]);
  });
});

describe('ledger.markAccepted', () => {
  it('records the userId as accepted for that job', async () => {
    await ledger.markAccepted('1', '111');
    expect(await ledger.acceptedUserIds('1')).toEqual(['111']);
  });

  it('stamps a local date/time string, not a raw timestamp', async () => {
    await ledger.markAccepted('1', '111');
    const record = await ledger.get('1');
    expect(typeof record.accepted['111']).toBe('string');
    expect(record.accepted['111']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('is idempotent: a second call for the same userId does not overwrite the first acceptedAt', async () => {
    // Fake timers force the clock to actually move between the two calls -
    // real time can land both calls in the same second, which would make a
    // broken (non-idempotent) implementation pass this test by coincidence.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T10:00:00'));
    await ledger.markAccepted('1', '111');
    const first = (await ledger.get('1')).accepted['111'];
    vi.setSystemTime(new Date('2026-08-12T10:05:00'));
    await ledger.markAccepted('1', '111');
    const record = await ledger.get('1');
    vi.useRealTimers();
    expect(Object.keys(record.accepted)).toEqual(['111']);
    expect(record.accepted['111']).toBe(first);
  });

  it('does not affect seenUserIds or totalDownloaded', async () => {
    await ledger.markDownloaded('1', ['1'], { jobTitle: 'a' });
    await ledger.markAccepted('1', '2');
    const record = await ledger.get('1');
    expect(record.seenUserIds).toEqual(['1']);
    expect(record.totalDownloaded).toBe(1);
  });

  it('keeps accepts separate per job', async () => {
    await ledger.markAccepted('1', '111');
    await ledger.markAccepted('2', '222');
    expect(await ledger.acceptedUserIds('1')).toEqual(['111']);
    expect(await ledger.acceptedUserIds('2')).toEqual(['222']);
  });
});

describe('ledger.acceptedUserIds', () => {
  it('is empty for a job the ledger has never seen', async () => {
    expect(await ledger.acceptedUserIds('nope')).toEqual([]);
  });
});

describe('ledger.forgetAccepted', () => {
  it('clears accepts but leaves downloads untouched', async () => {
    await ledger.markDownloaded('1', ['1'], { jobTitle: 'a' });
    await ledger.markAccepted('1', '1');
    await ledger.forgetAccepted('1');
    expect(await ledger.acceptedUserIds('1')).toEqual([]);
    const record = await ledger.get('1');
    expect(record.seenUserIds).toEqual(['1']);
    expect(record.totalDownloaded).toBe(1);
  });
});

// A send nobody has vouched for is a QUESTION, and the ledger has to be able to
// hold one without answering it. Both wrong answers have been shipped: writing
// it as an accept permanently wrote off somebody who was never messaged, and
// writing nothing at all let a later run message somebody who might have been.
describe('provisional accepts', () => {
  it('is not an accept, and does not appear as one', async () => {
    await ledger.markProvisional('1', '70000001');
    expect(await ledger.provisionalUserIds('1')).toEqual(['70000001']);
    // The whole point: nothing here claims a message arrived.
    expect(await ledger.acceptedUserIds('1')).toEqual([]);
  });

  it('keeps the moment of the click when asked twice', async () => {
    await ledger.markProvisional('1', '70000001');
    const first = (await ledger.get('1')).provisional['70000001'];
    await ledger.markProvisional('1', '70000001');
    expect((await ledger.get('1')).provisional['70000001']).toBe(first);
  });

  it('becomes a permanent accept when confirmed, and stops being a question', async () => {
    await ledger.markProvisional('1', '70000001');
    await ledger.confirmProvisional('1', '70000001');
    expect(await ledger.acceptedUserIds('1')).toEqual(['70000001']);
    expect(await ledger.provisionalUserIds('1')).toEqual([]);
  });

  // The column asks when the message went out, not when we found out.
  it('carries the click stamp into the accept rather than restamping it', async () => {
    await ledger.markProvisional('1', '70000001');
    const clicked = (await ledger.get('1')).provisional['70000001'];
    await ledger.confirmProvisional('1', '70000001');
    expect((await ledger.get('1')).accepted['70000001']).toBe(clicked);
  });

  it('leaves nothing at all behind when released', async () => {
    await ledger.markProvisional('1', '70000001');
    await ledger.releaseProvisional('1', '70000001');
    expect(await ledger.provisionalUserIds('1')).toEqual([]);
    // Not moved to accepted, not remembered anywhere. That is what makes this
    // person eligible for a later run.
    expect(await ledger.acceptedUserIds('1')).toEqual([]);
  });

  // The guard on the one operation that can make somebody messageable again.
  it('can never release a send something has vouched for', async () => {
    await ledger.markAccepted('1', '70000001');
    await ledger.releaseProvisional('1', '70000001');
    expect(await ledger.acceptedUserIds('1')).toEqual(['70000001']);
  });

  it('keeps questions separate per job', async () => {
    await ledger.markProvisional('1', '111');
    await ledger.markProvisional('2', '222');
    expect(await ledger.provisionalUserIds('1')).toEqual(['111']);
    expect(await ledger.provisionalUserIds('2')).toEqual(['222']);
  });

  it('is empty for a job the ledger has never seen', async () => {
    expect(await ledger.provisionalUserIds('nope')).toEqual([]);
  });

  // Clearing who has been messaged clears the unanswered questions too:
  // leaving them would skip people on the strength of a record the operator
  // just asked to be rid of.
  it('is cleared by forgetAccepted', async () => {
    await ledger.markProvisional('1', '70000001');
    await ledger.forgetAccepted('1');
    expect(await ledger.provisionalUserIds('1')).toEqual([]);
  });
});
