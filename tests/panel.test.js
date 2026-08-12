import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { installFakeDom } from './helpers/fake-dom.js';
import { SUMMARY_KEY, RUNNING_KEY } from '../src/panel/summary-store.js';
import { RUN_IDS, DOT } from '../src/panel/running-view.js';
import { POST_RUN_IDS } from '../src/panel/post-run-view.js';
import { HOME_IDS, RECONNECT_LABEL, WAITING_LINE } from '../src/panel/home-view.js';
import {
  pageDisconnectedError,
  RECRUIT_URL,
  NO_WELLFOUND_TAB,
  NOT_IN_RECRUITER_AREA,
  NO_WELLFOUND_TAB_CODE,
  NOT_IN_RECRUITER_AREA_CODE,
} from '../src/panel/tab-driver.js';
import { CONFIRM_IDS } from '../src/panel/accept-confirm.js';
import { DEFAULT_MESSAGE } from '../src/lib/accept-message.js';

// panel.js is the wiring: what the screen shows, which listener each control
// gets, and what a run event does to the DOM. None of it had a test, because the
// file ended in a bare `load()` and so could not be imported outside a browser.
// It now ends in a guarded init(), and everything below is what that bought.
//
// The run loop is not re-tested here - run-controller.test.js does that against
// the real thing. The controller is stubbed at its own boundary so that a run
// event can be delivered on demand and the panel's reaction to it asserted,
// which is the only part of a run this file is responsible for.

const JOB_A = '9100001';
const JOB_B = '9100002';

let fake;
let dom;
let controller;
let controllerOptions;
let panel;

function stubController(over = {}) {
  return {
    listJobs: vi.fn(async () => []),
    startRun: vi.fn(async () => {}),
    abort: vi.fn(),
    library: vi.fn(async () => []),
    trace: { entries: () => [] },
    ...over,
  };
}

const job = (jobId, over = {}) => ({
  jobId,
  title: 'Platform Engineer',
  actionableCount: 4,
  estimatedNew: 3,
  ...over,
});

// Imports panel.js with the document already stubbed but not yet carrying the
// panel's markup, so the bootstrap guard finds no mount point and stays quiet.
async function importPanel({ storage = {}, tabs = [], stub = stubController() } = {}) {
  vi.resetModules();
  fake = installFakeChrome({ storage, tabs });
  dom = installFakeDom();
  controller = stub;
  vi.doMock('../src/panel/run-controller.js', () => ({
    createController: (options) => {
      controllerOptions = options;
      return controller;
    },
  }));
  panel = await import('../src/panel/panel.js');
}

// Everything the panel needs to be open and settled on Home.
async function openPanel(options = {}) {
  await importPanel(options);
  dom.mountPanel();
  await panel.init();
  return dom.document.getElementById('screen');
}

const byId = (id) => dom.document.getElementById(id);
const emit = (event) => controllerOptions.onEvent(event);

// Two turns of the microtask queue: a click handler that awaits storage and then
// renders has settled by the time this resolves.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  controllerOptions = null;
});

afterEach(() => {
  vi.doUnmock('../src/panel/run-controller.js');
  dom?.restore();
  fake?.restore();
  vi.restoreAllMocks();
});

describe('the bootstrap', () => {
  // The whole point of the guard: importing this module is not running it.
  it('does nothing when the document is not the panel', async () => {
    await importPanel({ stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) }) });
    expect(controller.listJobs).not.toHaveBeenCalled();
    expect(dom.document.body.innerHTML).toBe('');
  });

  // And the other half: panel.html has not been asked to do anything new.
  it('starts itself when it is loaded into the panel document', async () => {
    vi.resetModules();
    fake = installFakeChrome({});
    dom = installFakeDom();
    controller = stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) });
    vi.doMock('../src/panel/run-controller.js', () => ({
      createController: (options) => {
        controllerOptions = options;
        return controller;
      },
    }));
    dom.mountPanel();
    panel = await import('../src/panel/panel.js');
    await settle();
    expect(controller.listJobs).toHaveBeenCalled();
    expect(byId('screen').innerHTML).toContain('Platform Engineer');
  });
});

