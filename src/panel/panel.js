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
import { CONFIRM_IDS, confirmModel, renderConfirm } from './accept-confirm.js';
import { DEFAULT_MESSAGE } from '../lib/accept-message.js';
import {
  PAGE_DISCONNECTED,
  NO_WELLFOUND_TAB_CODE,
  NOT_IN_RECRUITER_AREA_CODE,
  watchTabs,
} from './tab-driver.js';
import { sleep } from '../lib/jitter.js';
import {
  RUN_IDS,
  runModel,
  renderRunBody,
  renderRunning as runningMarkup,
  emptyCounts,
  acceptCounts,
  pauseLine,
  candidateLine,
  pageLine,
  acceptConsideringLine,
  acceptCandidateLine,
  acceptUnconfirmedLine,
  acceptCheckedLine,
  acceptReloadLine,
  acceptUnrecordedLine,
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
  // 'home', 'confirm', 'post' or 'library'. The job list keeps loading behind
  // the post-run screen, so renderRun has to know not to paint over it - and
  // the post-run screen must not be re-rendered under a user who has just
  // clicked on it. The confirm screen is guarded for a sharper reason: a job
  // list finishing behind it would put Home back under a hand already moving
  // towards the button that sends a few hundred messages.
  view: 'home',
  // A load failure is a note on Home, not a screen of its own.
  loadError: null,
  // Set when that failure was the page losing its content script, which this
  // panel can put right by reloading the tab. The tab comes off the error, so
  // the remedy does not have to go looking for one.
  disconnectedTabId: null,
  // Set when the failure is one Wellfound itself fixes: no tab, or a tab
  // outside the recruiter area. Carried as the error's own marker so Home can
  // offer the link without reading the sentence.
  openWellfoundCode: null,
  // The load failed and the panel is listening for the tab to change so it can
  // try again. The user's own remedy - close it, open it again - is this, done
  // for them.
  waiting: false,
  hydrating: false,
  // Said out loud when a hydration pass ran and some counts are still missing.
  // Silence there left roles blank with nothing to explain them.
  hydrationNote: null,
  counts: null,
  // The accept pass, accumulated across every role in the run. Null until a
  // pass starts, so a run that accepts nobody says nothing about accepting.
  accept: null,
  // The look the settle window is on, while it is settling. Non-null only
  // between an unconfirmed send and whatever resolves it, which is what lets
  // the pauses inside that window read as looks rather than as pacing.
  settle: null,
  // A slow accept asks for a reload one candidate before the reload happens.
  // Held here so the reload can say why it is reloading.
  acceptSlow: false,
  estimate: null,
  // Which role the run is on, and when it started. The time remaining comes from
  // the run's own observed pace - breaks included - not from the pacing
  // constants, so the start time is the only input it needs.
  job: null,
  runStartedAt: null,
};
let lane = null;
let restTimer = null;
const settings = {
  folder: 'wellfound-resumes',
  fast: false,
  preview: false,
  advancedOpen: false,
  // Off unless the operator says otherwise, on every panel, every time. This is
  // the one setting whose default has to be the harmless one: it is the only
  // thing here that sends anything to anybody.
  accept: false,
  // The wording that will be sent. Held here rather than read out of the box at
  // send time so that the text on the confirm screen is the text that goes.
  acceptMessage: DEFAULT_MESSAGE,
};

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
  settings.preview = el(HOME_IDS.preview).checked;
  settings.advancedOpen = el(HOME_IDS.advanced).open;
  settings.accept = el(HOME_IDS.accept).checked;
  // Only present while accepting is on. Untick, retick, and the wording the
  // operator edited is still here rather than reset to the default under them.
  const message = el(HOME_IDS.acceptMessage);
  if (message) settings.acceptMessage = message.value;
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
    actions: { download: !settings.preview, accept: settings.accept },
    // The exact text the confirm screen showed. Passed rather than reached for,
    // so what was read is what is sent.
    acceptMessage: settings.acceptMessage,
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
    canReconnect: state.disconnectedTabId != null,
    hydrating: state.hydrating,
    hydrationNote: state.hydrationNote,
    waiting: state.waiting,
    openWellfoundCode: state.openWellfoundCode,
  });
}

// The retry the owner has been doing by hand. A load that failed on the page -
// no recruiter tab yet, a tab still arriving, a document that has not been
// connected yet - is not a final answer, so the panel listens for the tab to
// change and asks again. One listener at a time, dropped the moment it fires:
// the load it starts puts a fresh one back if it is still needed.
let unwatch = null;

function stopWatching() {
  unwatch?.();
  unwatch = null;
}

function watchForPage() {
  if (unwatch) return;
  unwatch = watchTabs(() => {
    stopWatching();
    load();
  });
}

// The remedy for a page whose content script was severed: reload it, wait for
// the document to come back, then ask again. The extension already holds host
// permission on wellfound.com, so this needs nothing new from the user.
const RELOAD_SETTLE_MS = 400;
const RELOAD_POLL_MS = 250;
const RELOAD_TIMEOUT_MS = 10000;

