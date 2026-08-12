import { describe, it, expect } from 'vitest';
import { localDateStamp, localClockStamp, localDateTimeText } from '../src/lib/local-time.js';

// The run that produced the bug: 19:23:55 on 11 August, local, which is
// 02:23:55Z on 12 August. Every assertion below is about that one instant, so
// the tests fail loudly if anything goes back to reading it in UTC.
// The suite pins TZ to America/Los_Angeles; see vitest.config.js.
const EVENING = new Date('2026-08-12T02:23:55.586Z');

describe('the evening-local instant that falls on the next UTC day', () => {
  it('stamps the local date, not the UTC one', () => {
    expect(localDateStamp(EVENING)).toBe('2026-08-11');
  });

  it('stamps the local clock', () => {
    expect(localClockStamp(EVENING)).toBe('192355');
  });

  it('writes readable local text with no ISO T and no Z', () => {
    const text = localDateTimeText(EVENING);
    expect(text).toBe('2026-08-11 19:23:55');
    expect(text).not.toContain('T');
    expect(text).not.toContain('Z');
  });
});

describe('local-time helpers', () => {
  it('keeps the sortable YYYY-MM-DD shape, zero padded', () => {
    expect(localDateStamp(new Date(2026, 0, 5, 9, 4, 3))).toBe('2026-01-05');
    expect(localClockStamp(new Date(2026, 0, 5, 9, 4, 3))).toBe('090403');
  });

  it('accepts an ISO string as readily as a Date', () => {
    expect(localDateStamp('2026-08-12T02:23:55.586Z')).toBe('2026-08-11');
  });

  it('falls back to now rather than writing NaN into a filename', () => {
    expect(localDateStamp('not a date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(localClockStamp(undefined)).toMatch(/^\d{6}$/);
  });
});
