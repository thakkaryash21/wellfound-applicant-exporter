import { escapeHtml } from './escape-html.js';
import { renderTraceRegion, traceText } from './trace-view.js';
import { localDateStamp, localClockStamp, localDateTimeText } from '../lib/local-time.js';

// The screen a run ends on. It exists because the summary answers "what happened
// last time" and Home answers "what do you want to do now", and one screen
// cannot honestly do both: Home used to open on the residue of a run the user
// had already finished with.
//
// Markup only, like running-view.js, so every string below can be rendered and
// asserted without a DOM.

export const POST_RUN_IDS = {
  title: 'post-run-title',
  download: 'run-download',
  done: 'run-done',
};

// Written as an escape so this file stays plain ASCII, as the rest of src does.
const DOT = ' \u00b7 ';

// A name a user can find in their downloads folder a week later, sorted next to
// the CSV of the same run. Local time, because that is the clock the run was
// watched on.
export function reportFilename(at = new Date()) {
  return `run-${localDateStamp(at)}-${localClockStamp(at)}.txt`;
}

// The whole screen as one plain-text file: the headline, the stop reason, the
// notes and the trace under them. One click, one file, so a user reporting a
// problem never has to describe the run in their own words.
//
// The notes taken are the ones on screen, names and all - this file goes to the
// user's own disk, which is where those names already are.
export function reportText(summary) {
  if (!summary) return '';
  const lines = ['Applicant Exporter for Wellfound: run report'];
  // `summary.at` is stored as an ISO instant, which is the right thing to keep;
  // it is the wrong thing to show. The reader watched this run on their own
  // clock, and the report's own filename is already on that clock.
  if (summary.at) lines.push(`Run at: ${localDateTimeText(summary.at)}`);
  lines.push('');
  if (summary.error) lines.push(`Error: ${summary.error}`);
  if (summary.headline) lines.push(summary.headline);
  for (const note of summary.notes ?? []) lines.push(note);
  const trace = traceText(summary.trace);
  if (trace) lines.push('', 'Details', trace);
  return `${lines.join('\n')}\n`;
}

// Done is the primary action and the download is secondary, so Done is the
// filled button and it comes first.
//
// Both buttons sit above the trace, not below it. The trace is bounded at 240px
// and a 300-step run fills it, so with the buttons underneath, the way out of
// this screen was off the bottom of a 400px-wide panel - reachable only by
// scrolling past a log, and by tabbing through a focusable scroll region on the
// way. The account of the run is the thing that scrolls; the way out is not.
export function renderPostRun(summary) {
  const s = summary ?? {};
  const when = s.at
    ? new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const stamp = when ? `${when}${DOT}` : '';
  return `
    <section class="post-run" aria-labelledby="${POST_RUN_IDS.title}">
      <h2 class="post-run-title" id="${POST_RUN_IDS.title}">What the run did</h2>
      <div class="run-summary" role="status">
        ${s.error ? `<p class="job-meta warn">${escapeHtml(s.error)}</p>` : ''}
        <p class="run-headline">${escapeHtml(stamp)}${escapeHtml(s.headline ?? '')}</p>
        ${(s.notes ?? []).map((n) => `<p class="job-meta">${escapeHtml(n)}</p>`).join('')}
      </div>
      <div class="post-run-actions">
        <button class="primary post-run-done" id="${POST_RUN_IDS.done}" type="button">Done</button>
        <button class="secondary" id="${POST_RUN_IDS.download}" type="button">
          Download this report
        </button>
      </div>
      ${renderTraceRegion(s.trace)}
    </section>`;
}
