import { describe, it, expect, afterEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import {
  createTabDriver,
  APPLICANTS_URL,
  RECRUIT_URL,
  READY_TIMEOUT_MS,
  NO_WELLFOUND_TAB,
  NOT_IN_RECRUITER_AREA,
  PAGE_DISCONNECTED,
  PAGE_DISCONNECTED_MESSAGE,
} from '../src/panel/tab-driver.js';
import { CX } from '../src/lib/messages.js';

let fake = null;

afterEach(() => {
  fake?.restore();
  fake = null;
});

// A clock the driver's readiness poll advances rather than waits on, so the
// fifteen-second timeout costs a test nothing.
function fakeClock() {
  let time = 1000;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

// The trace is not optional - the driver has no fallback for it - so every
// driver built here gets one, and the test can read what it recorded.
function recordingTrace() {
  const steps = [];
  return { steps, record: (step, fields) => steps.push({ step, ...fields }) };
}

function driverFor(options) {
  fake = installFakeChrome(options);
  const clock = fakeClock();
  const trace = recordingTrace();
  return { driver: createTabDriver({ ...clock, trace }), clock, trace };
}

describe('workingTab', () => {
  // The panel used to demand the applicant list, which is the one page a
  // recruiter has no reason to be on when they open the panel to pick roles.
  it('accepts any page in the recruiter area', async () => {
    const { driver } = driverFor({ tabs: [{ id: 7, url: `${RECRUIT_URL}jobs/9100001` }] });
    expect((await driver.workingTab()).id).toBe(7);
  });

  it('names the remedy when no Wellfound tab is open', async () => {
    const { driver } = driverFor({ tabs: [{ id: 7, url: 'https://example.com/' }] });
    await expect(driver.workingTab()).rejects.toThrow(NO_WELLFOUND_TAB);
  });

  // Two different problems, so two different sentences: someone on Wellfound
  // needs directions, not an invitation to open Wellfound.
  it('names the recruiter area when the Wellfound tab is somewhere else', async () => {
    const { driver } = driverFor({ tabs: [{ id: 7, url: 'https://wellfound.com/jobs' }] });
    await expect(driver.workingTab()).rejects.toThrow(NOT_IN_RECRUITER_AREA);
  });
});

describe('ask', () => {
  it('unwraps a successful reply', async () => {
    const { driver } = driverFor({ pages: { 7: async () => ({ ok: true, data: [{ jobId: '9100001' }] }) } });
    expect(await driver.ask(7, { type: CX.LIST_JOBS })).toEqual([{ jobId: '9100001' }]);
  });

  it('raises the page\u2019s own error', async () => {
    const { driver } = driverFor({
      pages: { 7: async () => ({ ok: false, error: 'RecruitJobListingApplicants is not active yet' }) },
    });
    await expect(driver.ask(7, {})).rejects.toThrow('is not active yet');
  });

  it('raises a plain message when the page does not answer at all', async () => {
    const { driver } = driverFor({ pages: { 7: async () => undefined } });
    await expect(driver.ask(7, {})).rejects.toThrow('No response from the page');
  });

  // The one the owner hit: reloading the extension severs the content scripts in
  // tabs that are already open. sendMessage rejects rather than answering, so
  // this never reached the `ok` check above and Chrome's own words went to the
  // screen.
  it('explains a page that is no longer listening', async () => {
    const { driver } = driverFor({ tabs: [{ id: 7, url: RECRUIT_URL }] });
    await expect(driver.ask(7, { type: CX.LIST_JOBS })).rejects.toThrow(PAGE_DISCONNECTED_MESSAGE);
  });

  // The panel has to offer the reload without reading the sentence it shows, and
  // it must not have to go and find the tab again to do it.
  it('marks that failure and names the tab it happened on', async () => {
    const { driver } = driverFor({ tabs: [{ id: 7, url: RECRUIT_URL }] });
    const error = await driver.ask(7, { type: CX.LIST_JOBS }).catch((e) => e);
    expect(error.code).toBe(PAGE_DISCONNECTED);
    expect(error.tabId).toBe(7);
  });

  // Chrome has worded this two ways across versions, and both are seen in the
  // wild.
  it('recognises the port-closed wording as the same failure', async () => {
    fake = installFakeChrome({ tabs: [{ id: 7, url: RECRUIT_URL }] });
    fake.chrome.tabs.sendMessage = async () => {
      throw new Error('The message port closed before a response was received.');
    };
    const driver = createTabDriver({ ...fakeClock(), trace: recordingTrace() });
    const error = await driver.ask(7, {}).catch((e) => e);
    expect(error.code).toBe(PAGE_DISCONNECTED);
  });

  // Anything else is somebody else's failure. Relabelling it would send the user
  // to reload a page that was never the problem.
  it('passes an unrecognised rejection through unchanged', async () => {
    fake = installFakeChrome({ tabs: [{ id: 7, url: RECRUIT_URL }] });
    const thrown = new Error('Tabs cannot be edited right now (user may be dragging a tab)');
    fake.chrome.tabs.sendMessage = async () => {
      throw thrown;
    };
    const driver = createTabDriver({ ...fakeClock(), trace: recordingTrace() });
    const error = await driver.ask(7, {}).catch((e) => e);
    expect(error).toBe(thrown);
    expect(error.code).toBeUndefined();
  });
});

describe('focusJob', () => {
  // A page answers as the document it actually is: the job in its own URL. A
  // bare `true` was the bug - a stale document could answer it correctly.
  const jobInUrl = (url) => String(url ?? '').match(/jobs\/(\d+)/)?.[1] ?? null;
  const readyPage = () => async (message, context) => {
    if (message.type !== CX.QUERY_READY) return { ok: true, data: null };
    const jobId = jobInUrl(context?.tab?.url);
    return { ok: true, data: jobId ? { jobId } : null };
  };

  it('navigates a tab showing another job', async () => {
    const { driver } = driverFor({
      tabs: [{ id: 7, url: `${APPLICANTS_URL}jobs/9100002` }],
      pages: { 7: readyPage() },
    });
    await driver.focusJob(7, '9100001');
    expect(fake.calls.updates).toEqual([{ tabId: 7, url: `${APPLICANTS_URL}jobs/9100001` }]);
  });

  it('does not navigate a tab already showing the job', async () => {
    const { driver } = driverFor({
      tabs: [{ id: 7, url: `${APPLICANTS_URL}jobs/9100001` }],
      pages: { 7: readyPage() },
    });
    await driver.focusJob(7, '9100001');
    expect(fake.calls.updates).toEqual([]);
  });

  // The bug the readiness poll exists for: the recruiter is already looking at
  // the job, so nothing navigates, and Apollo is still hydrating. Skipping the
  // poll here made the first fetch throw and took the whole run down.
  it('still waits for readiness when it did not navigate', async () => {
    let ready = false;
    const { driver } = driverFor({
      tabs: [{ id: 7, url: `${APPLICANTS_URL}jobs/9100001` }],
      pages: { 7: async () => ({ ok: true, data: ready ? { jobId: '9100001' } : null }) },
    });
    const polls = [];
    const original = fake.chrome.tabs.sendMessage;
    fake.chrome.tabs.sendMessage = async (...args) => {
      polls.push(args[1]);
      if (polls.length === 3) ready = true;
      return original(...args);
    };
    await driver.focusJob(7, '9100001');
    expect(polls).toHaveLength(3);
    expect(fake.calls.updates).toEqual([]);
  });

  it('keeps polling through a page that drops the message channel', async () => {
    let attempts = 0;
    const { driver } = driverFor({
      tabs: [{ id: 7, url: 'https://wellfound.com/recruit/applicants/' }],
      pages: {
        7: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('Could not establish connection');
          return { ok: true, data: { jobId: '9100001' } };
        },
      },
    });
    await driver.focusJob(7, '9100001');
    expect(attempts).toBe(3);
  });

  // The bug from the first live run. The recruiter was already on an applicant
  // list, so the old document was still alive when the probe fired - and it
  // answered "yes, an applicants query is registered", truthfully, for the job
  // it was still showing. The run started fetching against a tab whose content
  // script then vanished: "Could not establish connection."
  it('refuses a stale document still answering for the previous job', async () => {
    const answers = [];
    let swapped = false;
    const { driver } = driverFor({
      tabs: [{ id: 7, url: `${APPLICANTS_URL}jobs/9100002` }],
      pages: {
        7: async (message) => {
          // Nothing but the probe may be sent before the page is accepted.
          if (message.type !== CX.QUERY_READY) throw new Error(`too early: ${message.type}`);
          const jobId = swapped ? '9100001' : '9100002';
          answers.push(jobId);
          // The document swaps between the first probe and the second.
          swapped = true;
          return { ok: true, data: { jobId } };
        },
      },
    });
    await driver.focusJob(7, '9100001');
    // The first answer was refused despite being a truthful "ready".
    expect(answers).toEqual(['9100002', '9100001']);
  });

  // A tab Chrome still calls `loading` is not worth asking anything at all.
  it('waits for the tab to finish loading before probing it', async () => {
    const { driver } = driverFor({
      tabs: [{ id: 7, url: `${APPLICANTS_URL}jobs/9100001`, status: 'loading' }],
      pages: { 7: readyPage() },
    });
    let gets = 0;
    const original = fake.chrome.tabs.get;
    fake.chrome.tabs.get = async (tabId) => {
      gets += 1;
      if (gets === 3) fake.setTabStatus(7, 'complete');
      return original(tabId);
    };
    await driver.focusJob(7, '9100001');
    // One `get` before the loop, two polls that found the tab still loading and
    // asked the page nothing, then the poll that succeeded.
    expect(fake.calls.sendMessage).toHaveLength(1);
  });

  it('gives up at the deadline rather than polling for ever', async () => {
    const { driver, clock } = driverFor({
      tabs: [{ id: 7, url: `${APPLICANTS_URL}jobs/9100001` }],
      pages: { 7: async () => ({ ok: true, data: null }) },
    });
    const start = clock.now();
    await expect(driver.focusJob(7, '9100001')).rejects.toThrow('did not finish loading');
    expect(clock.now() - start).toBeGreaterThanOrEqual(READY_TIMEOUT_MS);
  });
});
