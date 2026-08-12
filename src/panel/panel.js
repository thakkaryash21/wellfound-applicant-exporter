import { createController } from './run-controller.js';
import { createBreathLane } from './breath-lane.js';
import { renderLibrary } from './library.js';
import { escapeHtml } from './escape-html.js';
import { downloadBlobText } from './downloader.js';
import { renderPostRun, reportText, reportFilename, POST_RUN_IDS } from './post-run-view.js';
import { summarize } from './summary.js';
import {
  storeSummary,
  loadStoredSummary,
  markRunStarted,
  clearRunMarker,
  clearRun,
  takeInterruptedRun,
} from './summary-store.js';
import { setVerbose, isVerbose } from './verbose-console.js';
import { HOME_IDS, DEFAULT_LIMIT, sanitizeLimit, homeModel, renderHome } from './home-view.js';
import {
  RUN_IDS,
  runModel,
  renderRunBody,
  renderRunning as runningMarkup,
  emptyCounts,
  pauseLine,
  candidateLine,
  pageLine,
} from './running-view.js';

// The mount point, found by init(). Not read at import time: importing this
// module must not touch the document. See init() at the foot of the file.
let screen = null;
const state = {
  jobs: [],
  // jobId -> { selected, mode, limit, rereadPages }. Per role, because the owner
  // wants all of one and the first twenty-five of another in the same run.
  jobSettings: new Map(),
  // Only one role's settings are open at a time. Two open panels in a 320px
  // column is a scroll, not a choice.
  expanded: null,
  // The result of a run, and the only thing the post-run screen shows. Home
  // never reads it: what happened last time is not what you want to do now.
  summary: null,
  // 'home', 'post' or 'library'. The job list keeps loading behind the post-run
  // screen, so renderRun has to know not to paint over it - and the post-run
  // screen must not be re-rendered under a user who has just clicked on it.
  view: 'home',
  // A load failure is a note on Home, not a screen of its own.
  loadError: null,
  hydrating: false,
  // Said out loud when a hydration pass ran and some counts are still missing.
  // Silence there left roles blank with nothing to explain them.
  hydrationNote: null,
  counts: null,
  estimate: null,
  // Which role the run is on, and when it started. The time remaining comes from
  // the run's own observed pace - breaks included - not from the pacing
  // constants, so the start time is the only input it needs.
  job: null,
  runStartedAt: null,
};
let lane = null;
let restTimer = null;
const settings = { folder: 'wellfound-resumes', fast: false, dry: false, advancedOpen: false };

function jobSettings(jobId) {
  if (!state.jobSettings.has(jobId)) {
    state.jobSettings.set(jobId, {
      selected: false,
      // The default costs no decision: pick a role, press the button.
      mode: 'all',
      limit: DEFAULT_LIMIT,
      rereadPages: false,
    });
  }
  return state.jobSettings.get(jobId);
}

const selectedJobs = () => state.jobs.filter((job) => jobSettings(job.jobId).selected);

// The run loop lives in this page, so run events arrive as direct calls rather
// than as messages from the service worker.
const controller = createController({ onEvent: handleRunEvent });

// The screen is re-rendered wholesale on every change, so anything the user has
// typed or ticked has to be read back out of the DOM first or it is lost.
function captureSettings() {
  const el = (id) => document.getElementById(id);
  if (!el(HOME_IDS.folder)) return;
  settings.folder = el(HOME_IDS.folder).value;
  settings.fast = el(HOME_IDS.fast).checked;
  settings.dry = el(HOME_IDS.dry).checked;
  settings.advancedOpen = el(HOME_IDS.advanced).open;
  // The console mirror is the one thing in this extension allowed to print, so
  // it is read straight back out of the checkbox and never remembered anywhere:
  // every panel opens with it off.
  if (el(HOME_IDS.verbose)) setVerbose(el(HOME_IDS.verbose).checked);

  const jobId = state.expanded;
  if (jobId == null) return;
  const setting = jobSettings(jobId);
  const limitInput = el(HOME_IDS.limit(jobId));
  const reread = el(HOME_IDS.reread(jobId));
  const limitRadio = el(HOME_IDS.modeLimit(jobId));
  if (limitRadio) setting.mode = limitRadio.checked ? 'limit' : 'all';
  if (limitInput) setting.limit = sanitizeLimit(limitInput.value);
  if (reread) setting.rereadPages = reread.checked;
}

function setLibraryEnabled(enabled) {
  const nav = document.getElementById('nav-library');
  if (nav) nav.disabled = !enabled;
}

