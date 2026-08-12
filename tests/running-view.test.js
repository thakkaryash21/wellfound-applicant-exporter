import { describe, it, expect } from 'vitest';
import {
  runModel,
  renderRunBody,
  renderRunning,
  breakdownText,
  formatLeft,
  emptyCounts,
  pauseLine,
  candidateLine,
  pageLine,
  ETA_MIN_SAMPLE,
  RUN_IDS,
} from '../src/panel/running-view.js';

// The environment is node, with no DOM, which is exactly why this markup lives
// in its own module. Everything below reads the string the panel would insert.

function counts(over = {}) {
  return { ...emptyCounts(), ...over };
}

// Direct children of the element carrying `marker`, by walking tags and keeping
// only the ones at depth zero. Used to hold every grid row to its column count.
function childrenOf(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`no element matching ${marker}`);
  const tag = /<(\/?)([a-z]+)[^>]*>/g;
  tag.lastIndex = html.indexOf('>', start) + 1;
  let depth = 0;
  const kids = [];
  let match;
  while ((match = tag.exec(html))) {
    if (match[1] === '/') {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (depth === 0) kids.push(match[2]);
    depth += 1;
  }
  return kids;
}

describe('the run model', () => {
  it('counts everything processed, not only what was downloaded', () => {
    const model = runModel({
      counts: counts({ downloaded: 40, skipped: 5, failed: 2 }),
      estimate: 255,
    });
    expect(model.processed).toBe(47);
    expect(model.countText).toBe('47 of ~255 applicants');
  });

  it('drives the bar from everything processed against the estimate', () => {
    const model = runModel({ counts: counts({ downloaded: 50 }), estimate: 200 });
    expect(model.determinate).toBe(true);
    expect(model.percent).toBe(25);
  });

  // The estimate is Wellfound's counts minus the ledger, so it can be wrong in
  // either direction. A bar pinned full while the run keeps going would be a lie.
  it('stops drawing a bar once the run overtakes the estimate', () => {
    const model = runModel({ counts: counts({ downloaded: 260 }), estimate: 255 });
    expect(model.overtaken).toBe(true);
    expect(model.determinate).toBe(false);
    expect(model.percent).toBe(null);
    expect(model.countText).toContain('260 applicants');
    expect(model.countText).toContain('more than the ~255 expected');
    expect(model.note).toContain('estimate was low');
  });

  it('shows a plain count when it was never given a total', () => {
    for (const estimate of [null, undefined, 0]) {
      const model = runModel({ counts: counts({ downloaded: 3 }), estimate });
      expect(model.determinate).toBe(false);
      expect(model.countText).toBe('3 applicants so far');
      expect(model.note).toContain('no estimate');
    }
  });
});

describe('the time remaining', () => {
  it('says nothing until enough candidates have finished to mean anything', () => {
    const model = runModel({
      counts: counts({ downloaded: ETA_MIN_SAMPLE - 1 }),
      estimate: 250,
      elapsedMs: 60000,
    });
    expect(model.etaText).toBe('');
  });

  // Observed pace, breaks included - not the nominal pacing constants.
  it('comes from the run own observed pace', () => {
    const model = runModel({
      counts: counts({ downloaded: 50 }),
      estimate: 250,
      // 50 done in 2.5 minutes is 3s each; 200 left is 600s, ten minutes.
      elapsedMs: 150000,
    });
    expect(model.etaText).toBe('about 10 min left');
  });

  it('says nothing once there is nothing left to wait for', () => {
    const model = runModel({
      counts: counts({ downloaded: 250 }),
      estimate: 250,
      elapsedMs: 600000,
    });
    expect(model.etaText).toBe('');
  });

  it('rounds coarsely, because the pace swings between breaks', () => {
    expect(formatLeft(20000)).toBe('less than a minute left');
    expect(formatLeft(9.4 * 60000)).toBe('about 9 min left');
    expect(formatLeft(23 * 60000)).toBe('about 25 min left');
  });
});

describe('the breakdown', () => {
  it('names downloaded even at zero, so the run has something to say early', () => {
    expect(breakdownText(counts())).toBe('0 downloaded');
  });

  it('leaves out categories that have not happened', () => {
    expect(breakdownText(counts({ downloaded: 38 }))).toBe('38 downloaded');
  });

  it('rolls the three ways of passing someone over into one skipped count', () => {
    const text = breakdownText(counts({ downloaded: 38, skipped: 4, masked: 1, 'no-id': 1 }));
    expect(text).toContain('38 downloaded');
    expect(text).toContain('6 skipped');
  });

  it('names failures and previews separately', () => {
    const text = breakdownText(counts({ downloaded: 1, failed: 3, preview: 2 }));
    expect(text).toContain('3 failed');
    expect(text).toContain('2 previewed');
  });
});

describe('the role line', () => {
  it('names the role and its position in the run', () => {
    const model = runModel({
      counts: counts(),
      jobTitle: 'Backend Engineer',
      jobIndex: 2,
      jobTotal: 5,
    });
    expect(model.roleText).toContain('Backend Engineer');
    expect(model.roleText).toContain('job 2 of 5');
  });

  it('drops the position when there is only one role in the run', () => {
    const model = runModel({ counts: counts(), jobTitle: 'Backend Engineer', jobTotal: 1 });
    expect(model.roleText).toBe('Backend Engineer');
  });
});