async function reloadTab(tabId) {
  await chrome.tabs.reload(tabId);
  // Chrome may still report the outgoing document as complete for an instant
  // after the reload is asked for, so the poll below starts once it has begun.
  await sleep(RELOAD_SETTLE_MS);
  const deadline = Date.now() + RELOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.status || tab.status === 'complete') return;
    } catch {
      // The tab is gone. Asking again is what will say so, in the panel's own
      // words, rather than anything invented here.
      return;
    }
    await sleep(RELOAD_POLL_MS);
  }
}

function renderRun() {
  // The post-run screen owns the panel until Done. A background job load
  // finishing must not replace the only account of the run that exists - nor
  // put Home back under a hand already reaching for the confirm screen's send.
  if (state.view === 'post' || state.view === 'confirm') return;

  const model = currentHomeModel();
  screen.innerHTML = renderHome(model);
  // Nothing on the empty screen to listen to, apart from the one thing that
  // offers a way out of it.
  if (model.empty) {
    document.getElementById(HOME_IDS.reconnect)?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const tabId = state.disconnectedTabId;
      if (tabId == null) return;
      // The panel is driving the tab now, so it must not also be reacting to
      // it: the reload it is about to ask for would otherwise start a second
      // load underneath this one.
      stopWatching();
      button.disabled = true;
      button.textContent = 'Reloading\u2026';
      await reloadTab(tabId);
      // The retry is the same load the button interrupted. A run is never
      // resumed this way: only the job list is asked for again.
      await load();
    });
    return;
  }

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

  // Ticking accept opens the wording under it, and unticking closes it. The
  // Start button changes with it, so both need the re-render.
  document.getElementById(HOME_IDS.accept)?.addEventListener('change', () => {
    captureSettings();
    renderRun();
  });

  // On change rather than on input, for the same reason the limit box is: the
  // screen is rebuilt wholesale, and rebuilding a textarea under a cursor
  // mid-sentence would throw the caret away. Blur is when the example updates.
  document.getElementById(HOME_IDS.acceptMessage)?.addEventListener('change', () => {
    captureSettings();
    renderRun();
  });

  document.getElementById(HOME_IDS.start)?.addEventListener('click', async () => {
    const options = globalSettings();
    // Nothing is sent from Home. A run that accepts goes through the confirm
    // screen first, and that screen is the only place startRun is called from
    // with `accept` on.
    if (options.actions.accept) {
      showConfirm(options);
      return;
    }
    await beginRun(options);
  });
}

// The last screen before anything leaves this computer. It is rendered from the
// job list and the per-role settings rather than from anything the run has
// done, because nothing has happened yet - that is the point of it.
function showConfirm(options) {
  state.view = 'confirm';
  const chosen = selectedJobs();
  screen.innerHTML = renderConfirm(
    confirmModel({
      jobs: chosen,
      settingFor: jobSettings,
      download: options.actions.download,
      message: options.acceptMessage,
    }),
  );
  // Back is what the focus lands on. The button that sends is reachable in one
  // more key press and never in none.
  const back = document.getElementById(CONFIRM_IDS.back);
  back?.addEventListener('click', () => {
    state.view = 'home';
    renderRun();
  });
  back?.focus();
  document.getElementById(CONFIRM_IDS.send)?.addEventListener('click', async () => {
    state.view = 'home';
    await beginRun(options);
  });
}

// Everything from the first request onwards, and the only caller of startRun.
// Split out of the Start button so that the confirm screen can reach it with
// the very options that screen was rendered from: the run must not re-read the
// controls after the operator has read the numbers back and agreed to them.
async function beginRun(options) {
  state.summary = null;
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
}

function currentModel() {
  return runModel({
    counts: state.counts,
    estimate: state.estimate,
    jobTitle: state.job?.title ?? null,
    jobIndex: state.job?.index ?? null,
    jobTotal: state.job?.total ?? null,
    elapsedMs: state.runStartedAt ? Date.now() - state.runStartedAt : 0,
    accept: state.accept,
  });
}

