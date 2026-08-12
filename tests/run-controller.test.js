import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { toCsv } from '../src/lib/csv.js';
import { traceText } from '../src/panel/trace-view.js';
import { RESUME_STATUS } from '../src/lib/csv.js';
import { summarize } from '../src/panel/summary.js';
import { CX } from '../src/lib/messages.js';
import { APPLICANTS_URL, NO_WELLFOUND_TAB } from '../src/panel/tab-driver.js';

const JOB = '9100001';
const TAB = 7;

// A stand-in for the page's Apollo client: it answers the same three messages
// bridge.js does, over the same node shape collector.js returns.
function fakePage({
  people,
  jobTitle = 'Platform Engineer',
  actionableCount = null,
  // A whole recruiter account, for the runs that walk more than one role.
  jobs = null,
  peopleByJob = null,
}) {
  const calls = { fetches: [], listJobs: 0 };
  const server = async (message, context) => {
    // The probe answers for the job the tab is actually showing, as a real
    // document does: readiness alone was answerable by a stale page.
    if (message.type === CX.QUERY_READY) {
      const jobId = String(context?.tab?.url ?? '').match(/jobs\/(\d+)/)?.[1] ?? null;
      return { ok: true, data: jobId ? { jobId } : null };
    }
    if (message.type === CX.LIST_JOBS) {
      calls.listJobs += 1;
      const listing = typeof jobs === 'function' ? jobs() : jobs;
      return {
        ok: true,
        data: listing ?? [{ jobId: JOB, title: jobTitle, actionableCount }],
      };
    }
    if (message.type === CX.FETCH_PAGE) {
      const { pageSize, after } = message.payload;
      calls.fetches.push(message.payload);
      const roster = peopleByJob?.[message.payload.jobId] ?? people;
      const start = after ? Number(after) : 0;
      const slice = roster.slice(start, start + pageSize);
      return {
        ok: true,
        data: {
          jobTitle,
          bucket: 'IN_REVIEW',
          // Wellfound's shapes, confirmed live: submittedAt a number of Unix
          // seconds, currentLocation an object. Both used to be pre-flattened
          // here, which meant this end-to-end suite never crossed formatDate's
          // numeric branch or locationName() at all. userId is sent as the
          // caller gave it - person() makes strings, numericPerson() makes
          // numbers - because which one Wellfound sends was never observed and
          // normalize.js has to survive either.
          edges: slice.map((p) => ({
            id: `JP${p.userId}`,
            currentApplication: { submittedAt: 1786465883 },
            recruitCandidate: {
              masked: Boolean(p.masked),
              candidate: {
                userId: p.userId,
                name: p.name,
                currentLocation: {
                  __typename: 'Location',
                  id: `L${p.userId}`,
                  name: 'Berlin',
                  country: 'Germany',
                  state: null,
                },
                resumeUrl:
                  p.resumeUrl === undefined
                    ? `/link/${p.userId}/tok/resume_url`
                    : p.resumeUrl,
              },
            },
          })),
          endCursor: String(start + slice.length),
          hasNextPage: start + slice.length < roster.length,
        },
      };
    }
    return { ok: false, error: `unexpected message ${message.type}` };
  };
  server.calls = calls;
  return server;
}

const person = (userId, name = `Person ${userId}`) => ({ userId, name });
// The same applicant with the id sent as a number. Whether Wellfound sends a
// string or a number was never observed raw, so the suite runs both through the
// whole pipeline rather than asserting one as the truth.
const numericPerson = (userId, name = `Person ${userId}`) => ({ userId: Number(userId), name });

async function loadController() {
  vi.resetModules();
  const { createController } = await import('../src/panel/run-controller.js');
  return createController;
}

let fake;
let sleeps;
let events;
let objectUrls;

function setup({
  people = [],
  storage = {},
  tabUrl = `${APPLICANTS_URL}jobs/${JOB}`,
  jobs = null,
  peopleByJob = null,
  actionableCount = null,
} = {}) {
  const page = fakePage({ people, jobs, peopleByJob, actionableCount });
  fake = installFakeChrome({ tabs: [{ id: TAB, url: tabUrl }], pages: { [TAB]: page }, storage });
  return page;
}