describe('Home', () => {
  it('lists a row per role, with what is waiting on each', async () => {
    const screen = await openPanel({
      stub: stubController({
        listJobs: vi.fn(async () => [job(JOB_A), job(JOB_B, { title: 'Data Analyst' })]),
      }),
    });
    expect(screen.querySelectorAll('.job-row')).toHaveLength(2);
    expect(screen.innerHTML).toContain('4 applicants');
    expect(screen.innerHTML).toContain('3 new');
    expect(byId('start').disabled).toBe(true);
    expect(byId('start').textContent).toContain('Select a role');
  });

  it('promises the number it will actually fetch once a role is picked', async () => {
    const screen = await openPanel({
      stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) }),
    });
    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');
    expect(byId('start').disabled).toBe(false);
    expect(byId('start').textContent).toContain('Download 3 resumes');
  });

  // The card is the accordion. Clicking it opens one role's settings and picks
  // nobody: Start stays disabled, which is the whole point of the change.
  it('opens one role at a time without selecting it', async () => {
    const screen = await openPanel({
      stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A), job(JOB_B)]) }),
    });
    await screen.querySelectorAll('.job-row')[0].click();
    expect(byId(`opts-${JOB_A}`).hasAttribute('hidden')).toBe(false);
    expect(byId(`opts-${JOB_B}`).hasAttribute('hidden')).toBe(true);
    expect(byId('start').disabled).toBe(true);
  });

  it('closes the role a second click on its card', async () => {
    const screen = await openPanel({
      stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) }),
    });
    await screen.querySelector('.job-row').click();
    expect(byId(`opts-${JOB_A}`).hasAttribute('hidden')).toBe(false);
    await screen.querySelector('.job-row').click();
    expect(byId(`opts-${JOB_A}`).hasAttribute('hidden')).toBe(true);
  });

  // Ticking a role is not opening it. The checkbox stops the click before the
  // card's handler can forward it to the disclosure.
  it('selects a role without opening its settings', async () => {
    const screen = await openPanel({
      stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) }),
    });
    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');
    expect(byId(`opts-${JOB_A}`).hasAttribute('hidden')).toBe(true);
    expect(byId('start').disabled).toBe(false);
  });

  // The screen is rebuilt on every change, so anything typed has to be read back
  // out of the DOM first or the rebuild eats it.
  it('keeps what was typed and ticked across a re-render', async () => {
    const screen = await openPanel({
      stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) }),
    });
    byId('folder').value = 'my-resumes';
    byId('advanced').open = true;
    byId('preview').checked = true;
    byId('fast').checked = true;

    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');

    expect(byId('folder').value).toBe('my-resumes');
    expect(byId('preview').checked).toBe(true);
    expect(byId('fast').checked).toBe(true);
    expect(byId('advanced').open).toBe(true);
  });

  it('hands the captured settings to the run', async () => {
    const screen = await openPanel({
      stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) }),
    });
    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');
    byId('folder').value = '  my-resumes  ';
    byId('fast').checked = true;
    byId('preview').checked = true;
    await byId('start').click();

    expect(controller.startRun).toHaveBeenCalledWith({
      jobs: [{ jobId: JOB_A, limit: Infinity, forceFullWalk: false }],
      folder: 'my-resumes',
      pageSize: 20,
      actions: { download: false, accept: false },
      acceptMessage: DEFAULT_MESSAGE,
    });
  });

  it('falls back to the default folder when the box is emptied', async () => {
    const screen = await openPanel({
      stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) }),
    });
    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');
    byId('folder').value = '   ';
    await byId('start').click();
    expect(controller.startRun.mock.calls[0][0].folder).toBe('wellfound-resumes');
  });

  // Typing a number is asking for that number; making the user then find the
  // radio would be a trap.
  it('treats a number typed into the box as the request', async () => {
    const screen = await openPanel({
      stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) }),
    });
    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');
    await screen.querySelector('.job-row').click();
    const box = byId(`limit-${JOB_A}`);
    box.value = '2';
    await box.dispatch('change');

    expect(byId(`mode-limit-${JOB_A}`).hasAttribute('checked')).toBe(true);
    expect(byId('start').textContent).toContain('Download 2 resumes');
    await byId('start').click();
    expect(controller.startRun.mock.calls[0][0].jobs[0].limit).toBe(2);
  });

  it('says so when the roles cannot be read, rather than showing an empty list', async () => {
    const screen = await openPanel({
      stub: stubController({
        listJobs: vi.fn(async () => {
          throw new Error('Open your Wellfound jobs list');
        }),
      }),
    });
    expect(screen.innerHTML).toContain('Open your Wellfound jobs list');
    expect(byId('start')).toBe(null);
  });

  // Reloading the extension severs the content script in every open tab, so the
  // panel messages a page where nothing is listening. It is the likeliest
  // disruption there is, and the user can do nothing about it without being
  // told what it is and offered the fix.
  describe('a page that lost its content script', () => {
    function disconnectedOnce() {
      const error = pageDisconnectedError(7);
      let asked = 0;
      return stubController({
        listJobs: vi.fn(async () => {
          asked += 1;
          if (asked === 1) throw error;
          return [job(JOB_A)];
        }),
      });
    }

    it('explains it in \u2019 and offers the reload', async () => {
      const screen = await openPanel({ tabs: [{ id: 7, url: 'https://wellfound.com/recruit/' }], stub: disconnectedOnce() });
      expect(screen.innerHTML).toContain('lost its connection to the extension');
      expect(screen.innerHTML).not.toContain('Receiving end');
      expect(byId(HOME_IDS.reconnect).textContent).toContain(RECONNECT_LABEL);
    });

    // The remedy, end to end: the tab is reloaded and the thing that failed is
    // asked for again.
    it('reloads the tab and re-runs the job list', async () => {
      await openPanel({ tabs: [{ id: 7, url: 'https://wellfound.com/recruit/' }], stub: disconnectedOnce() });
      await byId(HOME_IDS.reconnect).click();
      expect(fake.calls.reloads).toEqual([7]);
      expect(controller.listJobs).toHaveBeenCalledTimes(2);
      expect(byId('screen').innerHTML).toContain('Platform Engineer');
    });

    // Every other failure keeps the plain note it had. A button that reloaded
    // the page would be the wrong advice for a tab that was never the problem.
    it('offers nothing to press for a failure a reload would not fix', async () => {
      await openPanel({
        stub: stubController({
          listJobs: vi.fn(async () => {
            throw new Error('Open Wellfound to get started');
          }),
        }),
      });
      expect(byId(HOME_IDS.reconnect)).toBe(null);
    });
  });

  // The owner's own sequence: open Wellfound, open the panel, and the panel
  // asks before the tab has arrived in the recruiter area. It used to answer
  // once and stop, so the only way on was to close the panel and open it again.
  describe('a page that is not ready yet', () => {
    const NOT_THERE_YET = 'Open your hiring pages on Wellfound (wellfound.com/recruit) to see your jobs';

    function readyOnTheSecondAsk() {
      let asked = 0;
      return stubController({
        listJobs: vi.fn(async () => {
          asked += 1;
          if (asked === 1) throw new Error(NOT_THERE_YET);
          return [job(JOB_A)];
        }),
      });
    }

    it('says it is waiting rather than looking finished', async () => {
      const screen = await openPanel({
        tabs: [{ id: 7, url: 'https://wellfound.com/' }],
        stub: readyOnTheSecondAsk(),
      });
      expect(screen.innerHTML).toContain(NOT_THERE_YET);
      expect(screen.innerHTML).toContain(WAITING_LINE);
    });

    it('shows the roles when the tab reaches the recruiter area, with the panel left open', async () => {
      const screen = await openPanel({
        tabs: [{ id: 7, url: 'https://wellfound.com/' }],
        stub: readyOnTheSecondAsk(),
      });
      fake.navigateTab(7, 'https://wellfound.com/recruit/jobs');
      await settle();
      expect(controller.listJobs).toHaveBeenCalledTimes(2);
      expect(screen.innerHTML).toContain('Platform Engineer');
      expect(screen.innerHTML).not.toContain(WAITING_LINE);
    });

    // The user opens Wellfound after the panel. Nothing was there to navigate,
    // so the tab arriving is the only event there is.
    it('shows the roles when a Wellfound tab is opened afterwards', async () => {
      const screen = await openPanel({ tabs: [], stub: readyOnTheSecondAsk() });
      fake.openTab({ id: 7, url: 'https://wellfound.com/recruit/jobs' });
      await settle();
      expect(screen.innerHTML).toContain('Platform Engineer');
    });

    // A panel that kept listening would re-run the whole load every time the
    // user moved around Wellfound.
    it('stops listening once the roles are there', async () => {
      await openPanel({
        tabs: [{ id: 7, url: 'https://wellfound.com/' }],
        stub: readyOnTheSecondAsk(),
      });
      fake.navigateTab(7, 'https://wellfound.com/recruit/jobs');
      await settle();
      fake.navigateTab(7, 'https://wellfound.com/recruit/applicants/jobs/9100001');
      await settle();
      expect(controller.listJobs).toHaveBeenCalledTimes(2);
    });
  });

  // Both dead ends the owner used to resolve by hand are actionable now: the
  // sentence itself carries a link to the recruiter area, not a mechanism the
  // user has to work out on their own.
  describe('the two Wellfound dead ends', () => {
    function throwing(message, code) {
      return stubController({
        listJobs: vi.fn(async () => {
          const error = new Error(message);
          error.code = code;
          throw error;
        }),
      });
    }

    it('links "Open Wellfound" to the recruiter area when there is no tab', async () => {
      const screen = await openPanel({
        tabs: [],
        stub: throwing(NO_WELLFOUND_TAB, NO_WELLFOUND_TAB_CODE),
      });
      const link = screen.querySelector('.load-error-link');
      expect(link).not.toBe(null);
      expect(link.getAttribute('href')).toBe(RECRUIT_URL);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.textContent).toBe('Open Wellfound');
    });

    it('links the recruiter mention when the tab is outside the recruiter area', async () => {
      const screen = await openPanel({
        tabs: [{ id: 7, url: 'https://wellfound.com/jobs' }],
        stub: throwing(NOT_IN_RECRUITER_AREA, NOT_IN_RECRUITER_AREA_CODE),
      });
      const link = screen.querySelector('.load-error-link');
      expect(link).not.toBe(null);
      expect(link.getAttribute('href')).toBe(RECRUIT_URL);
      expect(screen.innerHTML).toContain('to see your jobs');
    });
  });
});

