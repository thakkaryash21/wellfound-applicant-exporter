import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { installFakeDom } from './helpers/fake-dom.js';
import { SUMMARY_KEY, RUNNING_KEY } from '../src/panel/summary-store.js';
import { RUN_IDS } from '../src/panel/running-view.js';
import { POST_RUN_IDS } from '../src/panel/post-run-view.js';
import { HOME_IDS, RECONNECT_LABEL } from '../src/panel/home-view.js';
import { pageDisconnectedError } from '../src/panel/tab-driver.js';

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
