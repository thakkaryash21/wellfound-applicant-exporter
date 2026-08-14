import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeDom } from './helpers/fake-dom.js';
import { renderLibrary, describeRefetch } from '../src/panel/library.js';

// What the Library screen says back after an action. Three sites used to write
// their own message by hand and only one of them replaced the previous one, so
// tapping a failing action three times left three copies on screen.

const JOB = '9100001';

let dom;
let screen;

const row = (over = {}) => ({
  jobId: JOB,
  jobTitle: 'Platform Engineer',
  resumesAvailable: 3,
  lastRunAt: null,
  missing: 0,
  unreachable: 0,
  unsettled: 0,
  unverifiable: 0,
  orphans: 0,
  ...over,
});

function stubController(over = {}) {
  return {
    library: vi.fn(async () => [row()]),
    redownloadMissing: vi.fn(async () => ({ refetched: 1, stillMissing: 0 })),
    adoptOrphans: vi.fn(async () => ({ adopted: 2 })),
    importCsv: vi.fn(async () => ({ imported: 5 })),
    forget: vi.fn(async () => {}),
    abort: vi.fn(),
    ...over,
  };
}

async function show(controller) {
  await renderLibrary(screen, { controller, onBack: () => {} });
}

const click = (selector) => screen.querySelector(selector).click();
const messages = (className) => screen.querySelectorAll(`.${className}`);

beforeEach(() => {
  dom = installFakeDom();
  screen = dom.mountPanel();
});

afterEach(() => {
  dom.restore();
});

describe('the Library screen', () => {
  it('lists a job with what the ledger knows about it', async () => {
    await show(stubController());
    expect(screen.innerHTML).toContain('Platform Engineer');
    expect(screen.innerHTML).toContain('resumes available');
    expect(screen.innerHTML).toContain('<span class="num">3</span>');
    expect(screen.innerHTML).not.toContain('accepted');
  });

  it('says so when there is nothing in the ledger yet', async () => {
    await show(stubController({ library: vi.fn(async () => []) }));
    expect(screen.innerHTML).toContain('Nothing downloaded yet');
  });
});

describe('a failing action', () => {
  const failing = () =>
    stubController({
      library: vi.fn(async () => [row({ missing: 2 })]),
      redownloadMissing: vi.fn(async () => {
        throw new Error('Open Wellfound to get started');
      }),
    });

  it('reports the failure under the row', async () => {
    await show(failing());
    await click('[data-act="refetch"]');
    expect(messages('lib-error')).toHaveLength(1);
    expect(screen.innerHTML).toContain('Open Wellfound to get started');
  });

  it('replaces its message rather than stacking a second one', async () => {
    await show(failing());
    await click('[data-act="refetch"]');
    await click('[data-act="refetch"]');
    await click('[data-act="refetch"]');
    expect(messages('lib-error')).toHaveLength(1);
  });
});

describe('an action that worked', () => {
  it('says what an import did', async () => {
    const controller = stubController();
    await show(controller);
    // The panel makes the file input itself, so the test has to catch it on its
    // way out of createElement in order to hand it a file.
    const made = [];
    const create = document.createElement.bind(document);
    document.createElement = (tag) => {
      const element = create(tag);
      made.push(element);
      return element;
    };
    await click('[data-act="import"]');
    const input = made.find((el) => el.tag === 'input');
    input.files = [{ text: async () => 'User ID,Resume\r\n1,downloaded\r\n' }];
    await input.dispatch('change');
    expect(controller.importCsv).toHaveBeenCalledWith(JOB, 'User ID,Resume\r\n1,downloaded\r\n');
    expect(screen.innerHTML).toContain('Imported 5 people.');
    expect(messages('lib-note')).toHaveLength(1);
  });
});

// The delivery ledger still prevents an unsafe recovery attempt, but the
// Library does not expose an accepted count.
describe('a historical capture outside Review', () => {
  const withAccepts = (over) => stubController({ library: vi.fn(async () => [row(over)]) });

  it('is not counted among the files missing from disk', async () => {
    await show(withAccepts({ missing: 0, unreachable: 2 }));
    expect(screen.innerHTML).not.toContain('missing from disk');
    expect(screen.innerHTML).toContain('some historical captures are no longer in Review');
    expect(screen.innerHTML).not.toContain('accepted');
  });

  it('is not offered a Re-download button, because no walk can find them', async () => {
    await show(withAccepts({ missing: 0, unreachable: 2 }));
    expect(screen.querySelector('[data-act="refetch"]')).toBe(null);
  });

  it('leaves the button standing for the people a walk can still fetch', async () => {
    await show(withAccepts({ missing: 3, unreachable: 2 }));
    expect(screen.querySelector('[data-act="refetch"]')).not.toBe(null);
    expect(screen.innerHTML).toContain('missing from disk');
    expect(screen.innerHTML).toContain('cannot be recovered');
  });

  it('does not let a row of accepts read as all files present', async () => {
    await show(withAccepts({ unreachable: 2 }));
    expect(screen.innerHTML).not.toContain('all files present');
  });

  it('is reported as unfetchable, not as missing', () => {
    expect(describeRefetch({ refetched: 0, stillMissing: 0, acceptedGone: 2 })).toBe(
      'Nothing to re-download: 2 are no longer in Review and cannot be fetched',
    );
  });

  it('is named alongside the people the walk did fetch', () => {
    expect(describeRefetch({ refetched: 3, stillMissing: 1, acceptedGone: 1 })).toBe(
      'Re-downloaded 3, 1 still missing, 1 is no longer in Review and cannot be fetched',
    );
  });

  it('says nothing at all when nobody was accepted', () => {
    expect(describeRefetch({ refetched: 3, stillMissing: 0 })).toBe('Re-downloaded 3');
  });
});

// The state between the two answers. A provisional entry says a send was
// armed and nobody could vouch for it. Reporting that person as accepted
// would book an irreversible outcome the run never established, and reporting
// them as missing would promise a walk that cannot be promised.
describe('someone whose accept nobody could confirm', () => {
  const withUnsettled = (over) => stubController({ library: vi.fn(async () => [row(over)]) });

  it('is not spoken of as accepted, because nobody knows that yet', async () => {
    await show(withUnsettled({ missing: 0, unsettled: 2 }));
    expect(screen.innerHTML).not.toContain('were accepted');
    expect(screen.innerHTML).not.toContain('can no longer be fetched');
    expect(screen.innerHTML).toContain('acceptance outcome still needs reconciliation');
  });

  it('is not counted among the files missing from disk', async () => {
    await show(withUnsettled({ missing: 0, unsettled: 2 }));
    expect(screen.innerHTML).not.toContain('missing from disk');
  });

  it('is not offered a Re-download button on their own account', async () => {
    await show(withUnsettled({ missing: 0, unsettled: 2 }));
    expect(screen.querySelector('[data-act="refetch"]')).toBe(null);
  });

  it('leaves the button standing for the people a walk can still fetch', async () => {
    await show(withUnsettled({ missing: 3, unsettled: 2 }));
    expect(screen.querySelector('[data-act="refetch"]')).not.toBe(null);
    expect(screen.innerHTML).toContain('missing from disk');
  });

  it('does not let a row of unsettled sends read as all files present', async () => {
    await show(withUnsettled({ unsettled: 2 }));
    expect(screen.innerHTML).not.toContain('all files present');
  });
});