// `hook` runs after every event is recorded, which is the only deterministic
// place a test can press Stop from: it fires between the run's own steps rather
// than on a timer that may or may not land inside the walk.
async function controllerFor({ hook } = {}) {
  const createController = await loadController();
  const controller = createController({
    onEvent: (event) => {
      events.push(event);
      hook?.(event, controller);
    },
    // Instant, so a twenty-candidate walk does not take a real minute. Every
    // delay it was asked for is still recorded, and asserted on below.
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return controller;
}

beforeEach(() => {
  sleeps = [];
  events = [];
  objectUrls = [];
  // Not available in node, and the CSV writer needs it.
  globalThis.URL.createObjectURL = (blob) => {
    objectUrls.push(blob);
    return `blob:wfx/${objectUrls.length}`;
  };
  globalThis.URL.revokeObjectURL = () => {};
});

afterEach(() => {
  fake?.restore();
  delete globalThis.URL.createObjectURL;
  delete globalThis.URL.revokeObjectURL;
});

const ledgerRecord = () => fake.store[`job:${JOB}`];

describe('startRun', () => {
  it('downloads every new applicant, names the file and records them', async () => {
    setup({ people: [person('7700001', 'Jane Doe'), person('7700002', 'John Doe')] });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
    });

    const names = fake.items.filter((i) => i.url.includes('resume_url')).map((i) => i.filename);
    expect(names).toEqual([
      'resumes/Jane Doe-7700001-9100001.pdf',
      'resumes/John Doe-7700002-9100001.pdf',
    ]);
    expect(ledgerRecord().seenUserIds).toEqual(['7700001', '7700002']);
    expect(ledgerRecord().totalDownloaded).toBe(2);
  });

  // C3: the fixtures used to hand the run values already in our own shape, so
  // nothing here ever crossed the coercions. These three assert the CSV the user
  // actually opens, against the shapes Wellfound actually sends.
  it('writes the live shapes out as a date and a city, not a timestamp and an object', async () => {
    setup({ people: [person('7700001', 'Jane Doe')] });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
    });
    const csv = await objectUrls[0].text();
    expect(csv).toContain('2026-08-11');
    expect(csv).not.toContain('1786465883');
    expect(csv).toContain('Berlin');
    expect(csv).not.toContain('[object Object]');
  });

  // The failure the String() coercion exists to prevent: if a numeric userId
  // reached the ledger unconverted, the next run's `seen.has()` would miss and
  // the extension would fetch the same person again, forever.
  it('does not re-download a numerically-identified applicant on a second run', async () => {
    setup({
      people: [numericPerson('7700001', 'Jane Doe')],
      storage: { [`job:${JOB}`]: { jobId: JOB, seenUserIds: ['7700001'], totalDownloaded: 1 } },
    });
    fake.addHistory({
      filename: 'resumes/Jane Doe-7700001-9100001.pdf',
      url: 'https://wellfound.com/link/7700001/tok/resume_url',
      state: 'complete',
      exists: true,
    });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
    });
    // The pre-seeded history item is in `fake.items` by construction, so assert
    // on what this run actually asked the browser to fetch.
    expect(fake.calls.downloads.filter((d) => String(d.url).includes('resume_url'))).toEqual([]);
    const done = events.find((e) => e.type === 'done');
    expect(done.downloaded).toBe(0);
  });

  it('reports what it did on a done event', async () => {
    setup({ people: [person('7700001'), { ...person('7700002'), resumeUrl: null }] });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
    });
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ downloaded: 1, skippedNoResume: 1, stoppedBecause: 'finished' });
  });

  // A2: a preview counts nobody into `downloaded`, so without its own number the
  // summary of a 400-applicant preview had nothing at all to report.
  it('reports what a dry run previewed on the done event', async () => {
    setup({ people: [person('7700001'), person('7700002')] });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
      dryRun: true,
    });
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ dryRun: true, previewed: 2, downloaded: 0 });
  });

  // C2: the preview used to ignore the per-role limit entirely, so the button
  // promised 3, the run walked all 8, and the post-run screen offered to fetch a
  // number the real run would have refused. Every number the UI derives comes
  // off this one event, so this is where they are made to agree.
  it('stops a preview at the per-role limit and reports that number', async () => {
    setup({ people: Array.from({ length: 8 }, (_, i) => person(`770000${i + 1}`)) });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 3 }],
      folder: 'resumes',
      pageSize: 10,
      dryRun: true,
    });
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ dryRun: true, previewed: 3, downloaded: 0 });
    expect(done.jobs[0]).toMatchObject({ jobId: JOB, limit: 3, stoppedBecause: 'limit' });
    // The number the post-run screen offers to fetch is the number the live run
    // would actually fetch, not the size of the queue.
    expect(summarize(done).notes.join(' ')).toContain('these 3 resumes');
  });

  it('writes a CSV for the job', async () => {
    setup({ people: [person('7700001')] });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
    });
    const csv = fake.calls.downloads.find((d) => d.filename?.endsWith('.csv'));
    expect(csv.filename).toMatch(/^resumes\/applicants-9100001-\d{4}-\d{2}-\d{2}\.csv$/);
    // What the option asked for is not what lands on disk. The file the browser
    // actually wrote is the one the field run got wrong, so assert on that.
    const item = fake.items.find((i) => String(i.url).startsWith('blob:'));
    expect(item.filename).toMatch(/^resumes\/applicants-9100001-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('dates the CSV on the user\u2019s clock, not on UTC\u2019s', async () => {
    // 19:23:55 local on 11 August, which is 02:23:55Z on the 12th. The field
    // run wrote `applicants-9100001-2026-08-12.csv` beside a report named
    // run-2026-08-11-192355: two files of the same run, two different days.
    // The clock only. The run's own pacing uses timers, and freezing those
    // would hang the walk this test is driving.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-12T02:23:55.586Z'));
    try {
      setup({ people: [person('7700001')] });
      const controller = await controllerFor();
      await controller.startRun({
        jobs: [{ jobId: JOB, limit: 250 }],
        folder: 'resumes',
        pageSize: 10,
      });
      const item = fake.items.find((i) => String(i.url).startsWith('blob:'));
      expect(item.filename).toBe('resumes/applicants-9100001-2026-08-11.csv');
    } finally {
      vi.useRealTimers();
    }
  });

  it('paces itself between downloads', async () => {
    setup({ people: [person('7700001'), person('7700002')] });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
    });
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(1500);
  });

  it('does not fetch anyone the ledger already knows', async () => {
    setup({
      people: [person('7700001'), person('7700002')],
      storage: { [`job:${JOB}`]: { jobId: JOB, seenUserIds: ['7700001'], totalDownloaded: 1 } },
    });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
    });
    const names = fake.items.filter((i) => i.url.includes('resume_url')).map((i) => i.filename);
    expect(names).toEqual(['resumes/Person 7700002-7700002-9100001.pdf']);
  });

  // Reconcile before the walk: a file the user deleted is missing from disk, and
  // the run must quietly fetch it again rather than trust the ledger.
  it('re-fetches someone the ledger knows whose file is gone from disk', async () => {
    setup({
      people: [person('7700001')],
      storage: { [`job:${JOB}`]: { jobId: JOB, seenUserIds: ['7700001'], totalDownloaded: 1 } },
    });
    fake.addHistory({
      filename: 'resumes/Person 7700001-7700001-9100001.pdf',
      url: 'https://wellfound.com/link/7700001/tok/resume_url',
      state: 'complete',
      exists: false,
    });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
    });
    expect(events.find((e) => e.type === 'done').downloaded).toBe(1);
  });

  it('leaves someone alone whose file is still on disk', async () => {
    setup({
      people: [person('7700001')],
      storage: { [`job:${JOB}`]: { jobId: JOB, seenUserIds: ['7700001'], totalDownloaded: 1 } },
    });
    fake.addHistory({
      filename: 'resumes/Person 7700001-7700001-9100001.pdf',
      url: 'https://wellfound.com/link/7700001/tok/resume_url',
      state: 'complete',
      exists: true,
    });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
    });
    expect(events.find((e) => e.type === 'done').downloaded).toBe(0);
  });

  it('reports the failure on done rather than losing the counts', async () => {
    setup({ people: [person('7700001')], tabUrl: 'https://example.com/' });
    const controller = await controllerFor();
    await expect(
      controller.startRun({ jobs: [{ jobId: JOB, limit: 250 }], folder: 'resumes', pageSize: 10 }),
    ).rejects.toThrow(NO_WELLFOUND_TAB);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ stoppedBecause: 'error' });
  });
});

