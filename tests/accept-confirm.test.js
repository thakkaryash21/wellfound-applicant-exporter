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

const job = (over = {}) => ({
  jobId: '9100001',
  title: 'Platform Engineer',
  actionableCount: 116,
  trackingExact: true,
  readyToAccept: 40,
  newCount: 56,
  needsRecovery: 20,
  unidentified: 0,
  ...over,
});

const setting = (over = {}) => ({ selected: true, mode: 'all', limit: 25, ...over });
const settingFor = (over) => () => setting(over);

describe('what one role contributes', () => {
  it('uses the identity-derived ready set for accept-only', () => {
    expect(acceptRow(job(), setting(), { download: false })).toMatchObject({
      people: 40,
      bound: false,
      refused: 76,
    });
  });

  it('applies the role limit after eligibility', () => {
    expect(acceptRow(job(), setting({ mode: 'limit', limit: 3 }), { download: false })).toMatchObject(
      { people: 3, refused: 76 },
    );
  });

  it('does not derive accept-only targets from historical known or accepted totals', () => {
    const row = acceptRow(
      job({ trackingExact: false, readyToAccept: null, known: 312, accepted: 40 }),
      setting(),
      { download: false },
    );
    expect(row.people).toBe(null);
    expect(row).not.toHaveProperty('alreadyAccepted');
  });

  it('fails closed while migration is incomplete', () => {
    expect(
      acceptRow(job({ migrationIncomplete: true }), setting(), { download: false }).people,
    ).toBe(null);
  });

  it('shows a ceiling for a download-and-accept run because downloads can fail', () => {
    expect(acceptRow(job(), setting(), { download: true })).toMatchObject({
      people: 116,
      bound: true,
      refused: 0,
    });
    expect(
      acceptRow(job(), setting({ mode: 'limit', limit: 25 }), { download: true }),
    ).toMatchObject({ people: 25, bound: true });
  });

  it('never claims a number when the page supplied no queue count', () => {
    const row = acceptRow(job({ actionableCount: null }), setting(), { download: true });
    expect(row.people).toBe(null);
    expect(roleLine(row)).toContain('counted during the candidate check');
  });
});

describe('the line each role gets', () => {
  it('counts eligible people and unavailable resumes separately', () => {
    expect(roleLine(acceptRow(job(), setting(), { download: false }))).toBe(
      'Platform Engineer: 40 people, 76 without an available resume',
    );
  });

  it('says up to for a bound', () => {
    expect(roleLine(acceptRow(job(), setting({ mode: 'limit', limit: 25 }), { download: true }))).toBe(
      'Platform Engineer: up to 25 people',
    );
  });
});

describe('the whole screen', () => {
  const model = (over = {}) =>
    confirmModel({
      jobs: [
        job(),
        job({
          jobId: '9100002',
          title: 'Data Analyst',
          actionableCount: 20,
          readyToAccept: 5,
          newCount: 10,
          needsRecovery: 5,
        }),
      ],
      settingFor: settingFor(),
      download: false,
      message: DEFAULT_MESSAGE,
      ...over,
    });

  it('adds only identity-derived eligible sets', () => {
    expect(model()).toMatchObject({ total: 45, refused: 91, uncounted: 0 });
    expect(headline(model())).toBe('Accept 45 people');
  });

  it('does not present a misleading partial total when a role needs a fresh scan', () => {
    const unknown = model({
      jobs: [job(), job({ jobId: '2', trackingExact: false, readyToAccept: null })],
    });
    expect(unknown.uncounted).toBe(1);
    expect(headline(unknown)).toBe('Accept after candidate check');
    expect(renderConfirm(unknown)).toContain('counted during the run');
    expect(renderConfirm(unknown)).toContain('Start checked acceptance');
  });

  it('states the irreversible action and exact message without showing accepted history', () => {
    const html = renderConfirm(model());
    expect(html).toContain('Platform Engineer: 40 people, 76 without an available resume');
    expect(html).toContain('cannot be unsent');
    expect(html).toContain('removes them from the review queue for good');
    expect(html).toContain('Thanks so much for applying for the');
    expect(html).toContain(SAMPLE_FIRST_NAME);
    expect(html).toContain('Platform Engineer role');
    expect(html).not.toContain('accepted by this extension on an earlier run');
  });

  it('puts Go back first and names the checked action', () => {
    const html = renderConfirm(model());
    expect(html.indexOf(CONFIRM_IDS.back)).toBeLessThan(html.indexOf(CONFIRM_IDS.send));
    expect(html).toContain('class="primary" id="confirm-back"');
    expect(html).toContain('Accept and message 45');
    expect(html).toContain('clicks Accept application &amp; send message');
  });

  it('derives only from the current Review and current availability', () => {
    expect(derivation(model())).toEqual([
      '136 in the review queue',
      '45 will be messaged',
      '91 will not be messaged because no resume is currently available',
    ]);
  });
});