describe('the running screen markup', () => {
  const model = runModel({
    counts: counts({ downloaded: 40, skipped: 5, failed: 2 }),
    estimate: 255,
    jobTitle: 'Backend Engineer',
    jobIndex: 2,
    jobTotal: 5,
    elapsedMs: 300000,
  });

  it('carries one progress bar, and only one', () => {
    const html = renderRunning(model);
    expect(html.match(/role="progressbar"/g)).toHaveLength(1);
  });

  it('gives the bar a name and the numbers a screen reader needs', () => {
    const html = renderRunBody(model);
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="255"');
    expect(html).toContain('aria-valuenow="47"');
    expect(html).toContain('aria-label="Applicants processed"');
    // The spoken value says the total is an estimate, as the visible one does.
    expect(html).toContain('~255');
  });

  it('makes the activity line a polite live region and nothing else', () => {
    const html = renderRunning(model);
    expect(html.match(/aria-live/g)).toHaveLength(1);
    expect(html).toContain(`id="${RUN_IDS.status}"`);
    expect(html).toContain('aria-live="polite"');
  });

  // A three-child row in a two-column grid is what produced the last layout bug
  // on this screen, so the head keeps exactly two children in every state.
  it('gives the two-column head exactly two children, time or no time', () => {
    expect(childrenOf(renderRunBody(model), 'class="run-head"')).toEqual(['p', 'p']);
    const early = runModel({ counts: counts({ downloaded: 1 }), estimate: 255 });
    expect(early.etaText).toBe('');
    expect(childrenOf(renderRunBody(early), 'class="run-head"')).toEqual(['p', 'p']);
  });

  it('keeps the lane and its explanation in one single-column row', () => {
    expect(childrenOf(renderRunning(model), 'class="run-lane"')).toEqual(['div', 'p']);
  });

  it('keeps the lane out of the part that is rebuilt on every candidate', () => {
    expect(renderRunBody(model)).not.toContain(`id="${RUN_IDS.lane}"`);
    expect(renderRunning(model)).toContain(`id="${RUN_IDS.lane}"`);
  });

  it('replaces the bar with a plain count when the estimate was overtaken', () => {
    const over = runModel({ counts: counts({ downloaded: 300 }), estimate: 255 });
    const html = renderRunBody(over);
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('class="run-note"');
    expect(childrenOf(html, 'class="run-head"')).toEqual(['p', 'p']);
  });

  it('escapes the role title, which comes from the page', () => {
    const html = renderRunBody(
      runModel({ counts: counts(), jobTitle: '<img src=x onerror=alert(1)>', jobTotal: 1 }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('offers the only control the screen has', () => {
    expect(renderRunning(model)).toContain(`id="${RUN_IDS.abort}"`);
    expect(renderRunning(model)).toContain('Stop the run');
  });
});

// The pause is the moment a user decides the panel has hung. It is idle by
// design for up to forty seconds, so it has to say that the wait is the point.
describe('the pause line', () => {
  it('counts down and says why it is waiting', () => {
    const line = pauseLine('rest', 22);
    expect(line).toContain('resting 22s');
    expect(line).toContain('pacing so this looks like a person');
  });

  it('names a reading break as the longer pause it is', () => {
    const line = pauseLine('break', 48);
    expect(line).toContain('reading break 48s');
    expect(line).toContain('a longer pause');
  });

  it('says it is resuming rather than showing a zero', () => {
    expect(pauseLine('rest', 0)).toContain('resuming');
    expect(pauseLine('rest', 0)).not.toContain('0s');
  });
});

describe('the activity line', () => {
  it('says what happened to the person just handled', () => {
    expect(candidateLine('downloaded', 'A Candidate')).toBe('saved A Candidate');
    expect(candidateLine('failed', 'A Candidate')).toBe('could not download A Candidate');
    expect(candidateLine('skipped', 'A Candidate')).toBe('skipped A Candidate');
    expect(candidateLine('no-id', 'A Candidate')).toBe('skipped A Candidate');
    expect(candidateLine('preview', 'A Candidate')).toBe('previewed A Candidate');
  });

  it('still says something when the person had no name to show', () => {
    expect(candidateLine('downloaded', undefined)).toBe('saved this applicant');
  });

  // A walk over pages that are entirely already-downloaded looks exactly like a
  // stall without the page number and the read/new pair.
  it('reports a page walk in the terms of the list being read', () => {
    const line = pageLine({ bucket: 'NEEDS_REVIEW', page: 3, fetched: 10, fresh: 4 });
    expect(line).toContain('needs review');
    expect(line).toContain('page 3');
    expect(line).toContain('10 read, 4 new');
  });

  it('falls back to a plain noun when the list is not named', () => {
    expect(pageLine({ page: 1, fetched: 10, fresh: 10 })).toContain('applicants');
  });
});