// The owner runs five roles and wants all of one and the first twenty-five of
// another. One run, two different answers.
describe('a run over several roles', () => {
  const OTHER = '9100002';
  const twoRoles = (extra = {}) =>
    setup({
      jobs: [
        { jobId: JOB, title: 'Backend Engineer', actionableCount: 3 },
        { jobId: OTHER, title: 'Data Scientist', actionableCount: 3 },
      ],
      peopleByJob: {
        [JOB]: [person('7700001'), person('7700002'), person('7700003')],
        [OTHER]: [person('7800001'), person('7800002'), person('7800003')],
      },
      ...extra,
    });

  it('gives each role the number of people that role asked for', async () => {
    twoRoles();
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [
        { jobId: JOB, limit: Infinity },
        { jobId: OTHER, limit: 1 },
      ],
      folder: 'resumes',
      pageSize: 10,
    });
    const names = fake.items.filter((i) => i.url.includes('resume_url')).map((i) => i.filename);
    expect(names).toEqual([
      'resumes/Person 7700001-7700001-9100001.pdf',
      'resumes/Person 7700002-7700002-9100001.pdf',
      'resumes/Person 7700003-7700003-9100001.pdf',
      'resumes/Person 7800001-7800001-9100002.pdf',
    ]);
  });

  it('reports per role which one stopped at the number it was given', async () => {
    twoRoles();
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [
        { jobId: JOB, limit: Infinity },
        { jobId: OTHER, limit: 1 },
      ],
      folder: 'resumes',
      pageSize: 10,
    });
    const done = events.find((e) => e.type === 'done');
    expect(done.jobs).toMatchObject([
      { jobId: JOB, jobTitle: 'Backend Engineer', limit: Infinity, stoppedBecause: 'exhausted' },
      { jobId: OTHER, jobTitle: 'Data Scientist', limit: 1, stoppedBecause: 'limit' },
    ]);
  });

  // I2: the only account of a role that exported nothing was a job_note into the
  // live region, gone within seconds. The post-run screen said "downloaded" and
  // the user hunted for a CSV that was never written.
  it('reports per role whether a CSV was written, and names the one that was not', async () => {
    setup({
      jobs: [
        { jobId: JOB, title: 'Backend Engineer', actionableCount: 3 },
        { jobId: OTHER, title: 'Data Scientist', actionableCount: 0 },
      ],
      peopleByJob: {
        [JOB]: [person('7700001'), person('7700002')],
        // Nobody in the review bucket: no records, so no file.
        [OTHER]: [],
      },
    });
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [{ jobId: JOB }, { jobId: OTHER }],
      folder: 'resumes',
      pageSize: 10,
    });

    const done = events.find((e) => e.type === 'done');
    expect(done.jobs).toMatchObject([
      { jobId: JOB, wroteCsv: true },
      { jobId: OTHER, wroteCsv: false },
    ]);
    // One CSV on disk, and the summary says whose is missing and why.
    const csvs = fake.calls.downloads.filter((d) => d.filename?.endsWith('.csv'));
    expect(csvs).toHaveLength(1);
    expect(summarize(done).notes).toContain(
      'No CSV for Data Scientist: that role had no applicants to export.',
    );
  });

  it('names the roles it never reached when the run dies partway', async () => {
    twoRoles();
    const controller = await controllerFor();
    const original = fake.chrome.tabs.update;
    fake.chrome.tabs.update = async (tabId, props) => {
      if (props.url?.includes(OTHER)) throw new Error('Tab was closed');
      return original(tabId, props);
    };
    await expect(
      controller.startRun({
        jobs: [{ jobId: JOB }, { jobId: OTHER }],
        folder: 'resumes',
        pageSize: 10,
      }),
    ).rejects.toThrow('Tab was closed');
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ stoppedBecause: 'error', notWalked: ['Data Scientist'] });
  });

  // No limit at all is the default the panel sends for "all new".
  it('walks a role to the end when it was given no limit', async () => {
    twoRoles();
    const controller = await controllerFor();
    await controller.startRun({ jobs: [{ jobId: JOB }], folder: 'resumes', pageSize: 10 });
    expect(events.find((e) => e.type === 'done')).toMatchObject({ downloaded: 3 });
  });
});

