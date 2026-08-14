import { escapeHtml } from './escape-html.js';
import { DEFAULT_MESSAGE } from '../lib/accept-message.js';
import { SAMPLE_FIRST_NAME, messagePreview } from './home-view.js';

// The screen between pressing Start and the first message going out.
//
// Every other screen in this panel reports something that already happened.
// This one is the last point at which nothing has, and it exists because the
// thing on the other side of it cannot be taken back: a few hundred people
// receive a message under the operator's name, and each of them leaves the only
// collection this extension can query, so their resume can never be fetched
// again. So it states the count, the wording, the refusals and the cost, and
// then gets out of the way. It is not a scare screen: the operator asked for
// this feature and knows what accepting is. It is a place to read the number
// back before it becomes real.
//
// Markup and arithmetic only, like home-view.js. panel.js owns the state and
// hangs the listeners.

export const CONFIRM_IDS = {
  title: 'confirm-title',
  back: 'confirm-back',
  send: 'confirm-send',
};

// What one role contributes, in people.
//
// The exact figure is not knowable from this screen for every mode, and saying
// so is cheaper than a number that turns out wrong:
//
// - Accept-only uses `readyToAccept`, which is derived from a complete Review
//   identity snapshot and positively available files. Historical totals are
//   never subtracted from one another.
// - Download-and-accept can only show a ceiling before the walk because a
//   download may fail. The run recomputes eligibility from fresh evidence
//   immediately before pass 2.
//
// The role's limit caps the last step in every mode, because that is what it
// means to the pass that does the messaging: at most N people are messaged from
// this role. This screen is where that number has to be visible - an operator
// who approves "3" must not get 115 - so the cap is applied to the figure
// shown, not to the pool it is drawn from. Refusals are counted before it, and
// stay whole: someone refused for want of a resume was never going to be
// messaged, so they do not spend the number and the screen must not imply they
// did.
export function acceptRow(job, setting, { download = true } = {}) {
  const inQueue = job.actionableCount ?? null;
  const base = { jobId: job.jobId, title: job.title, inQueue };
  // "Everyone" is genuinely everyone, so it caps nothing at all.
  const cap = (people) => (setting.mode === 'all' ? people : Math.min(people, setting.limit));
  if (!download) {
    const exact = job.trackingExact === true && !job.migrationIncomplete;
    if (!exact || job.readyToAccept == null || inQueue == null) {
      return { ...base, people: null, bound: false, refused: 0 };
    }
    const eligible = Math.min(job.readyToAccept, inQueue);
    const unavailable =
      (job.newCount ?? 0) + (job.needsRecovery ?? 0) + (job.unidentified ?? 0);
    return { ...base, people: cap(eligible), bound: false, refused: unavailable };
  }
  if (inQueue == null) return { ...base, people: null, bound: true, refused: 0 };
  // A successful download makes its candidate eligible in the same run, but a
  // failure does not. Before that evidence exists, the queue is only a ceiling.
  return { ...base, people: cap(inQueue), bound: true, refused: 0 };
}

export function roleLine(row) {
  if (row.people == null) return `${row.title}: counted during the candidate check`;
  const people = `${row.people} ${row.people === 1 ? 'person' : 'people'}`;
  const refused = row.refused ? `, ${row.refused} without an available resume` : '';
  return `${row.title}: ${row.bound ? 'up to ' : ''}${people}${refused}`;
}

// The whole screen as plain data, so every number on it is a value a test can
// read rather than a string it has to parse back out of markup.
export function confirmModel({
  jobs = [],
  settingFor,
  download = true,
  message = DEFAULT_MESSAGE,
} = {}) {
  const rows = jobs.map((job) => acceptRow(job, settingFor(job.jobId), { download }));
  const counted = rows.filter((row) => row.people != null);
  const total = counted.reduce((sum, row) => sum + row.people, 0);
  const refused = rows.reduce((sum, row) => sum + row.refused, 0);
  const inQueue = counted.reduce((sum, row) => sum + row.inQueue, 0);
  const role = rows[0]?.title ?? '';
  return {
    rows,
    total,
    refused,
    inQueue,
    // A role whose count never loaded makes the total a floor rather than a
    // sum, and the screen has to say which it is.
    uncounted: rows.length - counted.length,
    bound: rows.some((row) => row.bound),
    download,
    message,
    preview: messagePreview({ template: message, roleName: role }),
    previewRole: role,
  };
}

export function headline(model) {
  if (model.uncounted) return 'Accept after candidate check';
  const people = `${model.total} ${model.total === 1 ? 'person' : 'people'}`;
  const lead = model.bound ? 'Accept up to ' : 'Accept ';
  return `${lead}${people}`;
}

// Where the number came from, in the order the run gets there. The operator
// runs this repeatedly over the same roles, so the figure changes between runs
// for reasons no single total can explain: people were messaged last time and
// have left the queue, people applied since and have no resume yet. Each of
// those is its own line rather than an adjustment folded into one number.
export function derivation(model) {
  const lines = [];
  lines.push(`${model.inQueue} in the review queue`);
  lines.push(
    `${model.bound || model.uncounted ? 'up to ' : ''}${model.total} will be messaged`,
  );
  if (model.refused) {
    lines.push(
      `${model.refused} will not be messaged because no resume is currently available`,
    );
  }
  return lines;
}

// Back is the filled button and it comes first, so the deliberate action is the
// one that is neither the default focus nor the easy one to hit. The send
// button names its own count: a button that says what it is about to do is
// worth more here than one that says "Confirm".
export function renderConfirm(model) {
  const downloadRefusal = model.download
    ? `<p class="job-meta">Anyone whose resume cannot be downloaded is refused for the
         same reason.</p>`
    : '';
  const uncounted = model.uncounted
    ? `<p class="job-meta warn">${model.uncounted}
         ${model.uncounted === 1 ? 'role will be' : 'roles will be'} counted during the run.
         No message is sent until its complete candidate check establishes an eligible list.</p>`
    : '';

  return `
    <section class="confirm" aria-labelledby="${CONFIRM_IDS.title}">
      <h2 class="post-run-title" id="${CONFIRM_IDS.title}">${escapeHtml(headline(model))}</h2>
      <div class="confirm-body">
        <p>Each one gets your message under your Wellfound account. It cannot be unsent.</p>
        <p>After it starts, the extension opens each response, visibly types and verifies the
           message, then clicks Accept application &amp; send message.</p>
        <p>Accepting also removes them from the review queue for good. After this run
           this extension can never fetch or re-download an accepted applicant, so the
           CSV and the resume on disk are the only copies left.</p>
        <ul class="confirm-roles">
          ${model.rows.map((row) => `<li>${escapeHtml(roleLine(row))}</li>`).join('')}
        </ul>
        <ul class="confirm-sum">
          ${derivation(model).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}
        </ul>
        ${uncounted}
        ${downloadRefusal}
        <p class="label">The message, as it will be sent</p>
        <pre class="accept-preview">${escapeHtml(model.message)}</pre>
        <p class="job-meta">Filled in per person. For
           ${escapeHtml(SAMPLE_FIRST_NAME)} on ${escapeHtml(model.previewRole)}:</p>
        <pre class="accept-preview">${escapeHtml(model.preview)}</pre>
      </div>
      <div class="post-run-actions">
        <button class="primary" id="${CONFIRM_IDS.back}" type="button">Go back</button>
        <button class="secondary danger-action" id="${CONFIRM_IDS.send}" type="button">
          ${escapeHtml(model.uncounted ? 'Start checked acceptance' : `Accept and message ${model.total}`)}
        </button>
      </div>
    </section>`;
}
