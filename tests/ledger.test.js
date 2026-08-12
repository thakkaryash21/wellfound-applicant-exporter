import { describe, it, expect, beforeEach } from 'vitest';
import { createLedger, MAX_SEEN } from '../src/lib/ledger.js';

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

  it(`evicts oldest ids beyond ${MAX_SEEN}`, async () => {
    const many = Array.from({ length: MAX_SEEN + 10 }, (_, i) => String(i));
    await ledger.markDownloaded('9100001', many, { jobTitle: 'x' });
    const { seenUserIds } = await ledger.get('9100001');
    expect(seenUserIds).toHaveLength(MAX_SEEN);
    expect(seenUserIds[0]).toBe('10');
    expect(seenUserIds.at(-1)).toBe(String(MAX_SEEN + 9));
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
      known: 1,
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
  it('separates what was downloaded from everyone who is known', async () => {
    await ledger.markDownloaded('1', ['1'], { jobTitle: 'a' });
    // An import teaches the ledger about people without fetching a file, so
    // `known` moves and `downloaded` deliberately does not.
    await ledger.adopt('1', ['2']);
    const job = await ledger.describe('1');
    expect(job.downloaded).toBe(1);
    expect(job.known).toBe(2);
  });

  it('describes a job that has never run without inventing anything', async () => {
    expect(await ledger.describe('nope')).toEqual({
      jobId: 'nope',
      jobTitle: null,
      downloaded: 0,
      known: 0,
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
