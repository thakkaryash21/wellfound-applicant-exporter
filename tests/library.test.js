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
  downloaded: 3,
  known: 3,
  lastRunAt: null,
  missing: 0,
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
  it('says what an adoption did, once however often it is tapped', async () => {
    const controller = stubController({ library: vi.fn(async () => [row({ orphans: 2 })]) });
    await show(controller);
    await click('[data-act="adopt"]');
    expect(screen.innerHTML).toContain('Adopted 2 files.');
    expect(messages('lib-note')).toHaveLength(1);
    await click('[data-act="adopt"]');
    expect(messages('lib-note')).toHaveLength(1);
  });

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

// The one outcome a re-download has no remedy for. An accepted candidate has
// left the only collection this extension can query, so "still missing" would
// send the user looking for a button that cannot exist.
describe('someone who was accepted', () => {
  it('is reported as unfetchable, not as missing', () => {
    expect(describeRefetch({ refetched: 0, stillMissing: 0, acceptedGone: 2 })).toBe(
      'Nothing to re-download: 2 were accepted and can no longer be fetched',
    );
  });

  it('is named alongside the people the walk did fetch', () => {
    expect(describeRefetch({ refetched: 3, stillMissing: 1, acceptedGone: 1 })).toBe(
      'Re-downloaded 3, 1 still missing, 1 was accepted and can no longer be fetched',
    );
  });

  it('says nothing at all when nobody was accepted', () => {
    expect(describeRefetch({ refetched: 3, stillMissing: 0 })).toBe('Re-downloaded 3');
  });
});