describe('the running screen', () => {
  async function startRunning() {
    const screen = await openPanel({
      stub: stubController({
        listJobs: vi.fn(async () => [job(JOB_A)]),
        startRun: vi.fn(() => new Promise(() => {})),
      }),
    });
    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');
    byId('start').click();
    await settle();
    return screen;
  }

  it('replaces Home with the run, and marks the run as started', async () => {
    const screen = await startRunning();
    expect(byId(RUN_IDS.status)).not.toBe(null);
    expect(screen.innerHTML).toContain('0 of ~3 applicants');
    expect(byId('nav-library').disabled).toBe(true);
    expect(fake.store[RUNNING_KEY]).toMatchObject({ running: true });
  });

  it('stops the run from the button, and says the stop is not instant', async () => {
    await startRunning();
    await byId(RUN_IDS.abort).click();
    expect(controller.abort).toHaveBeenCalled();
    expect(byId(RUN_IDS.status).textContent).toContain('stopping after this candidate');
  });

  it('names the role a started event is about', async () => {
    const screen = await startRunning();
    emit({ type: 'started', jobId: JOB_A, jobTitle: 'Data Analyst', jobIndex: 1, jobTotal: 2 });
    expect(screen.innerHTML).toContain('Data Analyst');
    expect(screen.innerHTML).toContain('job 1 of 2');
  });

  it('counts a candidate and says what happened to them', async () => {
    const screen = await startRunning();
    emit({ type: 'candidate', outcome: 'downloaded', name: 'Applicant One' });
    emit({ type: 'candidate', outcome: 'failed', name: 'Applicant Two' });
    expect(screen.innerHTML).toContain('2 of ~3 applicants');
    expect(byId(RUN_IDS.status).textContent).toBe('could not download Applicant Two');
  });

  it('reports a page walk, so an all-known page is not mistaken for a stall', async () => {
    await startRunning();
    emit({ type: 'page', bucket: 'IN_REVIEW', page: 2, fetched: 10, fresh: 0 });
    expect(byId(RUN_IDS.status).textContent).toContain('page 2');
    expect(byId(RUN_IDS.status).textContent).toContain('10 read, 0 new');
  });

  it('puts a job error and a job note on the activity line', async () => {
    await startRunning();
    emit({ type: 'job_error', jobId: JOB_A, error: 'that tab went away' });
    expect(byId(RUN_IDS.status).textContent).toBe('that tab went away');
    emit({ type: 'job_note', jobId: JOB_A, jobTitle: 'Data Analyst', note: 'nothing new' });
    expect(byId(RUN_IDS.status).textContent).toBe('Data Analyst: nothing new');
  });

  it('explains a pause instead of leaving the panel looking hung', async () => {
    await startRunning();
    emit({ type: 'resting', ms: 4000 });
    expect(byId(RUN_IDS.status).textContent).toContain('resting 4s');
    emit({ type: 'break', ms: 30000 });
    expect(byId(RUN_IDS.status).textContent).toContain('reading break 30s');
  });

  // The fallback path: an emitter that failed with no totals to report.
});

