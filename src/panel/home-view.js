import { escapeHtml } from './escape-html.js';
import { DEFAULT_MESSAGE, composeMessage } from '../lib/accept-message.js';

// The Home screen: the roles, what each one will fetch, the run-wide settings
// and the Start button.
//
// It is here for the same reason running-view.js and post-run-view.js are, and
// the argument is symmetry and risk rather than size. The counting arithmetic
// that goes with Home - what the button promises against what the run will
// actually fetch - is the highest-risk logic in the panel: it produced the
// button-promises-N-fetches-M bug twice. As a model function it is assertable
// as data, rather than through a hand-transcribed fake DOM.
//
// Markup and arithmetic only. panel.js owns the state this is a view of, reads
// the controls back out of the document, and hangs the listeners.

// Every id this screen emits, so the wiring and the markup name them once.
export const HOME_IDS = {
  folder: 'folder',
  fast: 'fast',
  preview: 'preview',
  advanced: 'advanced',
  verbose: 'verbose',
  start: 'start',
  pick: (jobId) => `pick-${jobId}`,
  title: (jobId) => `title-${jobId}`,
  options: (jobId) => `opts-${jobId}`,
  modeAll: (jobId) => `mode-all-${jobId}`,
  modeLimit: (jobId) => `mode-limit-${jobId}`,
  limit: (jobId) => `limit-${jobId}`,
  reread: (jobId) => `reread-${jobId}`,
  reconnect: 'reconnect',
  accept: 'accept',
  acceptMessage: 'accept-message',
};

// The name the preview greets, so the operator reads a finished sentence rather
// than a rule about brackets. It is stated as an example on screen: inventing a
// real applicant's name here would be worse than owning that this one is made up.
export const SAMPLE_FIRST_NAME = 'Priya';

// The one remedy this screen can offer for itself. panel.js decides when it is
// warranted, from the marker on the error rather than from its words.
export const RECONNECT_LABEL = 'Reload the Wellfound tab';

// How many to get from one role, coerced once, where the number is captured.
//
// It used to be coerced twice by two different rules - the button did
// `Number(value) || DEFAULT` and the run did `Math.max(1, Number(value) ||
// DEFAULT)` - so typing -5 gave a button reading "Check for new applicants" and
// a run that downloaded one resume. `min="1"` on the input validates nothing
// outside a form, so the sanitising has to happen here, at the one place both
// readers get their number from.
// `limit` is how many candidates to take from one role. The GraphQL page size
// is `pageSize` and is a different number entirely; this constant was called
// DEFAULT_FIRST, which read like the page size and was not.
export const DEFAULT_LIMIT = 25;

export function sanitizeLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number(value);
  // Empty, blank and non-numeric all mean "the user has not said": take the
  // default rather than inventing a number from a typo.
  if (value === '' || value === null || value === undefined || !Number.isFinite(n)) {
    return fallback;
  }
  // A fraction is not a number of people, and anything under one is not a
  // request the run can honour.
  return Math.max(1, Math.floor(n));
}

// What the panel can honestly claim is waiting. `estimatedNew` already subtracts
// everyone the ledger knows; `actionableCount` is the fallback before a first
// run; null means the page has not told us yet, and null is not zero.
export function estimateFor(job) {
  return job.estimatedNew ?? job.actionableCount ?? null;
}

export function askedFor(job, setting) {
  const estimate = estimateFor(job);
  if (estimate == null) return null;
  if (setting.mode === 'all') return estimate;
  // `limit` is sanitised on capture, so both readers see the same number.
  return Math.min(setting.limit, estimate);
}

// One line under the title, in the user's terms: how many people are in the
// queue and how many of them this extension has not fetched yet.
export function jobSubtitle(job) {
  const total = job.actionableCount;
  if (total == null) return 'applicant count not loaded yet';
  const noun = total === 1 ? 'applicant' : 'applicants';
  if (job.estimatedNew === 0) return `${total} ${noun} \u00b7 all downloaded`;
  return `${total} ${noun} \u00b7 ${job.estimatedNew} new`;
}

