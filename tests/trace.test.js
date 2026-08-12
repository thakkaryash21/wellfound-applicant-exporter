import { describe, it, expect, vi } from 'vitest';
import { createTrace, scrubVariables, formatEntry } from '../src/lib/trace.js';
import { traceText } from '../src/panel/trace-view.js';

// A clock the test moves, so a duration in a trace entry is a stated number
// rather than whatever the machine happened to take.
function clock(start = 0) {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

describe('what a trace may contain', () => {
  // The rule the whole design exists to keep: this has to be pasteable into a
  // chat window with no redaction. A step name is worth nothing next to that.
  it('never records an applicant name, however it is handed one', () => {
    const trace = createTrace();
    trace.record('candidate', {
      jobId: '9100001',
      userId: '7700001',
      name: 'Jane Doe',
      candidateName: 'Jane Doe',
      email: 'jane@example.com',
      outcome: 'downloaded',
    });
    const text = JSON.stringify(trace.entries()) + traceText(trace.entries());
    expect(text).not.toContain('Jane Doe');
    expect(text).not.toContain('jane@example.com');
    expect(trace.entries()[0]).toMatchObject({ jobId: '9100001', userId: '7700001' });
  });

  it('never records a resume URL, even quoted inside an error message', () => {
    const trace = createTrace();
    trace.record('candidate', {
      jobId: '9100001',
      outcome: 'failed',
      error: 'Forbidden: https://wellfound.com/link/7700001/tok/resume_url expired',
    });
    expect(traceText(trace.entries())).not.toContain('wellfound.com');
    expect(trace.entries()[0].error).toBe('Forbidden: [url] expired');
  });

  it('refuses a whole object where it expects a value, rather than flattening it', () => {
    // A stopped clock, because the assertion below names `t` and the real one
    // can tick between the constructor and the record.
    const trace = createTrace({ now: clock().now });
    trace.record('page', { jobId: '9100001', count: { records: [{ name: 'Jane Doe' }] } });
    expect(trace.entries()[0]).toEqual({ t: 0, step: 'page', jobId: '9100001' });
  });

  it('truncates a long message rather than pasting a document into the trace', () => {
    const trace = createTrace();
    trace.record('fetch_error', { error: 'x'.repeat(5000) });
    expect(trace.entries()[0].error.length).toBe(200);
  });
});

describe('the shape of a trace', () => {
  it('times every step from the start of the run, not from the epoch', () => {
    const c = clock(1_700_000_000_000);
    const trace = createTrace({ now: c.now });
    c.advance(1500);
    trace.record('focus_ready', { jobId: '9100001', attempts: 3 });
    expect(trace.entries()[0].t).toBe(1500);
  });

  it('starts the clock again when a new run starts', () => {
    const c = clock();
    const trace = createTrace({ now: c.now });
    c.advance(9000);
    trace.record('run_end', {});
    trace.reset();
    c.advance(40);
    trace.record('run_start', {});
    expect(trace.entries()).toEqual([{ t: 40, step: 'run_start' }]);
  });

  it('keeps the most recent steps once it is full, not the first ones', () => {
    const trace = createTrace({ cap: 3 });
    for (const page of [1, 2, 3, 4, 5]) trace.record('page', { page });
    expect(trace.entries().map((e) => e.page)).toEqual([3, 4, 5]);
  });

  // One line per step, scannable, with the time first: a trace nobody can read
  // is as useless as no trace.
  it('writes one scannable line per step', () => {
    expect(formatEntry({ t: 1500, step: 'focus_ready', jobId: '9100001', attempts: 3 })).toBe(
      '+  1500ms focus_ready jobId=9100001 attempts=3',
    );
  });
});

describe('the verbose console mirror', () => {
  it('is handed each entry as it happens, with the extra detail scrubbed', () => {
    const sink = vi.fn();
    const trace = createTrace({ sink, now: clock().now });
    trace.record('fetch', { jobId: '9100001', count: 10 }, { after: 'CURSOR9', name: 'Jane Doe' });
    expect(sink).toHaveBeenCalledWith(
      { t: 0, step: 'fetch', jobId: '9100001', count: 10 },
      { after: 'CURSOR9' },
    );
  });

  it('does not take the run down when it throws', () => {
    const trace = createTrace({
      sink: () => {
        throw new Error('console gone');
      },
    });
    expect(() => trace.record('page', { page: 1 })).not.toThrow();
    expect(trace.entries()).toHaveLength(1);
  });
});

describe('scrubVariables', () => {
  it('keeps the request shape and drops the filter values', () => {
    expect(
      scrubVariables({
        jobId: 9100001,
        first: 10,
        after: 'CURSOR9',
        filters: { status: 'IN_REVIEW', search: 'Jane Doe' },
      }),
    ).toEqual({
      jobId: '9100001',
      first: 10,
      after: 'CURSOR9',
      filterKeys: 'search,status',
      bucket: 'IN_REVIEW',
    });
  });

  it('has nothing to say about a request with no variables', () => {
    expect(scrubVariables(null)).toBe(null);
  });
});
