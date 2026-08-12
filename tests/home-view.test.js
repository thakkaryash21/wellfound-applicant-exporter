import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { CX } from '../src/lib/messages.js';
import { APPLICANTS_URL } from '../src/panel/tab-driver.js';
import {
  DEFAULT_LIMIT,
  sanitizeLimit,
  estimateFor,
  askedFor,
  jobSubtitle,
  startLabel,
  runEstimate,
  homeModel,
  renderHome,
  HOME_IDS,
  RECONNECT_LABEL,
} from '../src/panel/home-view.js';

// The environment is node, with no DOM, which is the point of this module: the
// counting arithmetic behind the Start button is the highest-risk logic in the
// panel - it produced the button-promises-N-fetches-M bug twice - and every
// judgement it makes is now a value rather than a rendered string.

const job = (over = {}) => ({
  jobId: '9100001',
  title: 'Platform Engineer',
  actionableCount: 4,
  estimatedNew: 3,
  ...over,
});

const setting = (over = {}) => ({
  selected: false,
  mode: 'all',
  limit: DEFAULT_LIMIT,
  rereadPages: false,
  ...over,
});

const settings = { folder: 'wellfound-resumes', fast: false, preview: false, advancedOpen: false };

function model(jobs, settingsByJob = {}, over = {}) {
  return homeModel({
    jobs,
    settingFor: (jobId) => settingsByJob[jobId] ?? setting(),
    settings,
    ...over,
  });
}

// Moved from panel.test.js with its subject. The coercion has one caller - the
// box below Home's "first N" radio - and both readers of that number, the
// button's label and the run's limit, go through it.
describe('the limit-n box', () => {
  it('keeps a plain number', () => {
    expect(sanitizeLimit('25')).toBe(25);
    expect(sanitizeLimit(7)).toBe(7);
  });

  it('lifts a negative to one, which is what the run would have done anyway', () => {
    expect(sanitizeLimit('-5')).toBe(1);
  });

  it('lifts zero to one', () => {
    expect(sanitizeLimit('0')).toBe(1);
  });

  it('takes the default for an empty box', () => {
    expect(sanitizeLimit('')).toBe(DEFAULT_LIMIT);
    expect(sanitizeLimit(null)).toBe(DEFAULT_LIMIT);
    expect(sanitizeLimit(undefined)).toBe(DEFAULT_LIMIT);
  });

  it('takes the default for something that is not a number', () => {
    expect(sanitizeLimit('twelve')).toBe(DEFAULT_LIMIT);
    expect(sanitizeLimit('12a')).toBe(DEFAULT_LIMIT);
  });

  it('floors a fraction, because a fraction is not a number of people', () => {
    expect(sanitizeLimit('2.7')).toBe(2);
    expect(sanitizeLimit('0.4')).toBe(1);
  });

});