// The button used to promise the whole backlog under a limit that would refuse
// most of it. A number on a button has to be the number it will actually fetch,
// and where the count is unknown it must show no number at all.
export function startLabel(asked, { accept = false } = {}) {
  if (asked.length === 0) return 'Select a role';
  // An accepting run carries no number here on purpose. `asked` counts the
  // people this run would download, and that is not the number it would accept:
  // an accept-only run accepts the ones already on disk and downloads nobody.
  // The confirm screen counts each role properly before anything is sent, so
  // the button says what pressing it opens rather than promising a figure this
  // screen cannot stand behind.
  if (accept) return 'Review who will be accepted';
  if (asked.some((n) => n == null)) return 'Download new resumes';
  const total = asked.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return 'Check for new applicants';
  return `Download ${total} ${total === 1 ? 'resume' : 'resumes'}`;
}

// The wording an accepting run will send, and one worked example of it. The
// operator edits a template; every candidate gets it with their own name in it,
// so a rendered example is the only honest way to show what that means.
//
// The role in the example is a real one - the first role picked for this run,
// or failing that the first on screen - because [role_name] is filled from the
// job the run walks. The first name is a stated example: there is no applicant
// on this screen to borrow one from.
export function messagePreview({ template = DEFAULT_MESSAGE, roleName = '' } = {}) {
  try {
    return composeMessage({ template, firstName: SAMPLE_FIRST_NAME, roleName });
  } catch (error) {
    // A template carrying a token this grammar does not know would abort the
    // run per candidate. Saying so here, under the box, is where it can still
    // be fixed.
    return String(error.message || error);
  }
}

// The denominator for the whole run, across every selected role, or null when
// any one of them cannot be counted.
export function runEstimate(asked) {
  if (asked.length === 0 || asked.some((n) => n == null)) return null;
  return asked.reduce((sum, n) => sum + n, 0);
}

// The whole screen as plain data. `settingFor(jobId)` is the panel's per-role
// state, asked for rather than reached for, so every judgement below is a
// function of its arguments.
export function homeModel({
  jobs = [],
  settingFor,
  expanded = null,
  settings,
  verbose = false,
  loadError = null,
  // The load failed in a way the panel can fix on the user's behalf. Passed as
  // a fact, not inferred from the message: a screen that read the sentence to
  // decide would break the moment the sentence was reworded.
  canReconnect = false,
  hydrating = false,
  hydrationNote = null,
} = {}) {
  // Nothing to run means nothing to configure. A settings form under a message
  // that says the run cannot happen is noise the user has to read past.
  if (hydrating || loadError || jobs.length === 0) {
    return {
      empty: true,
      message: loadError ?? 'Reading your jobs\u2026',
      // The hint is about roles that have not appeared. It has nothing to say
      // while a load is in flight or after one has failed with its own reason.
      hint: !(loadError || hydrating),
      // An error with a remedy shows the remedy instead of the generic hint.
      reconnect: Boolean(loadError) && canReconnect,
    };
  }

  const rows = jobs.map((job) => {
    const setting = settingFor(job.jobId);
    const estimate = estimateFor(job);
    return {
      jobId: job.jobId,
      title: job.title,
      subtitle: jobSubtitle(job),
      open: expanded === job.jobId,
      selected: setting.selected,
      mode: setting.mode,
      limit: setting.limit,
      rereadPages: setting.rereadPages,
      allLabel: estimate == null ? 'all new' : `all ${estimate} new`,
      asked: askedFor(job, setting),
    };
  });

  const chosen = rows.filter((row) => row.selected);
  const asked = chosen.map((row) => row.asked);
  const accept = Boolean(settings?.accept);
  const template = settings?.acceptMessage ?? DEFAULT_MESSAGE;
  const sampleRole = (chosen[0] ?? rows[0])?.title ?? '';

  return {
    empty: false,
    note: hydrationNote,
    rows,
    selectedCount: chosen.length,
    startLabel: startLabel(asked, { accept }),
    accept,
    acceptMessage: template,
    // Only composed when it is on screen. The example is what the box is for.
    acceptPreview: accept ? messagePreview({ template, roleName: sampleRole }) : '',
    acceptPreviewRole: sampleRole,
    // The same sum the Start button promises, so the running screen's
    // denominator and the button's number cannot disagree.
    estimate: runEstimate(asked),
    settings: { ...settings, verbose },
  };
}

