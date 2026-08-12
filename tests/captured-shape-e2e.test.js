// The test the captured-shape fixture exists for.
//
// Every other test in the suite meets the fixture at one seam and stops. That is
// how a fixture advertising itself as "the structure captured live" came to omit
// the `recruitCandidate.candidate` level entirely and stay green: nothing ever
// fed it to `normalizeNode`, which is the one function that reads that level.
//
// So this file walks the whole path in one go - capturedResponse -> unwrapPage
// -> normalizeNode -> toCsv - and asserts on the artifact a recruiter opens. If
// the fixture's nesting drifts again, the User ID column goes empty and this
// fails.
import { describe, it, expect } from 'vitest';
import { loadClassicScript, createFakeWindow } from './helpers/classic-script.js';
import { capturedResponse, applicantNode } from './helpers/captured-shape.js';
import { normalizeNode } from '../src/lib/normalize.js';
import { toCsv, CSV_COLUMNS } from '../src/lib/csv.js';

// collector.js is a classic script in the MAIN world, so it is loaded the way
// Chrome loads it rather than imported. See tests/helpers/classic-script.js.
function unwrapPage() {
  const fakeWindow = createFakeWindow();
  const { exposed } = loadClassicScript('src/content/collector.js', {
    globals: { window: fakeWindow.window, __APOLLO_CLIENT__: undefined },
    expose: '__WFX_COLLECTOR__',
  });
  return exposed.unwrapPage;
}

function csvRows(text) {
  return text
    .slice(1) // toCsv prefixes exactly one BOM character
    .split('\r\n')
    .filter((line) => line !== '');
}

function cell(row, header) {
  return row.split(',')[CSV_COLUMNS.findIndex((c) => c.header === header)];
}

describe('captured response to CSV', () => {
  it('carries a real userId and name from the captured shape into the CSV', () => {
    const page = unwrapPage()(
      capturedResponse({
        nodes: [
          applicantNode({ userId: '9100001', name: 'Jane Doe' }),
          // The same person shape with a numeric userId, because the `String()`
          // coercion in normalize.js is what keeps dedup's Set and reconcile's
          // filename parsing talking about the same people.
          applicantNode({ userId: 9100002, name: 'John Doe' }),
        ],
        title: 'Backend Engineer',
      }),
    );

    const records = page.edges.map((node) =>
      normalizeNode(node, { jobId: '9100001', jobTitle: page.jobTitle }),
    );

    // The assertion that would have caught the flattened fixture: null here is
    // what the whole run turns into "not identifiable" and a CSV of empty rows.
    expect(records.map((r) => r.userId)).toEqual(['9100001', '9100002']);
    expect(records.every((r) => typeof r.userId === 'string')).toBe(true);
    expect(records.map((r) => r.name)).toEqual(['Jane Doe', 'John Doe']);
    expect(records.map((r) => r.location)).toEqual(['Remote', 'Remote']);
    expect(records.map((r) => r.resumeUrl)).toEqual([
      'https://wellfound.com/link/9100001/tok/resume_url',
      'https://wellfound.com/link/9100002/tok/resume_url',
    ]);

    const rows = csvRows(toCsv(records));
    expect(rows).toHaveLength(3);
    expect(cell(rows[1], 'User ID')).toBe('9100001');
    expect(cell(rows[1], 'Name')).toBe('Jane Doe');
    expect(cell(rows[2], 'User ID')).toBe('9100002');
    expect(cell(rows[2], 'Name')).toBe('John Doe');
    expect(cell(rows[1], 'Job Title')).toBe('Backend Engineer');
  });
});