// The bug this file exists for, asserted end to end rather than as arithmetic:
// the number printed on the Start button and the number the run actually fetches
// are produced by two different readers - homeModel/startLabel here, and
// run-controller's `limit` on its way into runJob - and they used to disagree.
// Both are called below, over the same typed strings, with a real run behind the
// second one.
describe('what the button promises against what the run fetches', () => {
  const JOB = '9100001';
  const TAB = 7;
  // More applicants waiting than any sane box asks for, so "9999" is capped by
  // the queue rather than by the box, and the two readers have to agree on that
  // cap as well.
  const ROSTER = Array.from({ length: 30 }, (_, i) => ({
    userId: String(7700001 + i),
    name: `Person ${i + 1}`,
  }));

  // The page's answers, in the shapes bridge.js sends.
  function fakePage() {
    return async (message, context) => {
      if (message.type === CX.QUERY_READY) {
        const jobId = String(context?.tab?.url ?? '').match(/jobs\/(\d+)/)?.[1] ?? null;
        return { ok: true, data: jobId ? { jobId } : null };
      }
      if (message.type === CX.LIST_JOBS) {
        return {
          ok: true,
          data: [{ jobId: JOB, title: 'Platform Engineer', actionableCount: ROSTER.length }],
        };
      }
      if (message.type === CX.FETCH_PAGE) {
        const { pageSize, after } = message.payload;
        const start = after ? Number(after) : 0;
        const slice = ROSTER.slice(start, start + pageSize);
        return {
          ok: true,
          data: {
            jobTitle: 'Platform Engineer',
            bucket: 'IN_REVIEW',
            edges: slice.map((p) => ({
              id: `JP${p.userId}`,
              currentApplication: { submittedAt: 1786465883 },
              recruitCandidate: {
                masked: false,
                candidate: {
                  userId: p.userId,
                  name: p.name,
                  currentLocation: null,
                  resumeUrl: `/link/${p.userId}/tok/resume_url`,
                },
              },
            })),
            endCursor: String(start + slice.length),
            hasNextPage: start + slice.length < ROSTER.length,
          },
        };
      }
      return { ok: false, error: `unexpected message ${message.type}` };
    };
  }

  let fake;

  beforeEach(() => {
    // Not available in node, and the CSV writer needs it.
    globalThis.URL.createObjectURL = () => 'blob:wfx/1';
    globalThis.URL.revokeObjectURL = () => {};
  });

  afterEach(() => {
    fake?.restore();
    delete globalThis.URL.createObjectURL;
    delete globalThis.URL.revokeObjectURL;
  });

  // What panel.js does with the box: sanitise on capture, and treat a typed
  // number as a request for that number.
  async function runWithLimit(limit) {
    fake = installFakeChrome({
      tabs: [{ id: TAB, url: `${APPLICANTS_URL}jobs/${JOB}` }],
      pages: { [TAB]: fakePage() },
    });
    vi.resetModules();
    const { createController } = await import('../src/panel/run-controller.js');
    const controller = createController({ onEvent: () => {}, sleep: async () => {} });
    await controller.startRun({
      jobs: [{ jobId: JOB, limit }],
      folder: 'resumes',
      pageSize: 10,
    });
    const fetched = fake.calls.downloads.filter((d) => String(d.url).includes('resume_url')).length;
    fake.restore();
    fake = null;
    return fetched;
  }

  it('fetches exactly the number on the button, whatever was typed', async () => {
    for (const typed of ['', '0', '7', '9999', 'twelve', '-5']) {
      // Reader one: the box is captured once, and the button label is a function
      // of that capture.
      const limit = sanitizeLimit(typed);
      const m = homeModel({
        jobs: [{ jobId: JOB, title: 'Platform Engineer', actionableCount: ROSTER.length, estimatedNew: ROSTER.length }],
        settingFor: () => setting({ selected: true, mode: 'limit', limit }),
        settings,
      });
      const promised = Number(m.startLabel.match(/\d+/)?.[0]);
      expect(m.startLabel, `typed ${JSON.stringify(typed)}`).toMatch(/^Download \d+ resumes?$/);

      // Reader two: the same captured number, read by the run.
      const fetched = await runWithLimit(limit);
      expect(fetched, `typed ${JSON.stringify(typed)}`).toBe(promised);
    }
  }, 30000);
});

describe('what a role can honestly claim is waiting', () => {
  it('prefers the ledger-adjusted estimate to the raw queue count', () => {
    expect(estimateFor(job())).toBe(3);
  });

  it('falls back to the queue count before a first run', () => {
    expect(estimateFor(job({ estimatedNew: undefined }))).toBe(4);
  });

  it('is null when the page has not said, because null is not zero', () => {
    expect(estimateFor(job({ estimatedNew: null, actionableCount: null }))).toBe(null);
  });

  it('is capped by the number the role was asked for', () => {
    expect(askedFor(job(), setting({ mode: 'limit', limit: 2 }))).toBe(2);
    // Asking for more than there are does not invent people.
    expect(askedFor(job(), setting({ mode: 'limit', limit: 90 }))).toBe(3);
  });
});

describe('the subtitle under a role', () => {
  it('says how many are waiting and how many are new', () => {
    expect(jobSubtitle(job())).toBe('4 applicants \u00b7 3 new');
  });

  it('says all downloaded rather than "0 new"', () => {
    expect(jobSubtitle(job({ estimatedNew: 0 }))).toBe('4 applicants \u00b7 all downloaded');
  });

  it('says the count is not loaded rather than showing nothing', () => {
    expect(jobSubtitle(job({ actionableCount: null }))).toBe('applicant count not loaded yet');
  });

  it('says applicant, singular, for one', () => {
    expect(jobSubtitle(job({ actionableCount: 1, estimatedNew: 1 }))).toBe('1 applicant \u00b7 1 new');
  });
});

describe('what the Start button promises', () => {
  it('asks for a role when none is picked', () => {
    expect(startLabel([])).toBe('Select a role');
  });

  it('names the number it will actually fetch', () => {
    expect(startLabel([3])).toBe('Download 3 resumes');
    expect(startLabel([1])).toBe('Download 1 resume');
    expect(startLabel([3, 2])).toBe('Download 5 resumes');
  });

  // The bug this exists for: the button promised the whole backlog under a
  // limit that would have refused most of it.
  it('shows no number at all when any role cannot be counted', () => {
    expect(startLabel([3, null])).toBe('Download new resumes');
  });

  it('offers to look rather than to download when there is nothing new', () => {
    expect(startLabel([0])).toBe('Check for new applicants');
  });
});