// One arrow, drawn rather than typed. It used to be the character \u2304, which
// the panel's own font does not have: Chrome fell back to the last-resort
// missing-glyph box, which draws the code point's four hex digits in two stacked
// rows inside a rectangle. That is the "two arrows above and below each other,
// not centred" the owner saw. A path is in every font because it is in none.
const CHEVRON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M4 6.5 8 10.5 12 6.5" fill="none" stroke="currentColor" stroke-width="1.6"
                  stroke-linecap="round" stroke-linejoin="round" /></svg>`;

function renderJobRow(row) {
  const id = row.jobId;
  const title = escapeHtml(row.title);
  // The checkbox and the disclosure are siblings, not one inside the other: the
  // card's whole surface activates the disclosure (panel.js forwards the click),
  // and a checkbox nested inside that button would be a control inside a control.
  return `
    <div class="job-row${row.open ? ' is-open' : ''}">
      <div class="job-head">
        <input class="job-pick" type="checkbox" id="${HOME_IDS.pick(id)}" data-id="${id}"
               aria-label="Include ${title} in the run"
               ${row.selected ? 'checked' : ''} />
        <button class="job-open" type="button" data-id="${id}"
                aria-expanded="${row.open}" aria-controls="${HOME_IDS.options(id)}"
                aria-label="Settings for ${title}">
          <span class="job-open-text">
            <span class="job-title" id="${HOME_IDS.title(id)}">${title}</span>
            <span class="job-meta">${escapeHtml(row.subtitle)}</span>
          </span>
          <span class="chevron">${CHEVRON}</span>
        </button>
      </div>
      <div class="job-options" id="${HOME_IDS.options(id)}" role="group"
           aria-labelledby="${HOME_IDS.title(id)}" ${row.open ? '' : 'hidden'}>
        <fieldset class="job-get">
          <legend class="label">Get</legend>
          <label class="choice">
            <input type="radio" name="mode-${id}" id="${HOME_IDS.modeAll(id)}" value="all"
                   ${row.mode === 'all' ? 'checked' : ''} />
            ${escapeHtml(row.allLabel)}
          </label>
          <div class="choice-row">
            <label class="choice">
              <input type="radio" name="mode-${id}" id="${HOME_IDS.modeLimit(id)}" value="limit"
                     ${row.mode === 'limit' ? 'checked' : ''} />
              first
            </label>
            <input class="limit-n" type="number" inputmode="numeric" min="1"
                   id="${HOME_IDS.limit(id)}" data-id="${id}" autocomplete="off"
                   value="${escapeHtml(String(row.limit))}"
                   aria-label="How many to get from ${title}" />
          </div>
        </fieldset>
        <label class="choice">
          <input type="checkbox" id="${HOME_IDS.reread(id)}" ${row.rereadPages ? 'checked' : ''} />
          Re-read pages I have already downloaded
        </label>
      </div>
    </div>`;
}

function renderNoJobs(model) {
  const hint = model.hint
    ? '<p class="empty-hint">If your roles do not appear, open your jobs list on Wellfound.</p>'
    : '';
  // Saying what went wrong is half the job. This is the half the user can press.
  const remedy = model.reconnect
    ? `<button class="secondary empty-remedy" id="${HOME_IDS.reconnect}" type="button">
      ${RECONNECT_LABEL}
    </button>`
    : '';
  return `
    <p class="empty">${escapeHtml(model.message)}</p>
    ${hint}
    ${remedy}`;
}

// Accepting sits on the main screen rather than under Advanced, and it is the
// only control here that changes what people receive rather than what this
// computer stores. It is off unless it is ticked, the wording it will send is
// open for editing under it, and what accepting costs is stated beside the box
// rather than saved for the confirm screen: an operator deciding here is who
// that fact is for.
function renderAccept(model) {
  const body = model.accept
    ? `
      <p class="accept-cost warn">
        This cannot be undone. Each person gets this message under your Wellfound
        account, and an accepted applicant leaves the review queue for good, so
        this extension can never fetch or re-download them again.
      </p>
      <div class="accept-field">
        <label class="label" for="${HOME_IDS.acceptMessage}">Message</label>
        <textarea id="${HOME_IDS.acceptMessage}" rows="9" spellcheck="false"
                  aria-describedby="accept-tokens">${escapeHtml(model.acceptMessage)}</textarea>
      </div>
      <p class="job-meta" id="accept-tokens">
        [first_name] and [role_name] are filled in per person. No first name on
        file gives "Hey,".
      </p>
      <div class="accept-field">
        <p class="label">Example: ${escapeHtml(SAMPLE_FIRST_NAME)} on ${escapeHtml(model.acceptPreviewRole)}</p>
        <pre class="accept-preview">${escapeHtml(model.acceptPreview)}</pre>
      </div>`
    : '';
  return `
    <section class="accept${model.accept ? ' is-on' : ''}" aria-labelledby="accept-label">
      <label class="choice">
        <input id="${HOME_IDS.accept}" type="checkbox" ${model.accept ? 'checked' : ''} />
        <span id="accept-label">Accept these applicants and message them</span>
      </label>
      ${body}
    </section>`;
}

export function renderHome(model) {
  if (model.empty) return renderNoJobs(model);
  const s = model.settings;
  const note = model.note ? `<p class="job-meta warn">${escapeHtml(model.note)}</p>` : '';

  return `
    ${note}
    <div class="jobs">
      ${model.rows.map(renderJobRow).join('')}
    </div>
    <div class="settings">
      <div class="setting"><label class="label" for="${HOME_IDS.folder}">Save to</label>
        <input id="${HOME_IDS.folder}" name="folder" type="text" autocomplete="off" spellcheck="false"
               value="${escapeHtml(s.folder)}" /></div>
    </div>
    ${renderAccept(model)}
    <details class="advanced" id="${HOME_IDS.advanced}" ${s.advancedOpen ? 'open' : ''}>
      <summary>Advanced</summary>
      <div class="advanced-body">
        <label class="choice">
          <input id="${HOME_IDS.preview}" type="checkbox" ${s.preview ? 'checked' : ''} />
          Preview only: write the CSV, download nothing
        </label>
        <div class="advanced-item">
          <label class="choice">
            <input id="${HOME_IDS.fast}" type="checkbox" ${s.fast ? 'checked' : ''} />
            Fetch 20 at a time instead of 10
          </label>
          <p class="job-meta">above what the real Wellfound UI asks for</p>
        </div>
        <div class="advanced-item">
          <label class="choice">
            <input id="${HOME_IDS.verbose}" type="checkbox" ${s.verbose ? 'checked' : ''} />
            Log run detail to the console
          </label>
          <p class="job-meta">
            every step of the run, in this panel's developer console. More detail
            than Details shows, still no names and no resume links.
          </p>
        </div>
      </div>
    </details>
    <button class="primary" id="${HOME_IDS.start}" type="button" ${model.selectedCount ? '' : 'disabled'}>
      ${escapeHtml(model.startLabel)}
    </button>`;
}
