import { formatEntry } from '../lib/trace.js';
import { escapeHtml } from './escape-html.js';

// The trace, on screen. Its whole job is to answer "where did this run actually
// stop" for someone who will never read the source - so it is the run's own
// steps in order, with times relative to the start of the run.
//
// What it hides is how a trace becomes something a person can read: the join,
// the labelling, and the bounded, focusable scroll region that keeps three
// hundred steps from pushing the Done button off a 400px panel. trace.js
// deliberately has no text() of its own, so this is the only place that turns
// entries into lines and two implementations of the same join cannot drift.
//
// It sits on the post-run screen, whose entire purpose is showing what happened,
// so it is open by default; there is no copy button because that screen's
// download button takes the trace and the summary together in one file.

export const TRACE_LABEL_ID = 'trace-label';
export const TRACE_TEXT_ID = 'trace-text';

export function traceText(entries) {
  return (entries ?? []).map(formatEntry).join('\n');
}

// A labelled, focusable, bounded scroll region: 300 entries must not push the
// Done button off the screen, and a region a keyboard user can scroll has to be
// one they can reach.
export function renderTraceRegion(entries) {
  if (!entries?.length) return '';
  const count = entries.length;
  return `
    <div class="trace-body">
      <p class="label" id="${TRACE_LABEL_ID}">Details (${count} ${count === 1 ? 'step' : 'steps'})</p>
      <p class="job-meta">Every step of the run, in order. No names and no
        links. It does carry Wellfound user ids.</p>
      <pre class="trace-log" id="${TRACE_TEXT_ID}" role="region" tabindex="0"
           aria-labelledby="${TRACE_LABEL_ID}">${escapeHtml(traceText(entries))}</pre>
    </div>`;
}