describe('the post-run screen', () => {
  async function finishRun(over = {}) {
    const screen = await openPanel({
      stub: stubController({
        listJobs: vi.fn(async () => [job(JOB_A)]),
        startRun: vi.fn(() => new Promise(() => {})),
      }),
    });
    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');
    byId('start').click();
    await settle();
    emit({
      type: 'done',
      downloaded: 2,
      failed: 0,
      skippedNoResume: 0,
      stoppedBecause: 'finished',
      folder: 'wellfound-resumes',
      ...over,
    });
    await settle();
    return screen;
  }

  // The job list keeps loading behind this screen, and finishing must not
  // repaint over the only account of the run that exists - hence `start` being
  // absent once the reload behind it has settled.
  it('takes over the panel when the run is done, and stores what it says', async () => {
    const screen = await finishRun();
    expect(byId(POST_RUN_IDS.done)).not.toBe(null);
    expect(screen.innerHTML).toContain('What the run did');
    expect(byId('start')).toBe(null);
    expect(fake.store[SUMMARY_KEY]).toBeTruthy();
    expect(fake.store[RUNNING_KEY]).toBe(undefined);
    expect(byId('nav-library').disabled).toBe(false);
  });

  // The reason the summary is the panel's own business: listJobs fails for the
  // most ordinary reason there is, and the run's account must survive it.
  it('survives a failure to reload the job list', async () => {
    const screen = await openPanel({
      stub: stubController({
        listJobs: vi.fn(async () => {
          throw new Error('No Wellfound tab is open');
        }),
      }),
      storage: { [SUMMARY_KEY]: { at: '2026-08-11T10:00:00.000Z', headline: '2 downloaded', notes: [] } },
    });
    expect(screen.innerHTML).toContain('What the run did');
    expect(screen.innerHTML).toContain('2 downloaded');
    expect(screen.innerHTML).not.toContain('No Wellfound tab is open');
  });

  it('reports an interrupted run in preference to the last stored summary', async () => {
    const screen = await openPanel({
      storage: {
        [SUMMARY_KEY]: { at: 'earlier', headline: '9 downloaded', notes: [] },
        [RUNNING_KEY]: { running: true, startedAt: Date.parse('2026-08-11T10:00:00.000Z') },
      },
    });
    expect(screen.innerHTML).toContain('was interrupted');
    expect(screen.innerHTML).not.toContain('9 downloaded');
    // Read and cleared in one step, so the notice is not shown a second time.
    expect(fake.store[RUNNING_KEY]).toBe(undefined);
  });

  it('clears the run and returns Home on Done', async () => {
    const screen = await finishRun();
    await byId(POST_RUN_IDS.done).click();
    await settle();
    expect(fake.store[SUMMARY_KEY]).toBe(undefined);
    expect(fake.store[RUNNING_KEY]).toBe(undefined);
    expect(screen.innerHTML).toContain('Platform Engineer');
    expect(byId('start')).not.toBe(null);
  });

  it('files the report beside the run it describes', async () => {
    const screen = await finishRun();
    // The folder Home was carrying when the run started.
    await byId(POST_RUN_IDS.download).click();
    const download = fake.calls.downloads.at(-1);
    expect(download.filename).toMatch(/^wellfound-resumes\/run-\d{4}-\d{2}-\d{2}-\d{6}\.txt$/);
    expect(byId(POST_RUN_IDS.download).textContent).toContain('Saved to your downloads');
    expect(screen.innerHTML).toContain('What the run did');
  });

  it('says on the button itself when the report could not be saved', async () => {
    await finishRun();
    fake.chrome.downloads.download = async () => {
      throw new Error('Downloads are blocked');
    };
    await byId(POST_RUN_IDS.download).click();
    expect(byId(POST_RUN_IDS.download).textContent).toContain('Could not save: Downloads are blocked');
  });
});