function renderRunning() {
  state.counts = emptyCounts();
  state.accept = null;
  state.settle = null;
  state.acceptSlow = false;
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
//
// `line` builds the text from the seconds left, because a pause inside the
// settle window has to keep saying which look it is waiting on rather than
// replacing that with a bare countdown.
function countdown(ms, line) {
  clearCountdown();
  if (!document.getElementById(RUN_IDS.status)) return;
  let left = Math.max(1, Math.round(ms / 1000));
  say(line(left));
  restTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearCountdown();
      say(line(0));
      return;
    }
    say(line(left));
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

// Shown, never hidden again: the run stops on the event that raises it, and the
// post-run screen replaces the whole screen anyway. Unhidden before the text
// lands so the region is in the document when its content changes, which is
// what makes the announcement happen.
function raiseAlert(text) {
  const alert = document.getElementById(RUN_IDS.alert);
  if (!alert) return;
  alert.hidden = false;
  alert.textContent = text;
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
    state.settle = null;
    if (state.counts && event.outcome in state.counts) state.counts[event.outcome] += 1;
    renderProgress();
    say(candidateLine(event.outcome, event.name));
    lane?.tick(event.outcome);
  }
  // The accept pass. Accumulated across every role in the run rather than reset
  // per job: the operator is watching one run, and `intended` is fixed before
  // the first keystroke of each pass, so the sum only ever grows.
  if (event.type === 'accept_started') {
    const accept = state.accept ?? acceptCounts();
    accept.intended += event.intended ?? 0;
    accept.refused += event.refusedNoResume ?? 0;
    accept.already += event.alreadyAccepted ?? 0;
    state.accept = accept;
    renderProgress();
  }
  if (event.type === 'accept_considering' && running) {
    clearCountdown();
    state.settle = null;
    say(acceptConsideringLine(event));
  }
  // A send the page could not vouch for, and the looks at the review queue that
  // follow it. This is up to a minute of an irreversible operation being
  // investigated, and it used to be a minute of silence.
  if (event.type === 'accept_unconfirmed' && running) {
    clearCountdown();
    state.settle = null;
    say(acceptUnconfirmedLine());
  }
  if (event.type === 'accept_checked' && running) {
    clearCountdown();
    state.settle = { verdict: event.verdict, look: event.look };
    say(acceptCheckedLine(state.settle));
  }
  // The reload cadence and the slow accept that can bring it forward. Kept for
  // the reload to explain itself with, rather than said on its own line one
  // candidate early where the next outcome would wipe it.
  if (event.type === 'accept_slow') state.acceptSlow = true;
  if ((event.type === 'accept_reload' || event.type === 'accept_reopen') && running) {
    clearCountdown();
    state.settle = null;
    say(acceptReloadLine({ reload: event.type === 'accept_reload', slow: state.acceptSlow }));
    state.acceptSlow = false;
  }
  // The message went out and nothing here remembers it. The run stops on this,
  // so it gets the one region on the screen that is not the activity line.
  if (event.type === 'accept_unrecorded') {
    clearCountdown();
    state.settle = null;
    raiseAlert(acceptUnrecordedLine(event));
  }
  if (event.type === 'accept_candidate') {
    clearCountdown();
    state.settle = null;
    if (state.accept) {
      if (event.outcome === 'accepted') state.accept.accepted += 1;
      else if (event.outcome === 'failed') state.accept.failed += 1;
      else if (event.outcome === 'skipped') state.accept.skipped += 1;
    }
    renderProgress();
    say(acceptCandidateLine(event.outcome, event));
    lane?.tick(event.outcome);
  }

  if (event.type === 'resting') {
    // The waits between looks are emitted as ordinary rests. Inside the settle
    // window they are not pacing, and saying "pacing so this looks like a
    // person" there would hide the one thing the operator needs to see.
    const settling = state.settle;
    countdown(event.ms, (left) =>
      settling ? acceptCheckedLine({ ...settling, seconds: left }) : pauseLine('rest', left),
    );
    lane?.rest(event.ms);
  }
  if (event.type === 'break') {
    countdown(event.ms, (left) => pauseLine('break', left));
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
  // Whatever brought this load about, it is the current attempt now. A listener
  // left over from the last failure would run a second one on top of it.
  stopWatching();
  state.loadError = null;
  state.disconnectedTabId = null;
  state.openWellfoundCode = null;
  state.hydrationNote = null;
  state.waiting = false;
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
    // A count that is still missing after a trip to fetch it is a blank the
    // user can see, so it is named rather than left unexplained. It says `yet`
    // because that is all this panel knows: nothing here writes a role off, and
    // the next load asks again.
    const missing = state.jobs.filter((job) => job.actionableCount == null).length;
    if (hydrationRan && missing > 0) {
      state.hydrationNote =
        `${missing} ${missing === 1 ? 'role has' : 'roles have'} no applicant count yet. ` +
        'Open that role\u2019s applicant list on Wellfound to see one.';
    }
  } catch (error) {
    state.jobs = [];
    // Nothing selectable survives a failed load, and a stale selection would let
    // Start fire a run against jobs this panel can no longer see.
    state.jobSettings.clear();
    state.expanded = null;
    state.loadError = error.message;
    // The marker, not the sentence: which failure this was is a fact the error
    // carries, and a screen that decided by reading the words would break the
    // day the words were improved.
    state.disconnectedTabId = error.code === PAGE_DISCONNECTED ? error.tabId : null;
    state.openWellfoundCode =
      error.code === NO_WELLFOUND_TAB_CODE || error.code === NOT_IN_RECRUITER_AREA_CODE
        ? error.code
        : null;
    // Every one of these failures is about the page, and every one of them is
    // undone by the tab moving: opening Wellfound, navigating into the
    // recruiter area, finishing a load, being reloaded. So the panel waits for
    // that rather than for the user to close it and open it again.
    state.waiting = true;
    watchForPage();
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