// The job overview page caches every listing but counts only the one being
// viewed. Without the counts the panel cannot say how many people are new.
describe('listJobs hydration', () => {
  const OTHER = '9100002';
  function withMissingCounts() {
    let navigated = false;
    const page = setup({
      tabUrl: 'https://wellfound.com/recruit/jobs/9100001',
      jobs: () =>
        navigated
          ? [
              { jobId: JOB, title: 'Backend Engineer', actionableCount: 4 },
              { jobId: OTHER, title: 'Data Scientist', actionableCount: 7 },
            ]
          : [
              { jobId: JOB, title: 'Backend Engineer', actionableCount: 4 },
              { jobId: OTHER, title: 'Data Scientist', actionableCount: null },
            ],
    });
    const original = fake.chrome.tabs.update;
    fake.chrome.tabs.update = async (tabId, props) => {
      navigated = true;
      return original(tabId, props);
    };
    return page;
  }

  it('loads an applicant list once to fill in the missing counts', async () => {
    withMissingCounts();
    const controller = await controllerFor();
    const jobs = await controller.listJobs();
    expect(jobs.map((j) => j.actionableCount)).toEqual([4, 7]);
    expect(fake.calls.updates).toHaveLength(1);
  });

  it('says so while it happens, and only when it happens', async () => {
    withMissingCounts();
    const controller = await controllerFor();
    const told = [];
    await controller.listJobs({ onHydrating: () => told.push('reading') });
    expect(told).toEqual(['reading']);
  });

  it('does not navigate when every count is already there', async () => {
    setup({
      jobs: [{ jobId: JOB, title: 'Backend Engineer', actionableCount: 4 }],
    });
    const controller = await controllerFor();
    const told = [];
    await controller.listJobs({ onHydrating: () => told.push('reading') });
    expect(fake.calls.updates).toEqual([]);
    expect(told).toEqual([]);
  });

  // A count that stays null after hydration is a fact about the job, not a
  // reason to send the tab travelling on every panel load.
  it('navigates at most once per panel, however often the panel reloads', async () => {
    setup({
      tabUrl: 'https://wellfound.com/recruit/jobs/9100001',
      jobs: [{ jobId: JOB, title: 'Backend Engineer', actionableCount: null }],
    });
    const controller = await controllerFor();
    await controller.listJobs();
    await controller.listJobs();
    expect(fake.calls.updates).toHaveLength(1);
  });

  it('keeps the jobs it already has when that navigation fails', async () => {
    setup({
      tabUrl: 'https://wellfound.com/recruit/jobs/9100001',
      jobs: [{ jobId: JOB, title: 'Backend Engineer', actionableCount: null }],
    });
    fake.chrome.tabs.update = async () => {
      throw new Error('Tab was closed');
    };
    const controller = await controllerFor();
    const jobs = await controller.listJobs();
    expect(jobs).toMatchObject([{ jobId: JOB, title: 'Backend Engineer', estimatedNew: null }]);
  });

  // The flag used to be set before the try, so one closed tab disabled hydration
  // for the life of the panel and those roles read "applicant count not loaded
  // yet" for ever with no way back short of reopening it.
  it('tries again after a failed navigation', async () => {
    withMissingCounts();
    const working = fake.chrome.tabs.update;
    fake.chrome.tabs.update = async () => {
      throw new Error('Tab was closed');
    };
    const controller = await controllerFor();
    expect((await controller.listJobs()).map((j) => j.actionableCount)).toEqual([4, null]);

    fake.chrome.tabs.update = working;
    expect((await controller.listJobs()).map((j) => j.actionableCount)).toEqual([4, 7]);
  });
});