describe('the Library', () => {
  it('is reached from the top bar and hands the panel back on Back', async () => {
    const screen = await openPanel({
      stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) }),
    });
    await byId('nav-library').click();
    await settle();
    expect(controller.library).toHaveBeenCalled();
    expect(screen.innerHTML).toContain('Nothing downloaded yet');

    await byId('back').click();
    await settle();
    expect(screen.innerHTML).toContain('Platform Engineer');
    expect(byId('start')).not.toBe(null);
  });
});

// Accepting, wired up. The gate below is the one behaviour in this panel whose
// failure cannot be undone: no run may reach startRun with `accept` on without
// the operator having read the confirm screen and pressed the button on it.
describe('accepting', () => {
  async function homeWithAccept(over = {}) {
    const screen = await openPanel({
      stub: stubController({
        listJobs: vi.fn(async () => [job(JOB_A)]),
        startRun: vi.fn(() => new Promise(() => {})),
        ...over,
      }),
    });
    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');
    const accept = byId(HOME_IDS.accept);
    accept.checked = true;
    await accept.dispatch('change');
    return screen;
  }

  // Home, through the confirm screen, to a run with an accept pass under way.
  async function acceptRunning() {
    const screen = await homeWithAccept();
    await byId('start').click();
    await settle();
    byId(CONFIRM_IDS.send).click();
    await settle();
    emit({ type: 'accept_started', jobId: JOB_A, intended: 12 });
    return screen;
  }

  it('opens the wording only once accepting is on', async () => {
    const screen = await openPanel({
      stub: stubController({ listJobs: vi.fn(async () => [job(JOB_A)]) }),
    });
    expect(byId(HOME_IDS.acceptMessage)).toBe(null);
    const accept = byId(HOME_IDS.accept);
    accept.checked = true;
    await accept.dispatch('change');
    expect(byId(HOME_IDS.acceptMessage).value).toContain('Thanks so much for applying');
    expect(screen.innerHTML).toContain('Hey Priya,');
  });

  // The screen is rebuilt on every change, so anything typed has to be read
  // back out of the DOM first or the rebuild eats it - and here the thing eaten
  // would be the text a few hundred people receive.
  it('keeps the edited wording across a re-render', async () => {
    const screen = await homeWithAccept();
    const box = byId(HOME_IDS.acceptMessage);
    box.value = 'Hi [first_name], about [role_name].';
    await box.dispatch('change');
    expect(byId(HOME_IDS.acceptMessage).value).toBe('Hi [first_name], about [role_name].');
    expect(screen.innerHTML).toContain('Hi Priya, about Platform Engineer.');
  });

  // The gate. Start does not start anything.
  it('starts no run at all until the confirm screen is confirmed', async () => {
    const screen = await homeWithAccept();
    await byId('start').click();
    await settle();
    expect(controller.startRun).not.toHaveBeenCalled();
    expect(screen.innerHTML).toContain('cannot be unsent');
    expect(byId(CONFIRM_IDS.send)).not.toBe(null);
    expect(byId(RUN_IDS.status)).toBe(null);
  });

  it('does not put the focus on the button that sends', async () => {
    await homeWithAccept();
    await byId('start').click();
    await settle();
    expect(dom.document.activeElement).toBe(byId(CONFIRM_IDS.back));
  });

  it('goes back to Home from the confirm screen, having sent nothing', async () => {
    const screen = await homeWithAccept();
    await byId('start').click();
    await settle();
    await byId(CONFIRM_IDS.back).click();
    await settle();
    expect(controller.startRun).not.toHaveBeenCalled();
    expect(screen.innerHTML).toContain('Platform Engineer');
    expect(byId(HOME_IDS.accept).checked).toBe(true);
  });

  // And the other half: the text that was shown is the text that is sent.
  it('runs with the wording the confirm screen showed', async () => {
    const screen = await homeWithAccept();
    const box = byId(HOME_IDS.acceptMessage);
    box.value = 'Hi [first_name], about [role_name].';
    await box.dispatch('change');
    await byId('start').click();
    await settle();
    expect(screen.innerHTML).toContain('Hi [first_name], about [role_name].');

    byId(CONFIRM_IDS.send).click();
    await settle();
    expect(controller.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: { download: true, accept: true },
        acceptMessage: 'Hi [first_name], about [role_name].',
      }),
    );
    expect(byId(RUN_IDS.status)).not.toBe(null);
  });

  // Progress is accepted out of intended. The reviewer's own total drains as
  // the run proceeds, so it appears on the activity line as a position and
  // never as a denominator for progress.
  it('counts the accepts as they land, against what was intended', async () => {
    const screen = await homeWithAccept();
    await byId('start').click();
    await settle();
    byId(CONFIRM_IDS.send).click();
    await settle();

    emit({ type: 'accept_started', jobId: JOB_A, intended: 12, refusedNoResume: 4, alreadyAccepted: 1 });
    expect(screen.innerHTML).toContain('0 of 12 accepted');
    expect(screen.innerHTML).toContain('4 refused');

    emit({ type: 'accept_considering', jobId: JOB_A, userId: '70000001', index: 1, total: 116 });
    expect(byId(RUN_IDS.status).textContent).toBe('reading 1 of 116 in the review queue');

    emit({ type: 'accept_candidate', jobId: JOB_A, outcome: 'accepted', accepted: 1, intended: 12 });
    emit({ type: 'accept_candidate', jobId: JOB_A, outcome: 'skipped', accepted: 1, intended: 12 });
    expect(screen.innerHTML).toContain('1 of 12 accepted');
    expect(screen.innerHTML).toContain('1 passed over');
    expect(byId(RUN_IDS.status).textContent).toContain('passed over');
  });

  // The settle window is up to a minute of an irreversible operation being
  // investigated. It used to be a minute in which the panel said nothing at
  // all, which is indistinguishable from a hang.
  it('shows the settle window looking at the queue, look by look', async () => {
    await acceptRunning();

    emit({ type: 'accept_unconfirmed', jobId: JOB_A, userId: '70000001', error: 'no confirmation' });
    expect(byId(RUN_IDS.status).textContent).toContain('checking the review queue');
    // Nothing is known yet, so nothing here may read as bad news.
    expect(byId(RUN_IDS.status).textContent).not.toMatch(/fail|error/i);

    emit({ type: 'accept_checked', jobId: JOB_A, userId: '70000001', verdict: 'queued', look: 1 });
    expect(byId(RUN_IDS.status).textContent).toBe(`check 1${DOT}still in the review queue`);

    // The waits between looks come through as ordinary rests. Inside the settle
    // window they must not read as pacing.
    emit({ type: 'resting', jobId: JOB_A, ms: 15000 });
    expect(byId(RUN_IDS.status).textContent).toContain('check 1');
    expect(byId(RUN_IDS.status).textContent).toContain('checking again in 15s');
    expect(byId(RUN_IDS.status).textContent).not.toContain('resting');

    emit({ type: 'accept_checked', jobId: JOB_A, userId: '70000001', verdict: 'gone', look: 2 });
    expect(byId(RUN_IDS.status).textContent).toBe(`check 2${DOT}gone from the review queue`);
  });

  it('goes back to plain pacing once the settle window is over', async () => {
    await acceptRunning();
    emit({ type: 'accept_checked', jobId: JOB_A, userId: '70000001', verdict: 'gone', look: 2 });
    emit({ type: 'accept_candidate', jobId: JOB_A, outcome: 'accepted', accepted: 1, intended: 12 });
    emit({ type: 'resting', jobId: JOB_A, ms: 4000 });
    expect(byId(RUN_IDS.status).textContent).toContain('resting 4s');
    expect(byId(RUN_IDS.status).textContent).not.toContain('check');
  });

  // A reload is what keeps a long pass alive. Unexplained, it is the panel
  // reloading the operator's Wellfound tab for no stated reason.
  it('calls a reload maintenance, and lets a slow accept explain the next one', async () => {
    await acceptRunning();

    emit({ type: 'accept_reload', jobId: JOB_A, accepted: 6, intended: 12 });
    expect(byId(RUN_IDS.status).textContent).toBe(
      `reloading the page${DOT}routine, it keeps a long pass working`,
    );

    // accept_slow has no line of its own: it is the reason the next reload
    // happens, and it says so there.
    emit({ type: 'accept_slow', jobId: JOB_A, userId: '70000001', ms: 24000 });
    emit({ type: 'accept_candidate', jobId: JOB_A, outcome: 'accepted', accepted: 7, intended: 12 });
    emit({ type: 'accept_reload', jobId: JOB_A, accepted: 7, intended: 12 });
    expect(byId(RUN_IDS.status).textContent).toBe(`reloading the page${DOT}the last accept was slow`);

    // And the reason is spent, not sticky.
    emit({ type: 'accept_reload', jobId: JOB_A, accepted: 8, intended: 12 });
    expect(byId(RUN_IDS.status).textContent).toContain('routine');
  });

  it('says a reopen is a reopen when the tab was never reloaded', async () => {
    await acceptRunning();
    emit({ type: 'accept_reopen', jobId: JOB_A, accepted: 6, intended: 12 });
    expect(byId(RUN_IDS.status).textContent).toContain('reopening the review queue');
  });

  // The most serious state this pass has: the message went out and nothing here
  // remembers it. It goes to its own region so the next status line cannot wipe
  // it, and it carries the remedy.
  it('raises an unmissable alert when a sent message could not be recorded', async () => {
    const screen = await acceptRunning();
    const told =
      'The message to 70000001 was sent, and writing it to the ledger failed: quota exceeded. ' +
      'Before running this role again, check that person in Wellfound.';

    expect(byId(RUN_IDS.alert).hidden).toBe(true);
    emit({ type: 'accept_unrecorded', jobId: JOB_A, userId: '70000001', error: told });

    const alert = byId(RUN_IDS.alert);
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toBe(told);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.innerHTML).toContain('check that person in Wellfound');

    // And it survives the run's own next repaint, which replaces the body.
    emit({ type: 'candidate', outcome: 'downloaded', name: 'Jane Doe' });
    expect(byId(RUN_IDS.alert).textContent).toBe(told);
  });

  it('says nothing about accepting on a run that does not accept', async () => {
    const screen = await openPanel({
      stub: stubController({
        listJobs: vi.fn(async () => [job(JOB_A)]),
        startRun: vi.fn(() => new Promise(() => {})),
      }),
    });
    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');
    byId('start').click();
    await settle();
    expect(controller.startRun).toHaveBeenCalled();
    expect(screen.innerHTML).not.toContain('accepted');
  });
});

