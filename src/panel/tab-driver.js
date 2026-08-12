import { sleep as realSleep } from '../lib/jitter.js';
import { CX } from '../lib/messages.js';

// One job: get a tab onto the right job's applicant list and confirm the page is
// ready to answer. It was tangled into the run controller, where the run loop,
// the ledger facade and the CSV writer all had to be stood up before any of this
// could be exercised at all.
export const APPLICANTS_URL = 'https://wellfound.com/recruit/applicants/';
// The content scripts run across the whole recruiter area now, so any recruiter
// page can answer LIST_JOBS from the page's Apollo cache. A run still navigates
// to an applicant list per job before fetching anyone.
export const RECRUIT_URL = 'https://wellfound.com/recruit/';
export const WELLFOUND_URL = 'https://wellfound.com/';

// Two different problems the user solves two different ways, so they are two
// different sentences. Neither names a mechanism.
export const NO_WELLFOUND_TAB = 'Open Wellfound to get started';
export const NOT_IN_RECRUITER_AREA =
  'Open your hiring pages on Wellfound (wellfound.com/recruit) to see your jobs';

// Markers, alongside the sentences above, so the panel can offer the actual
// remedy - opening the recruiter area - without reading the words shown to
// the user. Same reason PAGE_DISCONNECTED carries a code: a screen that
// decided by matching prose would break the day the prose improved.
export const NO_WELLFOUND_TAB_CODE = 'no-wellfound-tab';
export const NOT_IN_RECRUITER_AREA_CODE = 'not-in-recruiter-area';

// Reloading the extension severs the content scripts already running in open
// tabs, and no new ones are injected until the page navigates. The panel then
// messages a tab where nothing is listening, and Chrome's own words for that
// name a mechanism the user has never heard of. Translated here, where the
// failure is understood, rather than in the panel, which only ever sees a
// string.
export const PAGE_DISCONNECTED = 'page-disconnected';
export const PAGE_DISCONNECTED_MESSAGE =
  'The Wellfound page lost its connection to the extension, which happens after ' +
  'the extension reloads. Reload the page to connect it again.';

// Chrome has worded this two ways across versions, so the recognisable part of
// each is matched rather than the whole sentence. Anything else is somebody
// else's failure and is left as it is: a rejection mislabelled as a lost
// connection would send the user to reload a page that was never the problem.
const DISCONNECTED_SIGNS = ['receiving end does not exist', 'message port closed'];

function looksDisconnected(error) {
  const text = String(error?.message ?? error ?? '').toLowerCase();
  return DISCONNECTED_SIGNS.some((sign) => text.includes(sign));
}

// A marker as well as a sentence, so the panel can offer the remedy without
// reading the words shown to the user. The tab is carried too: whoever offers
// the reload should not have to go and find the tab again.
export function pageDisconnectedError(tabId) {
  const error = new Error(PAGE_DISCONNECTED_MESSAGE);
  error.code = PAGE_DISCONNECTED;
  error.tabId = tabId;
  return error;
}

export const READY_SETTLE_MS = 1500;
export const READY_POLL_MS = 500;
export const READY_TIMEOUT_MS = 15000;

// How many times a first message to a freshly loaded page is worth repeating.
// A tab can reach `complete` a moment before its content scripts are injected,
// and that moment is the difference between a panel that shows the roles and
// one the owner closes and opens again.
export const LISTEN_TRIES = 6;