// I1: `grep -c abort tests/run-controller.test.js` used to return 0. A leaked
// lock bricks the panel until the user reloads it, and a lost reclassification
// means "Stopped by you" reads on screen as a clean, complete export.
describe('abort', () => {
  const OTHER = '9100002';
  const twoRoles = () =>
    setup({
      jobs: [
        { jobId: JOB, title: 'Backend Engineer', actionableCount: 3 },
        { jobId: OTHER, title: 'Data Scientist', actionableCount: 3 },
      ],
      peopleByJob: {
        [JOB]: [person('7700001'), person('7700002'), person('7700003')],
        [OTHER]: [person('7800001'), person('7800002'), person('7800003')],
      },
    });

  const runOpts = (jobs) => ({ jobs, folder: 'resumes', pageSize: 10 });

  describe('the wasRunning distinction', () => {
    it('reports that nothing was running when the panel is idle', async () => {
      setup({ people: [person('7700001')] });
      const controller = await controllerFor();
      expect(controller.abort()).toEqual({ aborted: false });
    });

    it('reports that a run was stopped when one was in flight', async () => {
      setup({ people: [person('7700001'), person('7700002'), person('7700003')] });
      let result;
      const controller = await controllerFor({
        hook: (event, c) => {
          if (event.type === 'candidate' && result === undefined) result = c.abort();
        },
      });
      await controller.startRun(runOpts([{ jobId: JOB, limit: 250 }]));
      expect(result).toEqual({ aborted: true });
    });

  });

  // The `if (signal.aborted) break` at the top of the per-job loop. Without it,
  // pressing Stop during role one would navigate the tab to role two and walk
  // it to the end anyway.
  it('stops a multi-role run between jobs and names the role it never started', async () => {
    twoRoles();
    const controller = await controllerFor({
      hook: (event, c) => {
        if (event.type === 'job_done' && event.jobId === JOB) c.abort();
      },
    });
    await controller.startRun(runOpts([{ jobId: JOB }, { jobId: OTHER }]));

    const done = events.find((e) => e.type === 'done');
    expect(done.jobs.map((j) => j.jobId)).toEqual([JOB]);
    expect(done.notWalked).toEqual(['Data Scientist']);
    // Role one's work is kept: it finished before Stop was pressed.
    expect(done.downloaded).toBe(3);
    expect(fake.items.filter((i) => i.url.includes('9100002'))).toEqual([]);
  });

  // The reclassification the post-run screen depends on. Pressing Stop used to
  // leave stoppedBecause at 'finished', so a run halted partway reported as a
  // complete export.
  describe("the 'aborted' reclassification", () => {
    it("turns a run stopped by the user into stoppedBecause 'aborted'", async () => {
      setup({ people: [person('7700001'), person('7700002'), person('7700003')] });
      const controller = await controllerFor({
        hook: (event, c) => {
          if (event.type === 'candidate') c.abort();
        },
      });
      await controller.startRun(runOpts([{ jobId: JOB, limit: 250 }]));
      const done = events.find((e) => e.type === 'done');
      expect(done.stoppedBecause).toBe('aborted');
      expect(done.downloaded).toBeLessThan(3);
    });

    it('says so on the post-run screen rather than reporting a clean run', async () => {
      setup({ people: [person('7700001'), person('7700002'), person('7700003')] });
      const controller = await controllerFor({
        hook: (event, c) => {
          if (event.type === 'candidate') c.abort();
        },
      });
      await controller.startRun(runOpts([{ jobId: JOB, limit: 250 }]));
      const headline = summarize(events.find((e) => e.type === 'done')).headline;
      expect(headline).toContain('Stopped by you');
    });

    it("leaves a run that finished on its own reading 'finished'", async () => {
      setup({ people: [person('7700001')] });
      const controller = await controllerFor();
      await controller.startRun(runOpts([{ jobId: JOB, limit: 250 }]));
      const done = events.find((e) => e.type === 'done');
      expect(done.stoppedBecause).toBe('finished');
      expect(summarize(done).headline).not.toContain('Stopped by you');
    });
  });

  // A leaked lock bricks the panel: every later run throws "A run is already in
  // progress" until the user reloads it, and nothing on screen says why.
  it('releases the tab lock, so a run can be started again after a stop', async () => {
    setup({ people: [person('7700001'), person('7700002'), person('7700003')] });
    const controller = await controllerFor({
      hook: (event, c) => {
        if (event.type === 'candidate' && events.filter((e) => e.type === 'done').length === 0) {
          c.abort();
        }
      },
    });
    await controller.startRun(runOpts([{ jobId: JOB, limit: 250 }]));
    expect(events.find((e) => e.type === 'done').stoppedBecause).toBe('aborted');

    // The lock is free, and the second run is a fresh AbortController rather
    // than the aborted one - it must be able to walk to the end.
    await controller.startRun(runOpts([{ jobId: JOB, limit: 250 }]));
    const second = events.filter((e) => e.type === 'done')[1];
    expect(second.stoppedBecause).toBe('finished');
  });

});