// End to end on the one screen where an overstated number cannot be taken
// back: the operator runs this retroactively over the same roles, so from the
// second run on the library holds people who have already been messaged and
// have left the review queue.
describe('the confirm screen over a role accepted before', () => {
  it('asks approval for the people who will actually be messaged', async () => {
    const screen = await openPanel({
      stub: stubController({
        listJobs: vi.fn(async () => [
          job(JOB_A, { actionableCount: 372, known: 312, accepted: 40, estimatedNew: 60 }),
        ]),
        startRun: vi.fn(() => new Promise(() => {})),
      }),
    });
    const pick = screen.querySelector('.job-pick');
    pick.checked = true;
    await pick.dispatch('change');
    // Accept only: the retroactive run, which downloads nobody and accepts the
    // people already on disk.
    byId('advanced').open = true;
    byId('preview').checked = true;
    const accept = byId(HOME_IDS.accept);
    accept.checked = true;
    await accept.dispatch('change');
    await byId('start').click();
    await settle();

    // 312 in the library, 40 of them messaged last run and gone from the queue,
    // so 272 are left to message and the 100 who applied since have no resume.
    expect(screen.innerHTML).toContain('Accept 272 people');
    expect(screen.innerHTML).toContain('372 in the review queue');
    expect(screen.innerHTML).toContain('272 will be messaged');
    expect(screen.innerHTML).toContain('100 refused');
    expect(screen.innerHTML).toContain('40 accepted by this extension on an earlier run');
    expect(screen.innerHTML).not.toContain('Accept 312 people');
  });
});
