import { describe, it, expect } from 'vitest';
import { DEFAULT_MESSAGE } from '../src/lib/accept-message.js';
import { SAMPLE_FIRST_NAME } from '../src/panel/home-view.js';
import {
  CONFIRM_IDS,
  acceptRow,
  roleLine,
  confirmModel,
  headline,
  renderConfirm,
  derivation,
} from '../src/panel/accept-confirm.js';

// The last screen before a few hundred real people are messaged. Every number
// on it is a value here rather than a string parsed back out of markup, for the
// same reason home-view's arithmetic is: a count that reads better than the
// truth is the one failure this screen cannot have.

const job = (over = {}) => ({
  jobId: '9100001',
  title: 'Platform Engineer',
  actionableCount: 116,
  known: 40,
  ...over,
});

const setting = (over = {}) => ({ selected: true, mode: 'all', limit: 25, ...over });
const settingFor = (over) => () => setting(over);

describe('what one role contributes', () => {
  // Downloading everything captures the whole queue, so the whole queue can be
  // accepted and nobody is refused up front.
  it('is the whole queue when the run downloads all of it', () => {
    expect(acceptRow(job(), setting(), { download: true })).toMatchObject({
      people: 116,
      bound: false,
      refused: 0,
    });
  });

  // Accept-only downloads nobody, so it can only accept the people already on
  // disk. Everyone else in the queue is refused, and both halves are exact.
  it('is only the people already downloaded when the run downloads nothing', () => {
    expect(acceptRow(job(), setting(), { download: false })).toMatchObject({
      people: 40,
      refused: 76,
    });
  });

  // A limit stops the walk once N new files land, so the people it reaches are
  // a ceiling rather than a count, and the screen has to say which it is.
  it('is a ceiling, not a count, when the run is limited', () => {
    expect(acceptRow(job(), setting({ mode: 'limit', limit: 25 }), { download: true })).toMatchObject(
      { people: 65, bound: true },
    );
  });

  it('never claims more than the queue holds', () => {
    const small = job({ actionableCount: 10, known: 9 });
    expect(acceptRow(small, setting({ mode: 'limit', limit: 25 }), { download: true }).people).toBe(
      10,
    );
    expect(acceptRow(small, setting(), { download: false })).toMatchObject({
      people: 9,
      refused: 1,
    });
  });

  // Null is not zero. A role whose count never loaded is uncounted, and the
  // screen says so rather than quietly leaving it out of the total.
  it('is unknown when the page never gave a count', () => {
    expect(acceptRow(job({ actionableCount: null }), setting(), {}).people).toBe(null);
    expect(roleLine(acceptRow(job({ actionableCount: null }), setting(), {}))).toContain(
      'not counted yet',
    );
  });
});

describe('the line each role gets', () => {
  it('counts people, and names the refusals beside them', () => {
    expect(roleLine(acceptRow(job(), setting(), { download: false }))).toBe(
      'Platform Engineer: 40 people, 76 refused',
    );
  });

  it('says "up to" for a bound rather than a count', () => {
    expect(roleLine(acceptRow(job(), setting({ mode: 'limit', limit: 25 }), { download: true }))).toBe(
      'Platform Engineer: up to 65 people',
    );
  });

  it('says person, not people, for one', () => {
    expect(roleLine(acceptRow(job({ actionableCount: 1, known: 1 }), setting(), {}))).toBe(
      'Platform Engineer: 1 person',
    );
  });
});