describe('the shared tab lock', () => {
  it('refuses a re-download while a run holds the tab', async () => {
    setup({ people: [person('7700001'), person('7700002')] });
    const controller = await controllerFor();
    const running = controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }], folder: 'resumes', pageSize: 10,
    });
    await expect(controller.redownloadMissing({ jobId: JOB })).rejects.toThrow(
      'A run is already in progress',
    );
    await running;
  });

  it('refuses a run while a re-download holds the tab', async () => {
    setup({
      people: [person('7700001')],
      storage: { [`job:${JOB}`]: { jobId: JOB, seenUserIds: ['7700001'], totalDownloaded: 1 } },
    });
    fake.addHistory({
      filename: 'resumes/Person 7700001-7700001-9100001.pdf',
      state: 'complete',
      exists: false,
      url: 'x',
    });
    const controller = await controllerFor();
    const refetching = controller.redownloadMissing({ jobId: JOB });
    await expect(
      controller.startRun({ jobs: [{ jobId: JOB, limit: 250 }], folder: 'resumes', pageSize: 10 }),
    ).rejects.toThrow('A run is already in progress');
    await refetching;
  });

  it('releases the lock when a run fails, so the next one can start', async () => {
    setup({ people: [person('7700001')], tabUrl: 'https://example.com/' });
    const controller = await controllerFor();
    await expect(
      controller.startRun({ jobs: [{ jobId: JOB, limit: 250 }], folder: 'f', pageSize: 10 }),
    ).rejects.toThrow();
    await expect(
      controller.startRun({ jobs: [{ jobId: JOB, limit: 250 }], folder: 'f', pageSize: 10 }),
    ).rejects.toThrow(NO_WELLFOUND_TAB);
  });
});

describe('importCsv', () => {
  const row = (userId, resumeStatus) => ({
    name: `Person ${userId}`,
    userId,
    jobId: JOB,
    jobTitle: 'Platform Engineer',
    resumeStatus,
  });

  async function importing(records) {
    setup({ people: [] });
    const controller = await controllerFor();
    const result = await controller.importCsv(JOB, toCsv(records));
    return { controller, result };
  }

  it('adopts people whose resume actually landed', async () => {
    const { result } = await importing([
      row('7700001', RESUME_STATUS.DOWNLOADED),
      row('7700002', RESUME_STATUS.ALREADY),
    ]);
    expect(result.imported).toBe(2);
    expect(ledgerRecord().seenUserIds).toEqual(['7700001', '7700002']);
  });

  // The bug: a run that hit its limit at page 8 of 20 writes a CSV whose tail is
  // all "not fetched". Importing that on another machine used to mark those
  // people downloaded for ever.
  it('refuses to adopt people the run never reached', async () => {
    const { result } = await importing([
      row('7700001', RESUME_STATUS.DOWNLOADED),
      row('7700002', RESUME_STATUS.NOT_REACHED),
      row('7700003', RESUME_STATUS.NOT_REACHED),
    ]);
    expect(result.imported).toBe(1);
    expect(ledgerRecord().seenUserIds).toEqual(['7700001']);
  });

  it('refuses to adopt people with no resume and people it could not identify', async () => {
    const { result } = await importing([
      row('7700001', RESUME_STATUS.NO_RESUME),
      row('7700002', RESUME_STATUS.NO_ID),
      row('7700003', RESUME_STATUS.LOCKED),
    ]);
    expect(result.imported).toBe(0);
    expect(ledgerRecord()?.seenUserIds ?? []).toEqual([]);
  });

  it('never moves the downloaded counter, only what the run will skip', async () => {
    await importing([row('7700001', RESUME_STATUS.DOWNLOADED)]);
    expect(ledgerRecord().totalDownloaded).toBe(0);
    expect(ledgerRecord().seenUserIds).toEqual(['7700001']);
  });

  // The end-to-end shape of the bug: import, then run, and see whether the
  // people the CSV never fetched are fetched now.
  it('leaves the unfetched fetchable by the very next run', async () => {
    const csv = toCsv([
      row('7700001', RESUME_STATUS.DOWNLOADED),
      row('7700002', RESUME_STATUS.NOT_REACHED),
    ]);
    setup({ people: [person('7700001'), person('7700002')] });
    const controller = await controllerFor();
    await controller.importCsv(JOB, csv);
    await controller.startRun({
      jobs: [{ jobId: JOB, limit: 250 }],
      folder: 'resumes',
      pageSize: 10,
    });
    const names = fake.items.filter((i) => i.url.includes('resume_url')).map((i) => i.filename);
    expect(names).toEqual(['resumes/Person 7700002-7700002-9100001.pdf']);
  });
});

