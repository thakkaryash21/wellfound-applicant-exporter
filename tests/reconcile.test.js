import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/lib/reconcile.js';

// The filename grammar's own tests moved to filename.test.js with it: this file
// is about the arithmetic, and the two regexes that used to live here were a
// second, unimported copy of a shape filename.js already owns.

const item = (path, overrides = {}) => ({
  filename: path,
  state: 'complete',
  exists: true,
  ...overrides,
});

describe('reconcile', () => {
  const record = { jobId: '9100001', userIds: ['1', '2', '3'] };

  it('verifies ids whose file is present', () => {
    const items = [item('/d/A-1-9100001.pdf'), item('/d/B-2-9100001.pdf')];
    expect(reconcile({ record, items }).verified.sort()).toEqual(['1', '2']);
  });

  it('reports ids whose file no longer exists on disk', () => {
    const items = [item('/d/A-1-9100001.pdf', { exists: false })];
    expect(reconcile({ record, items }).missing).toEqual(['1']);
  });

  it('reports interrupted downloads as missing', () => {
    const items = [item('/d/A-1-9100001.pdf', { state: 'interrupted' })];
    expect(reconcile({ record, items }).missing).toEqual(['1']);
  });

  it('reports ledger ids with no download record as unverifiable', () => {
    const items = [item('/d/A-1-9100001.pdf')];
    expect(reconcile({ record, items }).unverifiable.sort()).toEqual(['2', '3']);
  });

  it('reports downloads absent from the ledger as orphans to adopt', () => {
    const items = [item('/d/A-1-9100001.pdf'), item('/d/Z-99-9100001.pdf')];
    expect(reconcile({ record, items }).orphans).toEqual(['99']);
  });

  it('counts a retried download as present, never as both present and missing', () => {
    const items = [
      item('/d/A-1-9100001.pdf', { state: 'interrupted' }),
      item('/d/A-1-9100001.pdf'),
    ];
    const out = reconcile({ record, items });
    expect(out.verified).toEqual(['1']);
    expect(out.missing).toEqual([]);
  });

  it('ignores a download still in flight rather than calling it missing', () => {
    const items = [item('/d/A-1-9100001.pdf', { state: 'in_progress' })];
    const out = reconcile({ record, items });
    expect(out.missing).toEqual([]);
    expect(out.verified).toEqual([]);
    expect(out.unverifiable).toContain('1');
  });

  it('handles an empty history without throwing', () => {
    const out = reconcile({ record, items: [] });
    expect(out.verified).toEqual([]);
    expect(out.unverifiable.sort()).toEqual(['1', '2', '3']);
  });
});
