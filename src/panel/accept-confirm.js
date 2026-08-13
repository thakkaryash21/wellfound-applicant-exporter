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
// - Accept-only walks the queue, downloads nobody, and can therefore only
//   accept the people already in the library. Everyone else in the queue is
//   refused, and both halves are exact.
// - Downloading everything captures the whole queue, so the whole queue is
//   accepted. Nobody is refused up front; only a download that fails is, and
//   this screen cannot know how many of those there will be.
// - Downloading the first N stops the walk once N new files have landed, so the
//   people it reaches are bounded rather than counted. `bound` says the number
//   is a ceiling and the screen says "up to".
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
  const already = job.accepted ?? 0;
  // The library holds everyone this extension has fetched, and it keeps holding
  // the ones it has since accepted - the download ledger has no reason to
  // forget them. The review queue does not: accepting removes a candidate from
  // it. So the people who are both on disk and still acceptable are the library
  // minus the ones already messaged, and using `known` on its own counts that
  // difference twice on the second run over a role.
  const haveResume = Math.max(0, (job.known ?? 0) - already);
  const base = { jobId: job.jobId, title: job.title, alreadyAccepted: already, inQueue };
  // "Everyone" is genuinely everyone, so it caps nothing at all.
  const cap = (people) => (setting.mode === 'all' ? people : Math.min(people, setting.limit));
  if (inQueue == null) {
    return { ...base, people: null, bound: false, refused: 0 };
  }
  if (!download) {
    // Eligible first, refusals from that, and only then the cap. Capping first
    // would report a refusal for everyone the limit held back, and they were
    // not refused - the run simply stopped once it had messaged its number.
    const eligible = Math.min(haveResume, inQueue);
    return { ...base, people: cap(eligible), bound: false, refused: inQueue - eligible };
  }
  if (setting.mode === 'all') {
    return { ...base, people: inQueue, bound: false, refused: 0 };
  }
  // The limited download-and-accept run. The pool it could message is the whole
  // queue - the walk is forced full, so the people already on disk are
  // acceptable too - and the limit is what actually decides the figure. Still a
  // ceiling rather than a count: a download that fails takes its candidate out
  // of reach, and this screen cannot know how many of those there will be.
  return { ...base, people: cap(inQueue), bound: true, refused: 0 };
}

export function roleLine(row) {
  if (row.people == null) return `${row.title}: not counted yet`;
  const people = `${row.people} ${row.people === 1 ? 'person' : 'people'}`;
  const refused = row.refused ? `, ${row.refused} refused` : '';
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
  const alreadyAccepted = rows.reduce((sum, row) => sum + row.alreadyAccepted, 0);
  const inQueue = counted.reduce((sum, row) => sum + row.inQueue, 0);
  const role = rows[0]?.title ?? '';
  return {
    rows,
    total,
    refused,
    alreadyAccepted,
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
  const people = `${model.total} ${model.total === 1 ? 'person' : 'people'}`;
  const lead = model.bound || model.uncounted ? 'Accept up to ' : 'Accept ';
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
    lines.push(`${model.refused} refused: no resume was captured for them`);
  }
  if (model.alreadyAccepted) {
    // Not subtracted from the queue on screen, because they were never in it:
    // accepting removed them. It is here to explain a figure that has shrunk
    // since the last run, and it is what this extension did, not who has been
    // accepted - anyone accepted by hand in Wellfound is in neither list.
    lines.push(
      `${model.alreadyAccepted} accepted by this extension on an earlier run, ` +
        'so they have already left the queue',
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
         ${model.uncounted === 1 ? 'role has' : 'roles have'} no applicant count yet,
         so the total above is a floor.</p>`
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
          ${escapeHtml(`Accept and message ${model.total}`)}
        </button>
      </div>
    </section>`;
}