describe('the run estimate', () => {
  it('is null when any role is uncountable, so the bar is not drawn against a lie', () => {
    expect(runEstimate([3, null])).toBe(null);
    expect(runEstimate([])).toBe(null);
  });
});

describe('homeModel', () => {
  it('says the screen is empty while the jobs are still being read', () => {
    const m = model([], {}, { hydrating: true });
    expect(m.empty).toBe(true);
    expect(m.message).toContain('Reading your jobs');
    // No hint under a message that is already explaining itself.
    expect(m.hint).toBe(false);
  });

  it('shows a load failure as the message, not as a screen of its own', () => {
    const m = model([job()], {}, { loadError: 'Open Wellfound to get started' });
    expect(m.empty).toBe(true);
    expect(m.message).toBe('Open Wellfound to get started');
  });

  it('offers the hint only when nothing is loading and nothing has failed', () => {
    expect(model([]).hint).toBe(true);
  });

  // The remedy is a fact passed in, never inferred from the message: a screen
  // that read the sentence would break the day the sentence was reworded.
  it('offers the reload only when the failure is one a reload fixes', () => {
    expect(model([], {}, { loadError: 'lost the page', canReconnect: true }).reconnect).toBe(true);
    expect(model([], {}, { loadError: 'lost the page' }).reconnect).toBe(false);
    expect(model([], {}, { canReconnect: true }).reconnect).toBe(false);
  });

  it('counts only the roles that are picked', () => {
    const m = model([job(), job({ jobId: '9100002', estimatedNew: 2 })], {
      '9100001': setting({ selected: true }),
      '9100002': setting(),
    });
    expect(m.selectedCount).toBe(1);
    expect(m.estimate).toBe(3);
    expect(m.startLabel).toBe('Download 3 resumes');
  });

  it('gives the button and the running screen the same number', () => {
    const m = model([job()], { '9100001': setting({ selected: true, mode: 'limit', limit: 2 }) });
    expect(m.startLabel).toBe('Download 2 resumes');
    expect(m.estimate).toBe(2);
  });

  it('marks the one open role and no other', () => {
    const m = model([job(), job({ jobId: '9100002' })], {}, { expanded: '9100002' });
    expect(m.rows.map((r) => r.open)).toEqual([false, true]);
  });

  it('carries the hydration note when there is one', () => {
    const m = model([job()], {}, { hydrationNote: '1 role has no applicant count yet.' });
    expect(m.note).toContain('no applicant count yet');
  });
});

describe('renderHome', () => {
  it('renders the empty screen with no settings form under it', () => {
    const html = renderHome(model([], {}, { loadError: 'nope' }));
    expect(html).toContain('nope');
    expect(html).not.toContain(`id="${HOME_IDS.start}"`);
  });

  it('puts the reload button on the empty screen when one is offered', () => {
    const failed = { loadError: 'lost the page', canReconnect: true };
    const html = renderHome(model([], {}, failed));
    expect(html).toContain(`id="${HOME_IDS.reconnect}"`);
    expect(html).toContain(RECONNECT_LABEL);
    expect(renderHome(model([], {}, { loadError: 'lost the page' }))).not.toContain(
      `id="${HOME_IDS.reconnect}"`,
    );
  });

  it('disables Start until a role is picked', () => {
    expect(renderHome(model([job()]))).toContain('disabled');
    const picked = model([job()], { '9100001': setting({ selected: true }) });
    expect(renderHome(picked)).toContain(`id="${HOME_IDS.start}"`);
    expect(renderHome(picked)).not.toContain('type="button" disabled');
  });

  it('escapes a role title rather than rendering it as markup', () => {
    const html = renderHome(model([job({ title: '<img src=x>' })]));
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img');
  });

  it('hides the options of a role that is not open', () => {
    expect(renderHome(model([job()]))).toContain('hidden');
  });

  // The card is what the user activates, so the disclosure state and the
  // accessible name live on it. The checkbox is a sibling of that button, never
  // a descendant: a control inside a control is the trap this restructure avoids.
  it('puts aria-expanded and the name on the button the user activates', () => {
    const html = renderHome(model([job({ title: 'Backend' })]));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Settings for Backend"');
    expect(html).toContain(`aria-controls="${HOME_IDS.options('9100001')}"`);
    const open = html.slice(html.indexOf('<button class="job-open"') + 1);
    const button = open.slice(0, open.indexOf('</button>'));
    expect(button).not.toContain('<input');
    expect(button).not.toContain('<button');
  });

  it('gives the checkbox its own name now that the title is not its label', () => {
    const html = renderHome(model([job({ title: 'Backend' })]));
    expect(html).toContain('aria-label="Include Backend in the run"');
    expect(html).not.toContain(`for="${HOME_IDS.pick('9100001')}"`);
  });

  // One arrow that rotates, not two glyphs stacked in a box. The character the
  // chevron used to be is absent from the panel's font, so Chrome drew the
  // missing-glyph box - four hex digits in two rows - which is what the owner saw.
  it('draws one chevron rather than a character the font may not have', () => {
    const html = renderHome(model([job()]));
    expect(html).not.toContain('⌄');
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(html.match(/<path/g)).toHaveLength(1);
    expect(html.match(/class="chevron"/g)).toHaveLength(1);
  });
});

