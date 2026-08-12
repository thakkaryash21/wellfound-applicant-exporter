import { describe, it, expect } from 'vitest';
import { renderPostRun, reportText, reportFilename, POST_RUN_IDS } from '../src/panel/post-run-view.js';
import { summarize } from '../src/panel/summary.js';
import { TRACE_TEXT_ID } from '../src/panel/trace-view.js';

// The environment is node, with no DOM, which is exactly why this markup lives
// in its own module. Everything below reads the string the panel would insert.

const ENTRIES = [
  { t: 0, step: 'run_start', count: 2, kind: 'live', pageSize: 10 },
  { t: 1500, step: 'focus_ready', jobId: '9100001', attempts: 3, ms: 1500 },
];

function done(over = {}) {
  return {
    type: 'done',
    downloaded: 3,
    failed: 1,
    skippedNoResume: 1,
    stoppedBecause: 'finished',
    ...over,
  };
}

describe('the post-run screen', () => {
  it('has a heading, and names it for a screen reader', () => {
    const html = renderPostRun(summarize(done(), ENTRIES));
    expect(html).toContain(`aria-labelledby="${POST_RUN_IDS.title}"`);
    expect(html).toContain(`id="${POST_RUN_IDS.title}"`);
    expect(html).toContain('What the run did');
  });

  // The one taxonomy, from summarize(), not a third count derived here.
  it('shows the summary exactly as summarize produced it', () => {
    const summary = summarize(done(), ENTRIES);
    const html = renderPostRun(summary);
    expect(html).toContain(summary.headline);
    for (const note of summary.notes) expect(html).toContain(note);
  });

  it('shows the trace open rather than behind a disclosure', () => {
    const html = renderPostRun(summarize(done(), ENTRIES));
    expect(html).not.toContain('<details');
    expect(html).toContain('focus_ready');
  });

  // Done is the way out of this screen and the download is optional, so Done is
  // the filled button and comes first in the source.
  it('offers exactly two buttons, Done primary and first', () => {
    const html = renderPostRun(summarize(done(), ENTRIES));
    const buttons = [...html.matchAll(/<button/g)];
    expect(buttons).toHaveLength(2);
    expect(html.indexOf(POST_RUN_IDS.done)).toBeLessThan(html.indexOf(POST_RUN_IDS.download));
    expect(html).toContain(`class="primary post-run-done" id="${POST_RUN_IDS.done}"`);
    expect(html).toContain('Download this report');
  });

  // The trace is bounded at 240px and fills it on any real run, so buttons under
  // it were off the bottom of the panel - and behind a focusable scroll region
  // for anyone tabbing.
  it('puts both buttons above the trace, so Done needs no scrolling to reach', () => {
    const html = renderPostRun(summarize(done(), ENTRIES));
    expect(html.indexOf(POST_RUN_IDS.done)).toBeLessThan(html.indexOf(TRACE_TEXT_ID));
    expect(html.indexOf(POST_RUN_IDS.download)).toBeLessThan(html.indexOf(TRACE_TEXT_ID));
  });

  it('escapes what a run reported', () => {
    const html = renderPostRun({
      at: null,
      headline: '<img src=x onerror=alert(1)>',
      notes: ['<script>bad()</script>'],
      error: '<b>boom</b>',
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>boom');
  });

  it('renders an interrupted run, which carries no trace and no counts', () => {
    const html = renderPostRun({
      at: new Date().toISOString(),
      headline: 'The last run was interrupted',
      notes: ['Closing the side panel stops the run.'],
      error: null,
    });
    expect(html).toContain('The last run was interrupted');
    expect(html).toContain(POST_RUN_IDS.done);
    expect(html).toContain(POST_RUN_IDS.download);
  });
});

describe('the downloadable report', () => {
  it('carries the summary and the trace in one file', () => {
    const summary = summarize(done(), ENTRIES);
    const text = reportText(summary);
    expect(text).toContain(summary.headline);
    for (const note of summary.notes) expect(text).toContain(note);
    expect(text).toContain('Details');
    expect(text).toContain('focus_ready jobId=9100001');
  });

  it('names the run and its error at the top', () => {
    const at = '2026-08-11T09:30:00.000Z';
    const text = reportText({ at, headline: '1 downloaded', notes: [], error: 'tab closed' });
    expect(text).toContain('Run at: 2026-08-11 02:30:00');
    expect(text).toContain('Error: tab closed');
  });

  it('heads the report with a local date and time, not the stored ISO instant', () => {
    // The run that produced this: 19:23 local on the 11th, 02:23Z on the 12th.
    // The header used to read `Run at: 2026-08-12T02:23:55.586Z` while the
    // report's own filename said run-2026-08-11-192355.
    const summary = { at: '2026-08-12T02:23:55.586Z', headline: '3 downloaded', notes: [] };
    const text = reportText(summary);
    expect(text).toContain('Run at: 2026-08-11 19:23:55');
    expect(text).not.toContain('2026-08-12');
    expect(text).not.toContain('Z');
    // And it agrees with the name of the file it is written into.
    expect(reportFilename(new Date(summary.at))).toBe('run-2026-08-11-192355.txt');
  });

  it('is empty when there is nothing to report', () => {
    expect(reportText(null)).toBe('');
  });

  it('is named so it sorts beside the run it describes', () => {
    const name = reportFilename(new Date(2026, 7, 11, 9, 30, 5));
    expect(name).toBe('run-2026-08-11-093005.txt');
  });

  it('falls back to now rather than to an unnameable file', () => {
    expect(reportFilename(new Date('not a date'))).toMatch(/^run-\d{4}-\d{2}-\d{2}-\d{6}\.txt$/);
  });
});

// The one outcome that needs the reader to go and look at Wellfound before
// doing anything else, so it sits above the headline rather than among the
// notes - and it goes into the report the same way.
describe('an accept that did not confirm', () => {
  const summary = {
    at: '2026-08-12T10:00:00.000Z',
    headline: '3 downloaded \u00b7 3 accepted',
    alert: 'Platform Engineer: an accept did not confirm.',
    notes: ['3 people were accepted and messaged.'],
  };

  it('is rendered above the headline, marked as a warning', () => {
    const html = renderPostRun(summary);
    expect(html).toContain('run-alert');
    expect(html).toContain('an accept did not confirm');
    expect(html.indexOf('run-alert')).toBeLessThan(html.indexOf('run-headline'));
  });

  it('is in the downloadable report too', () => {
    expect(reportText(summary)).toContain('Check this: Platform Engineer');
  });

  it('leaves no empty warning behind on a run that had none', () => {
    expect(renderPostRun({ ...summary, alert: null })).not.toContain('run-alert');
  });
});

// The operator asked for this directly: "I hope you are storing the
// configuration and the scope of the run so that in future I don't have to
// tell you the config I had set when starting it." Capturing it is worthless
// if the downloaded report does not carry it, and the capture lives in a
// different module from the rendering - so this asserts the seam, not the
// capture.
describe('the report carries what the run was asked to do', () => {
  it('prints the configuration above the outcome', () => {
    const text = reportText({
      at: '2026-08-12T12:39:22.000Z',
      configLines: ['What this run was asked to do', 'Platform Engineer: everyone new'],
      headline: '0 downloaded - 3 accepted',
    });
    const config = text.indexOf('What this run was asked to do');
    const headline = text.indexOf('0 downloaded');
    expect(config).toBeGreaterThan(-1);
    expect(config).toBeLessThan(headline);
  });

  it('still prints the configuration when the run died partway', () => {
    const text = reportText({
      configLines: ['What this run was asked to do', 'Platform Engineer: everyone new'],
      error: 'The Wellfound page lost its connection to the extension',
    });
    expect(text).toContain('What this run was asked to do');
    expect(text.indexOf('What this run was asked to do')).toBeLessThan(text.indexOf('Error:'));
  });

  it('adds no blank run of lines when there is no configuration to show', () => {
    const text = reportText({ headline: 'nothing to do' });
    expect(text).not.toMatch(/\n\n\n/);
  });
});