// Only the two settings that are genuinely run-wide. Everything else now
// belongs to a role.
function globalSettings() {
  captureSettings();
  return {
    folder: settings.folder.trim() || 'wellfound-resumes',
    pageSize: settings.fast ? 20 : 10,
    dryRun: settings.dry,
  };
}

// Infinity for "all new": runJob compares `downloaded.length >= limit`, so no
// number has to be invented for the unbounded case.
function requestedJobs() {
  return selectedJobs().map((job) => {
    const setting = jobSettings(job.jobId);
    return {
      jobId: job.jobId,
      limit: setting.mode === 'all' ? Infinity : setting.limit,
      forceFullWalk: setting.rereadPages,
    };
  });
}

// Deliberately not a run summary: nothing counted the work, so nothing here may
// name a number. What it can say is that the run stopped and what that costs.
function interruptedSummary(marker) {
  const when = marker?.startedAt
    ? new Date(marker.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  return {
    at: marker?.startedAt ? new Date(marker.startedAt).toISOString() : new Date().toISOString(),
    headline: when
      ? `The run started at ${when} was interrupted`
      : 'The last run was interrupted',
    notes: [
      'Closing the side panel stops the run, so it never finished and never reported.',
      'Some resumes may have landed on disk without being recorded, and some may ' +
        'have been saved under Wellfound\u2019s own filename. The next run will fetch ' +
        'those people again.',
    ],
    error: null,
  };
}

// The post-run screen. It owns the panel until Done, and Done is what disposes
// of the run: the stored summary and the marker go, and Home is reached with
// nothing of the run left to show. The ledger is untouched - who has been
// downloaded is the Library's record, not this screen's.
function showPostRun() {
  state.view = 'post';
  screen.innerHTML = renderPostRun(state.summary);

  document.getElementById(POST_RUN_IDS.download)?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try {
      await downloadBlobText({
        text: reportText(state.summary),
        mime: 'text/plain;charset=utf-8',
        filename: reportFilename(state.summary?.at ? new Date(state.summary.at) : new Date()),
        // The same folder the run's CSV and resumes went to, so the report is
        // filed beside the run it describes.
        folder: settings.folder.trim() || 'wellfound-resumes',
      });
      button.textContent = 'Saved to your downloads';
    } catch (error) {
      button.textContent = `Could not save: ${error.message}`;
    }
  });

  document.getElementById(POST_RUN_IDS.done)?.addEventListener('click', async () => {
    state.summary = null;
    state.view = 'home';
    await clearRun();
    load();
  });
}

// Home, as data. Recomputed rather than cached: the settings this reads are
// changed by the very listeners renderRun hangs, so a stale model would be a
// button promising a number the run would not honour - the bug this screen has
// had twice.
function currentHomeModel() {
  return homeModel({
    jobs: state.jobs,
    settingFor: jobSettings,
    expanded: state.expanded,
    settings,
    verbose: isVerbose(),
    loadError: state.loadError,
    hydrating: state.hydrating,
    hydrationNote: state.hydrationNote,
  });
}

