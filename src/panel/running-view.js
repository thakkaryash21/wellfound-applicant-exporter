import { escapeHtml } from './escape-html.js';
import { PREVIEW } from '../lib/csv.js';

// The running screen: everything a twelve-minute run says about itself while it
// is happening.
//
// What it hides is a set of judgements the panel must not be making inline -
// whether there is an honest denominator to draw a bar against, whether the run
// has overtaken its own estimate, whether enough candidates have gone by for a
// time remaining to mean anything - and it settles them as data, in runModel,
// before any of it becomes markup. The panel hands it counts and an elapsed
// time and puts the result on screen.
//
// The shape follows the research: ONE determinate bar for the whole run, with
// the role and its position subordinate to it as text rather than as a second
// bar of equal weight. What the research does not cover is that most of this
// run's wall clock is spent deliberately idle, so a bar that has not moved for
// forty seconds is the normal case rather than a hang. That is what the lane and
// the activity line under it are for now: they say the pause is intentional and
// counting down, which is the one thing the bar cannot say.

// Only the elements something actually queries: the body renderProgress
// replaces, the status line, the lane and the stop button. The other six ids
// were emitted into the markup and read by nothing.
export const RUN_IDS = {
  body: 'run-body',
  status: 'run-status',
  lane: 'lane',
  abort: 'abort',
};

// The separator every panel screen puts between two facts on one line.
// Exported because post-run-view.js held a byte-identical copy, comment and
// all - the exact duplication escape-html.js exists to prevent.
// Written as an escape so this file stays plain ASCII, as the rest of src does.
export const DOT = ' \u00b7 ';

// Before this many candidates the observed pace has almost certainly not crossed
// a reading break, and a pace measured only across the short delays would
// promise a finish time roughly half the real one. A break falls every 8-12
// candidates, so twelve is the first point at which the average has seen one.
export const ETA_MIN_SAMPLE = 12;

export const PACING_NOTE = 'pacing so this looks like a person';

const EMPTY_COUNTS = {
  downloaded: 0,
  skipped: 0,
  failed: 0,
  masked: 0,
  'no-id': 0,
  [PREVIEW]: 0,
};

export function emptyCounts() {
  return { ...EMPTY_COUNTS };
}

function total(counts) {
  return Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0);
}

// Downloaded is always named, even at zero, because "0 downloaded" is a fact the
// user needs early in a run. The rest appear only once they have happened, so a
// clean run reads "38 downloaded" and not three zeroes.
export function breakdownText(counts) {
  const c = { ...EMPTY_COUNTS, ...(counts ?? {}) };
  const parts = [`${c.downloaded} downloaded`];
  const skipped = c.skipped + c['no-id'] + c.masked;
  if (skipped) parts.push(`${skipped} skipped`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c[PREVIEW]) parts.push(`${c[PREVIEW]} previewed`);
  return parts.join(DOT);
}

// Coarse on purpose. The pace of this run swings by whole seconds per candidate
// depending on where the next reading break lands, so "about 9 min left" is the
// most precision the number can honestly carry.
export function formatLeft(ms) {
  const minutes = ms / 60000;
  if (minutes < 1) return 'less than a minute left';
  if (minutes < 10) return `about ${Math.max(1, Math.round(minutes))} min left`;
  return `about ${Math.round(minutes / 5) * 5} min left`;
}