describe('the whole screen', () => {
  const model = (over = {}) =>
    confirmModel({
      jobs: [job(), job({ jobId: '9100002', title: 'Data Analyst', actionableCount: 20, known: 5 })],
      settingFor: settingFor(),
      download: false,
      message: DEFAULT_MESSAGE,
      ...over,
    });

  it('adds the roles up, and adds the refusals up separately', () => {
    expect(model()).toMatchObject({ total: 45, refused: 91, uncounted: 0 });
  });

  it('says up to when any role is a bound, and plainly when none is', () => {
    expect(headline(model())).toBe('Accept 45 people');
    expect(
      headline(model({ download: true, settingFor: settingFor({ mode: 'limit', limit: 5 }) })),
    ).toBe('Accept up to 55 people');
  });

  // A role with no count makes the sum a floor, and a screen that presented it
  // as a total would understate what is about to happen.
  it('calls the total a floor when a role could not be counted', () => {
    const uncounted = model({ jobs: [job(), job({ jobId: '2', actionableCount: null })] });
    expect(uncounted.uncounted).toBe(1);
    expect(headline(uncounted)).toContain('up to');
    expect(renderConfirm(uncounted)).toContain('a floor');
  });

  it('states every fact the operator has to decide on', () => {
    const html = renderConfirm(model());
    expect(html).toContain('Platform Engineer: 40 people, 76 refused');
    expect(html).toContain('Data Analyst: 5 people, 15 refused');
    expect(html).toContain('cannot be unsent');
    expect(html).toContain('removes them from the review queue for good');
    expect(html).toContain('no resume was captured');
    // The exact wording, and one worked example of it.
    expect(html).toContain('Thanks so much for applying for the');
    expect(html).toContain(SAMPLE_FIRST_NAME);
    expect(html).toContain('Platform Engineer role');
  });

  // A download run refuses nobody up front, but it still refuses anyone whose
  // resume will not come down, and that has to be said where the decision is.
  it('names the download refusal only when the run downloads', () => {
    expect(renderConfirm(model({ download: true }))).toContain('cannot be downloaded is refused');
    expect(renderConfirm(model())).not.toContain('cannot be downloaded is refused');
  });

  // Back is the filled button and comes first. The send is the deliberate one:
  // outlined, second in the DOM, and it names its own count.
  it('puts Go back first and makes the send name what it sends', () => {
    const html = renderConfirm(model());
    expect(html.indexOf(CONFIRM_IDS.back)).toBeLessThan(html.indexOf(CONFIRM_IDS.send));
    expect(html).toContain('class="primary" id="confirm-back"');
    expect(html).toContain('Accept and send 45 messages');
    expect(html).toContain('Go back');
  });
});

// The operator's actual workflow: the same roles, accepted retroactively, over
// and over. From the second run on, the library holds people who have already
// been messaged and have therefore left the review queue - so counting the
// library as if all of it were still acceptable counts them twice.
describe('a role that has been accepted before', () => {
  // 312 downloaded, 40 of them messaged last run, and 100 people have applied
  // since. The queue holds the 272 unaccepted ones plus the 100 new.
  const second = job({ actionableCount: 372, known: 312, accepted: 40 });

  it('counts only the people who are both on disk and still in the queue', () => {
    expect(acceptRow(second, setting(), { download: false })).toMatchObject({
      people: 272,
      refused: 100,
      alreadyAccepted: 40,
    });
  });

  it('leaves the number alone on the first run over a role', () => {
    expect(acceptRow(job({ accepted: 0 }), setting(), { download: false })).toMatchObject({
      people: 40,
      refused: 76,
    });
  });

  it('subtracts them from a limited walk for the same reason', () => {
    expect(
      acceptRow(second, setting({ mode: 'limit', limit: 25 }), { download: true }).people,
    ).toBe(297);
  });

  it('never goes below zero when the library is all accepted', () => {
    expect(
      acceptRow(job({ actionableCount: 5, known: 40, accepted: 40 }), setting(), {
        download: false,
      }),
    ).toMatchObject({ people: 0, refused: 5 });
  });

  // The working, in the order the run gets there. The figure changes between
  // runs for reasons no single total can explain, so each is its own line.
  it('shows where the figure came from', () => {
    const model = confirmModel({
      jobs: [second],
      settingFor: () => setting(),
      download: false,
      message: DEFAULT_MESSAGE,
    });
    expect(model).toMatchObject({ inQueue: 372, total: 272, refused: 100, alreadyAccepted: 40 });
    expect(derivation(model)).toEqual([
      '372 in the review queue',
      '272 will be messaged',
      '100 refused: no resume was captured for them',
      '40 accepted by this extension on an earlier run, so they have already left the queue',
    ]);
  });

  // It is knowledge of what this extension did, not of who has been accepted.
  // Anyone the operator accepted by hand in Wellfound is in neither list.
  it('claims only what this extension did', () => {
    const html = renderConfirm(
      confirmModel({ jobs: [second], settingFor: () => setting(), download: false }),
    );
    expect(html).toContain('40 accepted by this extension on an earlier run');
    expect(html).toContain('272 will be messaged');
  });

  it('says nothing about earlier runs when there were none', () => {
    const model = confirmModel({ jobs: [job()], settingFor: () => setting(), download: false });
    expect(derivation(model)).not.toContain(expect.stringContaining('earlier run'));
    expect(renderConfirm(model)).not.toContain('earlier run');
  });

  // The hedges survive the more accurate input. This makes one number better,
  // it does not make the figure exact.
  it('keeps saying up to where the run is bounded', () => {
    const model = confirmModel({
      jobs: [second],
      settingFor: () => setting({ mode: 'limit', limit: 25 }),
      download: true,
    });
    expect(derivation(model)[1]).toBe('up to 297 will be messaged');
  });
});