function renderRun() {
  // The post-run screen owns the panel until Done. A background job load
  // finishing must not replace the only account of the run that exists.
  if (state.view === 'post') return;

  const model = currentHomeModel();
  screen.innerHTML = renderHome(model);
  // Nothing on the empty screen to listen to.
  if (model.empty) return;

  for (const box of screen.querySelectorAll('.job-pick')) {
    // Selecting a role must not open it. The card's own click handler is the
    // only thing above this in the tree, so the click stops here.
    box.addEventListener('click', (event) => event.stopPropagation?.());
    box.addEventListener('change', () => {
      captureSettings();
      jobSettings(box.dataset.id).selected = box.checked;
      renderRun();
    });
  }

  // Opening a role's settings must never pick that role for the run: the card
  // and the checkbox are two different questions.
  for (const button of screen.querySelectorAll('.job-open')) {
    button.addEventListener('click', (event) => {
      // The card forwards to this button, so this click must not go back up and
      // be forwarded a second time.
      event.stopPropagation?.();
      captureSettings();
      const id = button.dataset.id;
      state.expanded = state.expanded === id ? null : id;
      renderRun();
    });
  }

  // Changing a setting is not closing the panel it is in.
  for (const options of screen.querySelectorAll('.job-options')) {
    options.addEventListener('click', (event) => event.stopPropagation?.());
  }

  // The card's surface belongs to the accordion. The checkbox is already an easy
  // target, so widening it to the whole card would have spent every pixel on the
  // interaction that needed help least. Forwarded to the real button rather than
  // handled here, so `aria-expanded` and the accessible name stay on the one
  // element the user activates.
  for (const row of screen.querySelectorAll('.job-row')) {
    const opener = row.querySelector('.job-open');
    row.addEventListener('click', () => opener?.click());
  }

  // Both change what the button promises, so both re-render it. The number
  // re-renders on `change` rather than `input` so that typing is not
  // interrupted by the row being rebuilt under the cursor.
  for (const radio of screen.querySelectorAll('input[type="radio"]')) {
    radio.addEventListener('change', () => {
      captureSettings();
      renderRun();
    });
  }
  for (const input of screen.querySelectorAll('.limit-n')) {
    input.addEventListener('change', () => {
      captureSettings();
      const setting = jobSettings(input.dataset.id);
      // Typing a number is asking for that number. Making the user then find
      // the radio would be a trap.
      setting.mode = 'limit';
      setting.limit = sanitizeLimit(input.value);
      renderRun();
    });
  }

  document.getElementById(HOME_IDS.advanced)?.addEventListener('toggle', (event) => {
    settings.advancedOpen = event.target.open;
  });

  document.getElementById(HOME_IDS.start)?.addEventListener('click', async () => {
    state.summary = null;
    const options = globalSettings();
    const jobs = requestedJobs();
    // Stashed so the running screen can show a denominator. It is the same sum
    // the Start button promises. One role whose count the page never gave us
    // makes the whole total unknowable, and null is not zero: adding a silent
    // zero for it would understate the run and hand the screen a denominator it
    // would then overtake within minutes. Read after globalSettings(), which
    // captures whatever the user last typed, so the denominator is the number
    // the button was showing when it was pressed.
    state.estimate = currentHomeModel().estimate;
    renderRunning();
    // The Library screen drives the same tab (re-download navigates it), so it
    // must not be reachable while a run owns that tab.
    setLibraryEnabled(false);
    // Before the first request, so a panel closed one second in is still known
    // to have been interrupted.
    await markRunStarted();
    try {
      await controller.startRun({ jobs, ...options });
    } catch (error) {
      // The controller already emitted `done` carrying the totals and the error,
      // so the summary screen is up. Only a failure that produced no summary at
      // all needs the bare error screen.
      if (!state.summary) {
        // No `done` was emitted, so nothing cleared the marker and nothing will.
        await clearRunMarker();
        renderError(error.message);
      }
    } finally {
      setLibraryEnabled(true);
    }
  });
}

function currentModel() {
  return runModel({
    counts: state.counts,
    estimate: state.estimate,
    jobTitle: state.job?.title ?? null,
    jobIndex: state.job?.index ?? null,
    jobTotal: state.job?.total ?? null,
    elapsedMs: state.runStartedAt ? Date.now() - state.runStartedAt : 0,
  });
}

function renderRunning() {
  state.counts = emptyCounts();
  state.job = null;
  state.runStartedAt = Date.now();
  screen.innerHTML = runningMarkup(currentModel());
  // Created once and never rebuilt: replacing the lane's element mid-pause would
  // cancel the drain that is the only thing saying the pause is deliberate.
  lane = createBreathLane(document.getElementById(RUN_IDS.lane));
  document.getElementById(RUN_IDS.abort).addEventListener('click', () => {
    controller.abort();
    say('stopping after this candidate\u2026');
  });
}

// The activity line. One place, polite-live, so a screen reader hears what
// changed rather than the whole screen being re-announced.
function say(text) {
  const status = document.getElementById(RUN_IDS.status);
  if (status) status.textContent = text;
}

function renderError(message) {
  screen.innerHTML = `<p class="empty">${escapeHtml(message)}</p>`;
}

// A bare "resting" written once is indistinguishable from a hung panel, which is
// exactly what a reduced-motion user saw for minutes at a time.
function countdown(kind, ms) {
  clearCountdown();
  if (!document.getElementById(RUN_IDS.status)) return;
  let left = Math.max(1, Math.round(ms / 1000));
  say(pauseLine(kind, left));
  restTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearCountdown();
      say(pauseLine(kind, 0));
      return;
    }
    say(pauseLine(kind, left));
  }, 1000);
}

function clearCountdown() {
  if (restTimer) clearInterval(restTimer);
  restTimer = null;
}

// Only the part above the lane. The lane keeps its element and its animation.
function renderProgress() {
  const body = document.getElementById(RUN_IDS.body);
  if (!body || !state.counts) return;
  body.innerHTML = renderRunBody(currentModel());
}