describe('redownloadMissing', () => {
  function withMissing(people, missingIds, extra = {}) {
    const page = setup({
      people,
      storage: {
        [`job:${JOB}`]: {
          jobId: JOB,
          jobTitle: 'Platform Engineer',
          seenUserIds: people.map((p) => p.userId),
          totalDownloaded: people.length,
          folder: 'resumes',
          ...extra,
        },
      },
    });
    for (const p of people) {
      fake.addHistory({
        filename: `resumes/${p.name}-${p.userId}-${JOB}.pdf`,
        url: `https://wellfound.com/link/${p.userId}/tok/resume_url`,
        state: 'complete',
        exists: !missingIds.includes(p.userId),
      });
    }
    return page;
  }

  it('says there is nothing to do when every file is present', async () => {
    withMissing([person('7700001')], []);
    const controller = await controllerFor();
    expect(await controller.redownloadMissing({ jobId: JOB })).toEqual({
      refetched: 0,
      stillMissing: 0,
    });
  });

  it('fetches only the missing person, not the whole page', async () => {
    const people = [person('7700001'), person('7700002'), person('7700003')];
    withMissing(people, ['7700002']);
    const controller = await controllerFor();
    const result = await controller.redownloadMissing({ jobId: JOB });
    expect(result).toMatchObject({ refetched: 1, stillMissing: 0 });
    const fetched = fake.calls.downloads.map((d) => d.url);
    expect(fetched).toEqual(['https://wellfound.com/link/7700002/tok/resume_url']);
  });

  it('lands the file beside the originals, under the folder the run used', async () => {
    withMissing([person('7700001', 'Jane Doe')], ['7700001']);
    const controller = await controllerFor();
    await controller.redownloadMissing({ jobId: JOB });
    expect(fake.items.at(-1).filename).toBe('resumes/Jane Doe-7700001-9100001.pdf');
  });

  // It used to run without reading breaks: up to four hundred paced requests
  // back to back, which is not the rhythm the pacing model was designed around.
  it('takes the same reading breaks a normal run does', async () => {
    const people = Array.from({ length: 14 }, (_, i) => person(String(7700001 + i)));
    withMissing(people, people.map((p) => p.userId));
    const controller = await controllerFor();
    await controller.redownloadMissing({ jobId: JOB });
    expect(events.filter((e) => e.type === 'break').length).toBeGreaterThan(0);
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(15000);
  });

  it('asks for the ordinary page size, never the faster one', async () => {
    const page = withMissing([person('7700001')], ['7700001']);
    const controller = await controllerFor();
    await controller.redownloadMissing({ jobId: JOB });
    expect(page.calls.fetches.every((f) => f.pageSize === 10)).toBe(true);
  });

  // Written per file for the same reason a normal run does it: a file on disk
  // the ledger does not know about gets fetched all over again next run.
  it('keeps the refetched person recorded, and counted only once', async () => {
    withMissing([person('7700001')], ['7700001']);
    const controller = await controllerFor();
    await controller.redownloadMissing({ jobId: JOB });
    expect(ledgerRecord().seenUserIds).toEqual(['7700001']);
    expect(ledgerRecord().totalDownloaded).toBe(1);
  });

  it('reports someone with no resume on Wellfound rather than hunting for ever', async () => {
    const people = [{ ...person('7700001'), resumeUrl: null }, person('7700002')];
    withMissing(people, ['7700001']);
    const controller = await controllerFor();
    const result = await controller.redownloadMissing({ jobId: JOB });
    expect(result).toMatchObject({ refetched: 0, noResume: 1, stillMissing: 0 });
  });

  it('emits no done event, so the Library screen survives the action', async () => {
    withMissing([person('7700001')], ['7700001']);
    const controller = await controllerFor();
    await controller.redownloadMissing({ jobId: JOB });
    expect(events.filter((e) => e.type === 'done')).toEqual([]);
  });
});

describe('library and adoption', () => {
  it('counts people known from an import separately from files downloaded', async () => {
    setup({ people: [] });
    const controller = await controllerFor();
    await controller.importCsv(
      JOB,
      toCsv([{ userId: '7700001', jobId: JOB, resumeStatus: RESUME_STATUS.DOWNLOADED }]),
    );
    const [row] = await controller.library();
    expect(row).toMatchObject({ jobId: JOB, known: 1, downloaded: 0 });
  });

  it('adopts files found on disk that the ledger never heard of', async () => {
    setup({ people: [] });
    fake.addHistory({
      filename: `resumes/Jane Doe-7700001-${JOB}.pdf`,
      url: 'https://wellfound.com/link/7700001/tok/resume_url',
      state: 'complete',
      exists: true,
    });
    const controller = await controllerFor();
    expect(await controller.adoptOrphans(JOB)).toEqual({ adopted: 1 });
    expect(ledgerRecord().seenUserIds).toEqual(['7700001']);
  });

  it('forgets a job entirely', async () => {
    setup({
      people: [],
      storage: { [`job:${JOB}`]: { jobId: JOB, seenUserIds: ['7700001'], totalDownloaded: 1 } },
    });
    const controller = await controllerFor();
    await controller.forget(JOB);
    expect(ledgerRecord()).toBeUndefined();
  });
});