// The browser saying a tab changed, rather than the panel asking whether one
// has. `onUpdated` fires for every tab without the `tabs` permission, and the
// listener reads nothing off the event - it only says "something moved, ask
// again" - so no permission is needed and nothing is polled.
export function watchTabs(listener) {
  const onUpdated = (tabId, changeInfo) => {
    // Status and url are the two that can turn a page this panel cannot use
    // into one it can. Everything else - the title, the favicon, muting - is
    // noise that would re-run the load for nothing.
    if (changeInfo?.status || changeInfo?.url) listener();
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  return () => chrome.tabs.onUpdated.removeListener(onUpdated);
}

// `sleep` and `now` are injected so a test can drive the readiness poll without
// waiting fifteen real seconds for the timeout branch, and they default to the
// real thing because the shipped extension always paces itself.
//
// `trace` is required. It used to default to a null object, for a dependency
// with one implementation and one caller that always passes it - and a default
// that swallows every step is the worst thing to fall back to in the module
// whose trace proved the readiness poll was needed at all.
// Everything else talks to the browser directly.
export function createTabDriver({ sleep = realSleep, now = () => Date.now(), trace }) {
  // Any recruiter page will do. The panel used to demand the applicant list,
  // which is the one page the user has no reason to be on when they open the
  // panel to pick roles.
  async function workingTab() {
    const [tab] = await chrome.tabs.query({ url: `${RECRUIT_URL}*` });
    if (tab) return tab;
    const [elsewhere] = await chrome.tabs.query({ url: `${WELLFOUND_URL}*` });
    const error = new Error(elsewhere ? NOT_IN_RECRUITER_AREA : NO_WELLFOUND_TAB);
    error.code = elsewhere ? NOT_IN_RECRUITER_AREA_CODE : NO_WELLFOUND_TAB_CODE;
    throw error;
  }

  async function ask(tabId, message) {
    // sendMessage rejects when nothing is listening; it does not resolve with an
    // `ok: false`. So the no-receiver case never reached the check below, and
    // Chrome's raw sentence went all the way to the screen.
    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      if (looksDisconnected(error)) throw pageDisconnectedError(tabId);
      throw error;
    }
    if (!response?.ok) throw new Error(response?.error ?? 'No response from the page');
    return response.data;
  }

  // The same question, asked again while the page is still arriving.
  //
  // Only PAGE_DISCONNECTED is repeated, and only that: it is the one failure
  // that means "not yet" rather than "no". A page that is genuinely severed -
  // the extension was reloaded under it - still ends here, with the reload the
  // panel offers for it, a few seconds later.
  //
  // For first contact only. Nothing mid-run may retry itself: a run drives the
  // reviewer, and repeating a message that sends is how somebody gets messaged
  // twice.
  async function askWhenListening(tabId, message, { tries = LISTEN_TRIES } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await ask(tabId, message);
      } catch (error) {
        if (error.code !== PAGE_DISCONNECTED || attempt >= tries) throw error;
        await sleep(READY_POLL_MS);
      }
    }
  }

  // Has the browser finished putting the target document in this tab? A tab
  // still loading, or still showing the page we navigated away from, is a
  // reason to keep polling rather than to trust anything it says.
  async function tabArrived(tabId, target) {
    try {
      const tab = await chrome.tabs.get(tabId);
      // Chrome omits `status` in some contexts; only a stated non-complete
      // status is evidence of a load in progress.
      if (tab.status && tab.status !== 'complete') return false;
      return Boolean(tab.url?.startsWith(target));
    } catch {
      return false;
    }
  }

  // The page's Apollo client only registers RecruitJobListingApplicants for the
  // job it is currently showing, so the tab is navigated per job and given time
  // to settle before the first fetch.
  async function focusJob(tabId, jobId) {
    const target = `${APPLICANTS_URL}jobs/${jobId}`;
    const startedAt = now();
    const tab = await chrome.tabs.get(tabId);
    // Being on the right URL is not being ready. The commonest path of all is
    // the recruiter already viewing the job, opening the side panel and pressing
    // Start while Apollo is still hydrating - so the early return skips the
    // navigation only, never the readiness poll. Skipping the poll here is what
    // made the first fetch throw "RecruitJobListingApplicants is not active yet"
    // and take the whole run down with it.
    const navigated = !tab.url?.startsWith(target);
    trace.record('focus', { jobId, kind: navigated ? 'navigate' : 'already-there' });
    if (navigated) {
      await chrome.tabs.update(tabId, { url: target });
      // A short settle for the navigation, then poll for the real thing. The old
      // flat 4 s was a guess, and on a slow load the query was not registered yet
      // and the first fetch threw, aborting the whole run.
      await sleep(READY_SETTLE_MS);
    }
    const deadline = now() + READY_TIMEOUT_MS;
    let attempts = 0;
    let last = 'no-answer';
    while (now() < deadline) {
      attempts += 1;
      try {
        // The tab check first: probing a document that is on its way out is how
        // the run came to trust an answer from the previous job's page.
        if (await tabArrived(tabId, target)) {
          const ready = await ask(tabId, { type: CX.QUERY_READY });
          const seenJobId = ready?.jobId == null ? null : String(ready.jobId);
          if (seenJobId === String(jobId)) {
            trace.record('focus_ready', { jobId, attempts, ms: now() - startedAt });
            return;
          }
          // A stale document answers for the job it is still showing. That is
          // not readiness, it is the race - keep polling.
          last = seenJobId ? 'wrong-job' : 'not-ready';
          if (seenJobId) trace.record('focus_wrong_job', { jobId, seenJobId, attempts });
        } else {
          last = 'loading';
        }
      } catch {
        // The page may still be swapping documents, which drops the message
        // channel. Keep polling until the deadline.
        last = 'no-channel';
      }
      await sleep(READY_POLL_MS);
    }
    trace.record('focus_timeout', { jobId, attempts, ms: now() - startedAt, outcome: last });
    throw new Error('The Wellfound applicant list did not finish loading');
  }

  return { workingTab, ask, askWhenListening, focusJob };
}