function handleRunEvent(event) {
  const running = Boolean(document.getElementById(RUN_IDS.status));

  if (event.type === 'started') {
    state.job = {
      title: event.jobTitle ?? event.jobId,
      index: event.jobIndex,
      total: event.jobTotal,
    };
    renderProgress();
  }

  if (event.type === 'candidate') {
    clearCountdown();
    if (state.counts && event.outcome in state.counts) state.counts[event.outcome] += 1;
    renderProgress();
    say(candidateLine(event.outcome, event.name));
    lane?.tick(event.outcome);
  }
  if (event.type === 'resting') {
    countdown('rest', event.ms);
    lane?.rest(event.ms);
  }
  if (event.type === 'break') {
    countdown('break', event.ms);
    lane?.break(event.ms);
  }
  if (event.type === 'job_error' && running) {
    clearCountdown();
    say(event.error);
  }
  if (event.type === 'job_note' && running) {
    clearCountdown();
    say(`${event.jobTitle ?? event.jobId}: ${event.note}`);
  }

  // Without the page number and the read/new pair, a walk over pages that are
  // entirely already-downloaded is indistinguishable from a stall.
  if (event.type === 'page' && running) {
    clearCountdown();
    say(pageLine(event));
  }

  if (event.type === 'done') {
    clearCountdown();
    lane?.stop();
    state.summary = summarize(event, controller.trace.entries());
    storeSummary(state.summary);
    clearRunMarker();
    setLibraryEnabled(true);
    // Rendered before the reload, and the reload can no longer replace it. The
    // run's own account of itself must not depend on the tab still being open.
    showPostRun();
    load();
  }
}

// A failure here degrades to an inline note, never to a screen replacement. The
// summary of a twelve-minute run is the only record of it that exists, and
// listJobs fails for the most ordinary reason there is - the user closed the
// Wellfound tab while the run worked.
async function load() {
  if (!state.summary) {
    const interrupted = await takeInterruptedRun();
    // Takes precedence over the stored summary: that summary belongs to an
    // earlier run, and rendering it now would report a run that never finished.
    state.summary = interrupted ? interruptedSummary(interrupted) : await loadStoredSummary();
  }
  // An interruption is a run result like any other, so it lands on the same
  // screen. The job list carries on loading behind it, ready for Done, and a
  // run still unread is what the Library's Back button returns to.
  if (state.summary && state.view !== 'post') showPostRun();
  state.loadError = null;
  state.hydrationNote = null;
  let hydrationRan = false;
  try {
    state.jobs = await controller.listJobs({
      // The counts are missing and one page load will fetch them. Say so, once,
      // while it happens - the alternative is a panel that looks frozen.
      onHydrating: () => {
        hydrationRan = true;
        state.hydrating = true;
        renderRun();
      },
    });
    // A count that is still missing after a trip to fetch it is a fact about
    // this panel, not a blank to be left unexplained.
    const missing = state.jobs.filter((job) => job.actionableCount == null).length;
    if (hydrationRan && missing > 0) {
      state.hydrationNote =
        `${missing} ${missing === 1 ? 'role has' : 'roles have'} no applicant count yet. ` +
        'Open that role\u2019s applicant list on Wellfound, or reopen this panel to try again.';
    }
  } catch (error) {
    state.jobs = [];
    // Nothing selectable survives a failed load, and a stale selection would let
    // Start fire a run against jobs this panel can no longer see.
    state.jobSettings.clear();
    state.expanded = null;
    state.loadError = error.message;
  } finally {
    state.hydrating = false;
  }
  renderRun();
}

// The entry point, and the only thing in this file that reaches for the
// document before it is called.
//
// This module used to end in a bare `load()`, so importing it ran it - which
// meant it could not be imported outside a browser, which meant it could not be
// tested, which meant every piece of logic in it that wanted a test had to be
// moved to a file of its own. That is a bad reason to draw a module boundary,
// and this is what removes it.
//
// panel.html loads this file directly and cannot carry an inline script (the
// extension CSP forbids one), so the bootstrap stays here and is guarded on the
// mount point instead: only the panel document has #screen.
export function init() {
  screen = document.getElementById('screen');
  document.getElementById('nav-library').addEventListener('click', () => {
    state.view = 'library';
    renderLibrary(screen, { controller, onBack: load });
  });
  // Returned so a caller can wait for the first job list. panel.html ignores it.
  return load();
}

if (typeof document !== 'undefined' && document.getElementById('screen')) init();