// Accepting, on the screen. It is the only control here that changes what other
// people receive rather than what this computer stores, so it is off by
// default, it says what it costs where the decision is made, and it shows the
// wording it will send rather than describing it.
describe('the accept control', () => {
  const on = { ...settings, accept: true };
  const model = (over = {}) =>
    homeModel({ jobs: [job()], settingFor: () => setting({ selected: true }), settings, ...over });

  it('is off unless it has been turned on', () => {
    expect(model().accept).toBe(false);
    const html = renderHome(model());
    expect(html).toContain(`id="${HOME_IDS.accept}" type="checkbox"  />`);
    expect(html).not.toContain(`id="${HOME_IDS.acceptMessage}"`);
    expect(renderHome(model({ settings: on }))).toContain(
      `id="${HOME_IDS.accept}" type="checkbox" checked />`,
    );
  });

  it('opens the wording, and the wording is the operator\u2019s own', () => {
    const html = renderHome(model({ settings: on }));
    expect(html).toContain(`id="${HOME_IDS.acceptMessage}"`);
    expect(html).toContain('Thanks so much for applying for the [role_name] role');
  });

  it('states what accepting costs beside the box, not only on the confirm screen', () => {
    const html = renderHome(model({ settings: on }));
    expect(html).toContain('cannot be undone');
    expect(html).toContain('never fetch or re-download them again');
  });

  // The rule about tokens, shown rather than explained: the example is composed
  // with a real role name, because that is what [role_name] is filled from.
  it('shows the composed result for an example on a real role', () => {
    const html = renderHome(model({ settings: on }));
    expect(html).toContain('Hey Priya,');
    expect(html).toContain('applying for the Platform Engineer role');
    expect(html).toContain('No first name on');
  });

  it('composes the edited wording, not the default', () => {
    const html = renderHome(
      model({ settings: { ...on, acceptMessage: 'Hi [first_name], about [role_name].' } }),
    );
    expect(html).toContain('Hi Priya, about Platform Engineer.');
  });

  // A template with a token this grammar does not know would abort the run once
  // per candidate. Saying so under the box is where it can still be fixed.
  it('says so under the box when the wording could never be sent', () => {
    const html = renderHome(model({ settings: { ...on, acceptMessage: 'Hey [frist_name],' } }));
    expect(html).toContain('unresolved token');
  });

  // The button carries no number while accepting: `asked` counts downloads, and
  // an accept-only run accepts the people already on disk and downloads nobody.
  // Promising a figure this screen cannot stand behind is the bug it has had
  // twice already, in the other direction.
  it('sends the count to the confirm screen rather than onto the button', () => {
    expect(model({ settings: on }).startLabel).toBe('Review who will be accepted');
    expect(startLabel([], { accept: true })).toBe('Select a role');
    expect(startLabel([3])).toBe('Download 3 resumes');
  });
});

// The counts drop after an accept run, possibly to zero, because accepting
// drains the review queue. Naming what left is what stops that reading as the
// extension having lost the applicants.
describe('a role this extension has accepted people from', () => {
  it('names them beside the queue count', () => {
    expect(jobSubtitle(job({ accepted: 40 }))).toBe('4 applicants \u00b7 3 new \u00b7 40 accepted');
    expect(jobSubtitle(job({ estimatedNew: 0, accepted: 40 }))).toBe(
      '4 applicants \u00b7 all downloaded \u00b7 40 accepted',
    );
  });

  it('says nothing when this extension has accepted nobody', () => {
    expect(jobSubtitle(job())).toBe('4 applicants \u00b7 3 new');
    expect(jobSubtitle(job({ accepted: 0 }))).toBe('4 applicants \u00b7 3 new');
  });
});