// The whole running screen as plain data, so every judgement it makes - whether
// the bar may be shown at all, whether the estimate has been overtaken, whether
// there is enough evidence for a time - is a value a test can read.
export function runModel({
  counts,
  estimate = null,
  jobTitle = null,
  jobIndex = null,
  jobTotal = null,
  elapsedMs = 0,
} = {}) {
  const processed = total(counts);
  // A zero or absent estimate is not a denominator. It means the panel was never
  // told, and null is not zero.
  const known = typeof estimate === 'number' && estimate > 0 ? estimate : null;
  // The estimate is Wellfound's own counts minus what the ledger already knows,
  // so it can be wrong in either direction. When the run overtakes it the honest
  // move is to stop drawing a bar rather than pin it full and keep going.
  const overtaken = known != null && processed > known;
  const determinate = known != null && !overtaken;

  let countText;
  if (determinate) countText = `${processed} of ~${known} applicants`;
  else if (overtaken) countText = `${processed} applicants${DOT}more than the ~${known} expected`;
  else countText = `${processed} applicants so far`;

  let note = null;
  if (overtaken) note = 'the estimate was low, so this is a plain count now';
  else if (known == null) note = 'no estimate to measure against, so this is a plain count';

  let etaText = '';
  if (determinate && processed >= ETA_MIN_SAMPLE && elapsedMs > 0) {
    const remaining = known - processed;
    if (remaining > 0) etaText = formatLeft((elapsedMs / processed) * remaining);
  }

  let roleText = '';
  if (jobTitle) {
    roleText =
      jobTotal > 1 ? `${jobTitle}${DOT}job ${jobIndex} of ${jobTotal}` : String(jobTitle);
  }

  return {
    processed,
    estimate: known,
    determinate,
    overtaken,
    percent: determinate ? Math.min(100, Math.round((processed / known) * 100)) : null,
    countText,
    etaText,
    note,
    roleText,
    breakdownText: breakdownText(counts),
  };
}

// The bar, or an honest admission that there is nothing to draw one against.
function renderBar(model) {
  if (!model.determinate) {
    return `<p class="run-note">${escapeHtml(model.note ?? '')}</p>`;
  }
  return `
      <div class="run-bar" role="progressbar"
           aria-label="Applicants processed"
           aria-valuemin="0" aria-valuemax="${model.estimate}"
           aria-valuenow="${model.processed}"
           aria-valuetext="${escapeHtml(model.countText)}">
        <div class="run-fill" style="width: ${model.percent}%"></div>
      </div>`;
}

// Everything above the lane, rebuilt whenever a candidate lands. The lane and
// the activity line are deliberately not in here: the lane owns a running
// animation, and replacing its element mid-pause would cancel the one piece of
// feedback that says the pause is deliberate.
export function renderRunBody(model) {
  // .run-head is a two-column grid, so it gets exactly two children whether or
  // not there is a time to show. An empty third child folded into the first
  // column is what produced the last layout bug on this screen.
  return `
    <div class="run-head">
      <p class="run-count num">${escapeHtml(model.countText)}</p>
      <p class="run-eta">${escapeHtml(model.etaText)}</p>
    </div>
    ${renderBar(model)}
    <p class="run-role">${escapeHtml(model.roleText)}</p>
    <p class="run-breakdown">${escapeHtml(model.breakdownText)}</p>`;
}

export function renderRunning(model) {
  return `
    <section class="run" aria-label="Export in progress">
      <div id="${RUN_IDS.body}">${renderRunBody(model)}</div>
      <div class="run-lane">
        <div id="${RUN_IDS.lane}"></div>
        <p class="run-status" id="${RUN_IDS.status}" role="status" aria-live="polite"></p>
      </div>
    </section>
    <button class="primary" id="${RUN_IDS.abort}" type="button">Stop the run</button>`;
}

// The pause is the moment a user decides the panel has hung, so it is the one
// line that has to explain itself rather than name itself. "resting" alone is
// worth nothing here; "resting 22s - pacing so this looks like a person" says
// the wait is the point.
export function pauseLine(kind, seconds) {
  const label = kind === 'break' ? 'reading break' : 'resting';
  if (seconds <= 0) return `${label}${DOT}resuming`;
  const why = kind === 'break' ? `a longer pause, ${PACING_NOTE}` : PACING_NOTE;
  return `${label} ${seconds}s${DOT}${why}`;
}

export function candidateLine(outcome, name) {
  const who = name || 'this applicant';
  if (outcome === 'downloaded') return `saved ${who}`;
  if (outcome === 'failed') return `could not download ${who}`;
  if (outcome === PREVIEW) return `previewed ${who}`;
  return `skipped ${who}`;
}

export function pageLine({ bucket, page, fetched, fresh }) {
  const name = bucket ? String(bucket).replace(/_/g, ' ').toLowerCase() : 'applicants';
  return `${name}${DOT}page ${page}${DOT}${fetched} read, ${fresh} new`;
}
