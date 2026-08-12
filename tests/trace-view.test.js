import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderTraceRegion, TRACE_LABEL_ID, TRACE_TEXT_ID } from '../src/panel/trace-view.js';
import { setVerbose, isVerbose, consoleSink } from '../src/panel/verbose-console.js';

const ENTRIES = [
  { t: 0, step: 'run_start', count: 2, kind: 'live', pageSize: 10 },
  { t: 1500, step: 'focus_ready', jobId: '9100001', attempts: 3, ms: 1500 },
  { t: 2100, step: 'fetch', jobId: '9100001', count: 10, ms: 600 },
];

describe('the trace region', () => {
  it('is open on the post-run screen, and says how much is in it', () => {
    const html = renderTraceRegion(ENTRIES);
    expect(html).not.toContain('<details');
    expect(html).toContain('Details (3 steps)');
  });

  it('shows the whole trace as text', () => {
    expect(renderTraceRegion(ENTRIES)).toContain(
      '+  1500ms focus_ready jobId=9100001 attempts=3 ms=1500',
    );
  });

  // 300 entries must not push the Done button off the screen, and a region a
  // keyboard user can scroll has to be one they can reach and one a screen
  // reader can name.
  it('is a labelled, focusable, bounded scroll region', () => {
    const html = renderTraceRegion(ENTRIES);
    expect(html).toContain(`id="${TRACE_LABEL_ID}"`);
    expect(html).toContain(`aria-labelledby="${TRACE_LABEL_ID}"`);
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(`class="trace-log" id="${TRACE_TEXT_ID}"`);
  });

  it('shows nothing at all when there is no trace to show', () => {
    expect(renderTraceRegion([])).toBe('');
    expect(renderTraceRegion(undefined)).toBe('');
  });

  // The trace is rendered as markup, so a step name that ever carried a bracket
  // must not become an element.
  it('escapes what it prints', () => {
    const html = renderTraceRegion([{ t: 0, step: '<img src=x onerror=alert(1)>' }]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('the verbose console toggle', () => {
  afterEach(() => setVerbose(false));

  it('is off until the user turns it on', () => {
    expect(isVerbose()).toBe(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleSink({ t: 0, step: 'run_start' }, null);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('prints the step once the user has turned it on', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setVerbose(true);
    consoleSink({ t: 0, step: 'fetch', jobId: '9100001' }, { after: 'CURSOR9' });
    expect(log).toHaveBeenCalledWith('[wfx] +     0ms fetch jobId=9100001', {
      after: 'CURSOR9',
    });
    log.mockRestore();
  });

  it('goes quiet again when the user turns it off', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setVerbose(true);
    setVerbose(false);
    consoleSink({ t: 0, step: 'fetch' }, null);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

// What the screen claims about the trace has to be true of the trace. It said
// "no names and no links, so it is safe to paste into a message" while every
// candidate entry carries a Wellfound user id.
describe('what the trace region promises', () => {
  const html = () => renderTraceRegion([{ t: 0, step: 'candidate', userId: '7700001' }]);

  it('says user ids are in there', () => {
    expect(html()).toContain('Wellfound user ids');
  });

  it('does not claim more than that', () => {
    expect(html()).not.toContain('safe to paste');
  });

  it('is still true about names and links', () => {
    expect(html()).toContain('No names and no');
  });
});