// The trace exists because a user got one sentence and no way to see behind it.
// Its value is entirely in whether it answers "where did this run stop" - and in
// its being safe to paste into a chat window without redaction.
describe('the run trace', () => {
  it('records the run from start to end, in order', async () => {
    setup({ people: [person('7700001'), person('7700002')] });
    const controller = await controllerFor();
    await controller.startRun({ jobs: [{ jobId: JOB }], folder: 'resumes', pageSize: 10 });
    const steps = controller.trace.entries().map((e) => e.step);
    expect(steps[0]).toBe('run_start');
    expect(steps).toContain('focus_ready');
    expect(steps).toContain('fetch');
    expect(steps).toContain('ledger_write');
    expect(steps).toContain('csv_write');
    expect(steps.at(-1)).toBe('run_end');
  });

  // The constraint that is not negotiable. A test that asserts a name never
  // reaches the trace is worth more than one that asserts a step name does.
  it('names nobody: no applicant name, no resume URL, no CSV row', async () => {
    setup({ people: [person('7700001', 'Jane Doe'), person('7700002', 'John Roe')] });
    const controller = await controllerFor();
    await controller.startRun({ jobs: [{ jobId: JOB }], folder: 'resumes', pageSize: 10 });
    const text =
      traceText(controller.trace.entries()) + JSON.stringify(controller.trace.entries());
    expect(text).not.toContain('Jane Doe');
    expect(text).not.toContain('John Roe');
    expect(text).not.toContain('wellfound.com');
    expect(text).not.toContain('resume_url');
    // The user ids are there, though: a user id is already in every filename,
    // and without them the trace cannot say which download failed.
    expect(text).toContain('7700001');
  });

  it('records a failed download as a step with its reason, not as silence', async () => {
    setup({ people: [person('7700001')] });
    const original = fake.chrome.downloads.download;
    fake.chrome.downloads.download = async (opts) => {
      if (!opts.url.includes('resume_url')) return original(opts);
      throw new Error('Download failed: https://wellfound.com/link/7700001/tok/resume_url');
    };
    const controller = await controllerFor();
    await controller.startRun({ jobs: [{ jobId: JOB }], folder: 'resumes', pageSize: 10 });
    const failed = controller.trace.entries().find((e) => e.outcome === 'failed');
    expect(failed).toMatchObject({ step: 'candidate', userId: '7700001' });
    expect(failed.error).toContain('[url]');
  });

  it('starts a new run with a clean trace rather than appending to the last one', async () => {
    setup({ people: [person('7700001')] });
    const controller = await controllerFor();
    const run = () =>
      controller.startRun({ jobs: [{ jobId: JOB }], folder: 'resumes', pageSize: 10 });
    await run();
    const first = controller.trace.entries().length;
    await run();
    expect(controller.trace.entries().filter((e) => e.step === 'run_start')).toHaveLength(1);
    expect(controller.trace.entries().length).toBeLessThanOrEqual(first + 2);
  });

  it('prints nothing to the console while the verbose option is off', async () => {
    setup({ people: [person('7700001')] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = await controllerFor();
    await controller.startRun({ jobs: [{ jobId: JOB }], folder: 'resumes', pageSize: 10 });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

// The five-consecutive-failures stop is per role, but the cause almost never
// is: if Wellfound starts refusing signed urls, every remaining role would fail
// its own five and stop, so the run breaks out of the whole list. The break sits
// after the ledger and CSV writes on purpose. Moving it two lines up loses the
// stopped role's ledger credit and its CSV, and every existing test would still
// pass - so the ordering is pinned here.
describe('when a role stops because everything is failing', () => {
  const OTHER = '9100002';

  async function runUntilFailing() {
    setup({
      jobs: [
        { jobId: JOB, title: 'Backend Engineer', actionableCount: 6 },
        { jobId: OTHER, title: 'Data Scientist', actionableCount: 3 },
      ],
      peopleByJob: {
        [JOB]: ['7700001', '7700002', '7700003', '7700004', '7700005', '7700006'].map((id) =>
          person(id),
        ),
        [OTHER]: [person('7800001')],
      },
    });
    // Wellfound refusing every resume link, which is the situation the stop
    // exists for. The CSV is a blob and still has to be written.
    const download = fake.chrome.downloads.download;
    fake.chrome.downloads.download = async (opts) => {
      if (String(opts.url).includes('resume_url')) throw new Error('NETWORK_FAILED');
      return download(opts);
    };
    const controller = await controllerFor();
    await controller.startRun({
      jobs: [
        { jobId: JOB, limit: Infinity },
        { jobId: OTHER, limit: Infinity },
      ],
      folder: 'resumes',
      pageSize: 10,
    });
    return events.find((e) => e.type === 'done');
  }

  it('stops the whole run rather than failing five more times per role', async () => {
    const done = await runUntilFailing();
    expect(done.stoppedBecause).toBe('failing');
    // The second role was never walked: no fetch, no navigation, no five more
    // refused downloads.
    expect(done.jobs.map((j) => j.jobId)).toEqual([JOB]);
  });

  it('keeps the stopped role ledger credit, written before the break', async () => {
    await runUntilFailing();
    // finishRun ran for this job even though it downloaded nobody: the run
    // happened, the folder it was aimed at is stored, and the next run's
    // "Re-download missing" has somewhere to look.
    expect(ledgerRecord()).toMatchObject({ folder: 'resumes' });
    expect(ledgerRecord().lastRunAt).toEqual(expect.any(String));
  });

  it('keeps the stopped role CSV, written before the break', async () => {
    const done = await runUntilFailing();
    // Six people were walked and every one of them is in the file, each with the
    // status that says why no resume came down. Breaking before this write would
    // have thrown away the only record that they were seen.
    expect(done.jobs[0].wroteCsv).toBe(true);
    const csv = await objectUrls[0].text();
    for (const id of ['7700001', '7700005']) expect(csv).toContain(id);
  });
});
