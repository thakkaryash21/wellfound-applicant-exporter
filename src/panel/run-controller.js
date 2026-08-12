import { runJob, runActions } from '../lib/runner.js';
import { toCsv, PREVIEW, ACCEPT_STATUS } from '../lib/csv.js';
import { PACING, sample, sleep as realSleep } from '../lib/jitter.js';
import { normalizeNode } from '../lib/normalize.js';
import { CX } from '../lib/messages.js';
import { createTrace, scrubVariables } from '../lib/trace.js';
import { localDateStamp } from '../lib/local-time.js';
import { consoleSink } from './verbose-console.js';
import { createTabDriver } from './tab-driver.js';
import { createLedgerService } from './ledger-service.js';
import { registerFilenameHandler, downloadResume, downloadBlobText } from './downloader.js';
import { runAcceptPass } from './accept-pass.js';

// The trace's one word for which of the four modes a run is. 'live' is what the
// download-only run has always been called in the trace, and stays.
export function runKind(actions) {
  const { download, accept } = runActions(actions);
  if (download && accept) return 'live+accept';
  if (download) return 'live';
  if (accept) return 'accept';
  return PREVIEW;
}

// A re-download walks pages looking for userIds that may have left the review
// bucket entirely, so it needs a stop that does not depend on hasNextPage.
const REDOWNLOAD_PAGE_CAP = 40;
// The same page size a normal, non-"Faster" run asks for, so a re-download's
// requests are indistinguishable from an ordinary one's.
const REDOWNLOAD_PAGE_SIZE = 10;

// The bucket the whole extension reads. The status enum is exactly
// NEEDS_REVIEW, REJECTED and SHORTLISTED - there is no ACCEPTED - so the only
// question the API can answer about an accept is whether the candidate has left
// this collection. Nothing can positively confirm one.
const REVIEW_BUCKET = 'NEEDS_REVIEW';
// The queue check pages like a re-download does, at the same size and under a
// cap, for the same reasons: its requests must look like every other one this
// extension makes, and a walk with no stop of its own would keep asking for
// pages a very large role would keep handing it.
const QUEUE_CHECK_PAGE_SIZE = 10;
const QUEUE_CHECK_PAGE_CAP = 40;

// How long a reload is given to commit before the page is called dead. It is a
// deadline, not a pause: nothing waits on it when the navigation arrives. The
// figure is deliberately far beyond the worst load measured on the degraded
// 111-applicant page (35 s), because the cost of being wrong here is a stopped
// run, and the accept pass has already written everything it owes to the ledger
// before a reload is ever asked for.
export const RELOAD_TIMEOUT_MS = 60000;
export const RELOAD_NOT_OBSERVED = 'The Wellfound page did not reload';

// Watching a navigation instead of assuming one, for the reload the accept
// pass asks for.
//
// `chrome.tabs.reload` resolves when the reload has been REQUESTED, not when
// the new document commits. Until Chrome flips the tab's status the PRE-reload
// document is still live and still answering - including the readiness probe,
// which it answers correctly, for the same jobId. So the run used to conclude
// the page was ready before the navigation had happened at all, and the
// navigation could then commit in the middle of the next accept: the composer's
// document destroyed with a real message in it and nothing left to say whether
// it went out. The accept pass's own interlock cannot see this; it guards the
// moment the pass ASKS for a reload, not the moment the browser obeys.
//
// So the transition is observed rather than assumed, and observed in both
// halves: `loading` says this navigation has begun, `complete` says the
// document answering now is the one it brought. No sleep is involved - a sleep
// would be the same assumption with a number on it.
//
// The listener is in place the moment this returns, so whatever asks the
// browser to navigate is called afterwards and no fast page can beat it.
// `arrived` resolves on the complete that followed this navigation's own
// `loading`, and rejects at the deadline.
export function watchNavigation(tabId, { timeoutMs, notObserved }) {
  let sawLoading = false;
  let timer = null;
  let finish = null;
  const arrived = new Promise((resolve, reject) => {
    finish = (error) => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (timer !== null) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
  });
  const listener = (id, changeInfo) => {
    if (id !== tabId) return;
    if (changeInfo.status === 'loading') sawLoading = true;
    // `complete` on its own is the old document settling. Only a complete
    // that follows this navigation's start is evidence of a new one.
    else if (changeInfo.status === 'complete' && sawLoading) finish();
  };
  chrome.tabs.onUpdated.addListener(listener);
  timer = setTimeout(() => finish(new Error(notObserved)), timeoutMs);
  return { arrived, fail: (error) => finish(error) };
}

// Reload the tab and do not come back until the NEW document is the one in it.
export function reloadTab(tabId, { timeoutMs = RELOAD_TIMEOUT_MS } = {}) {
  const navigation = watchNavigation(tabId, { timeoutMs, notObserved: RELOAD_NOT_OBSERVED });
  // Asked for only once the listener is in place: on a fast page the
  // transition can arrive before this call's own promise resolves.
  Promise.resolve(chrome.tabs.reload(tabId)).catch(navigation.fail);
  return navigation.arrived;
}

// `sleep` is a seam, not a setting: the panel never passes one, so the shipped
// extension always paces itself. A test supplies an instant one so that walking
// twenty candidates does not take a real minute - and then asserts on the delays
// that were asked for, which is where the pacing is actually checked.
export function createController({
  onEvent,
  sleep = realSleep,
  // The run trace, so the panel can show it and a test can read it. The console
  // sink prints nothing until the user ticks the Advanced checkbox.
  trace = createTrace({ sink: consoleSink }),
} = {}) {
  // Registered here, on construction, and deliberately not at module scope. It
  // used to run as an import side effect of this file, which meant panel.js's
  // own downloadTextFile call was named correctly only because panel.js happens
  // to import run-controller on the line above downloader. Reordering those two
  // imports - a formatter, a lint autofix, anyone - sent the run report into the
  // downloads root under the blob's UUID, which is a bug this extension has
  // already shipped once. A constructor call cannot be reordered away, and the
  // listener still shares its lifetime with the `pendingByUrl` map it reads.
  registerFilenameHandler();
  // The ledger and everything that reconciles it against the disk. None of it
  // takes the lock, drives the tab or writes to the trace, which is why it is
  // its own module; the run uses it, it does not use the run.
  const ledgerService = createLedgerService(chrome.storage.local);
  const { reconcileJob } = ledgerService;
  const tabs = createTabDriver({ sleep, trace });
  let controller = null;

  // One lock for every activity that drives the working tab. A re-download and a
  // run both navigate it, so letting them overlap would have one loop's next
  // fetch return the other job's applicants - written under the wrong jobId.
  function takeLock() {
    if (controller) throw new Error('A run is already in progress');
    controller = new AbortController();
    return controller.signal;
  }

  // Every run event, reduced to the handful of fields the trace may keep. The
  // applicant's name rides on `candidate` events and is deliberately not passed
  // on - the trace has to stay safe to paste into a chat window.
  function traceEvent(event) {
    const jobId = event.jobId;
    if (event.type === 'started') trace.record('job_start', { jobId });
    else if (event.type === 'page')
      trace.record('page', {
        jobId,
        page: event.page,
        bucket: event.bucket,
        count: event.fetched,
        fresh: event.fresh,
      });
    else if (event.type === 'candidate')
      trace.record('candidate', {
        jobId,
        userId: event.userId,
        outcome: event.outcome,
        error: event.error,
      });
    // The accept pass, in the same three shapes the download walk uses: one
    // entry when it starts, one per person it acted on, one when it stops. The
    // name never travels, exactly as on `candidate`.
    else if (event.type === 'accept_started')
      trace.record('accept_start', { jobId, count: event.intended });
    else if (event.type === 'accept_candidate')
      trace.record('accept_candidate', {
        jobId,
        userId: event.userId,
        outcome: event.outcome,
        error: event.error,
      });
    // The ambiguous path, in two entries rather than one: a send the page never
    // confirmed, and then what the queue said about it. Both belong in the
    // trace whatever the answer was - a run that resolved an unconfirmed send
    // by itself must still leave a record that one happened, because the
    // hypothesis about why they happen is not yet a fact.
    else if (event.type === 'accept_unconfirmed')
      trace.record('accept_unconfirmed', { jobId, userId: event.userId, error: event.error });
    // A message that demonstrably went out and could not be written down. The
    // trace is the durable account of a run, and this is the one entry in it
    // that says a real person was messaged with nothing left remembering it.
    else if (event.type === 'accept_unrecorded')
      trace.record('accept_unrecorded', { jobId, userId: event.userId, error: event.error });
    // The pass asking again, after the role is done, about every send it could
    // not settle on the spot. Recorded so a later timing question can see that
    // the sweep ran and how much it had to do - a run whose deferrals all
    // resolved looks otherwise identical to one that never had any.
    else if (event.type === 'accept_settling')
      trace.record('accept_settling', { jobId, count: event.count });
    else if (event.type === 'accept_checked')
      trace.record('accept_checked', { jobId, userId: event.userId, outcome: event.verdict });
    else if (event.type === 'accept_reopen')
      trace.record('accept_reopen', { jobId, count: event.accepted });
    // The coarser cycle, recorded separately from the reopen it replaces on
    // that turn. Which of the two ran is the thing a later timing question
    // would be asked of, and a trace that called them both 'refresh' could not
    // answer it.
    else if (event.type === 'accept_reload')
      trace.record('accept_reload', { jobId, count: event.accepted });
    // The other reason a reload happens: one accept that took long enough to say
    // the page is degrading. Recorded with its duration, because the threshold
    // was chosen from durations and the next question asked of it will be too.
    else if (event.type === 'accept_slow')
      trace.record('accept_slow', { jobId, userId: event.userId, ms: event.ms });
    else if (event.type === 'accept_done')
      trace.record('accept_done', {
        jobId,
        count: event.accepted,
        outcome: event.stoppedBecause,
        error: event.error,
      });
    else if (event.type === 'resting') trace.record('sleep', { jobId, ms: event.ms, kind: 'rest' });
    else if (event.type === 'break') trace.record('sleep', { jobId, ms: event.ms, kind: 'break' });
    else if (event.type === 'job_error') trace.record('job_error', { jobId, error: event.error });
    else if (event.type === 'job_note') trace.record('job_note', { jobId, outcome: event.note });
    else if (event.type === 'job_done')
      trace.record('job_done', {
        jobId,
        count: event.downloaded,
        page: event.pages,
        outcome: event.stoppedBecause,
      });
    else if (event.type === 'done')
      trace.record('run_end', {
        count: event.downloaded,
        outcome: event.stoppedBecause,
        error: event.error,
      });
  }

  function emit(event) {
    // Traced before it is rendered: a render that throws must still leave the
    // step in the trace, since that step is very likely the interesting one.
    traceEvent(event);
    try {
      onEvent(event);
    } catch (error) {
      // A rendering error must never abort a run - but swallowing it silently
      // freezes the running screen with no signal at all. This is the one place
      // in src/ where a console line is warranted.
      console.error('wfx: render failed for event', event?.type, error);
    }
  }

  // The request itself, timed. A run that stops on a fetch stops here, and this
  // is the entry that says so. The variables actually sent go to the verbose
  // console only, scrubbed: a recruiter's typed filter can be a person's name.
  async function tracedFetch(tabId, args) {
    const startedAt = Date.now();
    try {
      const page = await tabs.ask(tabId, { type: CX.FETCH_PAGE, payload: args });
      trace.record(
        'fetch',
        { jobId: args.jobId, count: page?.edges?.length ?? 0, ms: Date.now() - startedAt },
        { ...scrubVariables(args), cursor: page?.endCursor },
      );
      return page;
    } catch (error) {
      trace.record('fetch_error', {
        jobId: args.jobId,
        ms: Date.now() - startedAt,
        error: String(error.message || error),
      });
      throw error;
    }
  }

  // Is this person still in the review queue?
  //
  // Asked by the accept pass, and only when a send was clicked and the page
  // never confirmed it. The extension is not out of options at that moment: it
  // already reads an authoritative list, and an accepted candidate leaves it. So
  // rather than reporting a shrug it establishes the fact.
  //
  // 'gone' is the whole of the evidence available and it is one-directional: no
  // query can positively confirm an accept, because there is no ACCEPTED status
  // to ask for. Absence is not infinite evidence either - a candidate could
  // leave NEEDS_REVIEW for another reason - but over the seconds between the
  // click and this walk the only other ways out are a human acting on the same
  // queue by hand at that moment, or the application expiring in that window.
  // And the direction of the remaining error is the safe one: a wrong 'gone'
  // books somebody as accepted who was not, costing them a message, where the
  // failure this replaces cost a run and mislabelled somebody who WAS messaged.
  // Nothing here can ever cause a second message; only the ledger grows.
  //
  // Anything short of a complete walk of the collection is 'unknown', including
  // a page that came back from some other bucket than the one this reads.
  // Where a queue check last found somebody, keyed by job and user. The whole
  // of the state this check keeps, and the reason 44 fetches become 14.
  //
  // The settle window asks the same question about the same person four times
  // over about a minute, and on the run that made this necessary the answer was
  // `queued` every time, from page eleven of twelve. Eleven fetches, four
  // times. The pages before that one are re-read only to arrive back at the
  // page that already answered.
  //
  // So a look that finds somebody remembers the cursor of the page it found
  // them on, and the next look tries that page first: one fetch for a `queued`
  // that used to cost eleven. It is a hint and never an authority - if they are
  // not there, or the page cannot be read, the hint is dropped and the full
  // walk happens exactly as before, which is what `gone` still requires.
  const lastSeenAt = new Map();

  // One page of the review queue, and whether the person we are asking about is
  // on it. Split out because the hint above and the walk below need the same
  // read and must agree about what a foreign bucket means.
  async function pageHolds(tabId, jobId, after, wanted) {
    const result = await tracedFetch(tabId, { jobId, pageSize: QUEUE_CHECK_PAGE_SIZE, after });
    // The walk copies whatever bucket the recruiter has open rather than
    // forcing one, so it can legitimately be looking at REJECTED. Absence from
    // a bucket this function did not mean to read says nothing at all.
    if (result.bucket !== REVIEW_BUCKET) return { verdict: 'unknown' };
    for (const node of result.edges ?? []) {
      if (normalizeNode(node, { jobId }).userId === wanted) return { verdict: 'queued' };
    }
    return { verdict: null, hasNextPage: result.hasNextPage, endCursor: result.endCursor };
  }

  // Is this person still in the review queue?
  //
  // Asked by the accept pass, and only when a send was clicked and the page
  // never confirmed it. The extension is not out of options at that moment: it
  // already reads an authoritative list, and an accepted candidate leaves it. So
  // rather than reporting a shrug it establishes the fact.
  //
  // 'gone' is the whole of the evidence available and it is one-directional: no
  // query can positively confirm an accept, because there is no ACCEPTED status
  // to ask for. Absence is not infinite evidence either - a candidate could
  // leave NEEDS_REVIEW for another reason - but over the seconds between the
  // click and this walk the only other ways out are a human acting on the same
  // queue by hand at that moment, or the application expiring in that window.
  // And the direction of the remaining error is the safe one: a wrong 'gone'
  // books somebody as accepted who was not, costing them a message, where the
  // failure this replaces cost a run and mislabelled somebody who WAS messaged.
  // Nothing here can ever cause a second message; only the ledger grows.
  //
  // The two answers cost different amounts, and that asymmetry is the same one
  // the verdicts themselves have. FINDING somebody proves `queued` on the spot,
  // so the walk stops on the page that holds them and never reads another.
  // Only absence needs exhaustiveness, so only `gone` is concluded from a
  // complete walk whose every page came back from the review bucket. Anything
  // short of that - the cap with pages still to come, a foreign bucket - is
  // 'unknown'.
  async function queueCheck(tabId, jobId, userId) {
    const wanted = String(userId);
    const key = `${jobId}:${wanted}`;

    // The hint first, when there is one. At most one extra fetch, and it
    // answers the common case of the settle window outright.
    const hint = lastSeenAt.get(key);
    if (hint !== undefined) {
      const seen = await pageHolds(tabId, jobId, hint, wanted);
      if (seen.verdict === 'queued') {
        trace.record('queue_hint', { jobId, userId: wanted, outcome: 'queued' });
        return 'queued';
      }
      // Either they have moved or the page could not be read. Neither is an
      // answer, and neither leaves a hint worth keeping.
      lastSeenAt.delete(key);
      trace.record('queue_hint', { jobId, userId: wanted, outcome: 'stale' });
      if (seen.verdict === 'unknown') return 'unknown';
    }

    let after = null;
    for (let page = 0; page < QUEUE_CHECK_PAGE_CAP; page += 1) {
      const seen = await pageHolds(tabId, jobId, after, wanted);
      if (seen.verdict === 'unknown') return 'unknown';
      if (seen.verdict === 'queued') {
        // `after` is the cursor this page was fetched WITH, which is what it
        // takes to fetch it again - not the cursor it handed back.
        lastSeenAt.set(key, after);
        return 'queued';
      }
      if (!seen.hasNextPage) return 'gone';
      after = seen.endCursor;
      const ms = sample(PACING.downloadMs[0], PACING.downloadMs[1]);
      emit({ type: 'resting', jobId, ms });
      await sleep(ms);
    }
    // The cap, with pages still to come. The person was not on any page walked,
    // but the collection was not exhausted, so nothing has been established.
    return 'unknown';
  }

  async function writeCsv(jobId, records, folder) {
    if (records.length === 0) return false;
    // The user's own day, not UTC's. A 19:23 run used to stamp its CSVs with
    // tomorrow's date while the report beside them said today.
    const date = localDateStamp();
    await downloadBlobText({
      text: toCsv(records),
      mime: 'text/csv;charset=utf-8',
      filename: `applicants-${jobId}-${date}.csv`,
      folder,
    });
    return true;
  }

  return {
    // The four the Library screen calls, named rather than spread. Spreading
    // the whole service put the run's own writes - recordDownloaded and
    // finishRun - on the object the Library holds.
    library: ledgerService.library,
    importCsv: ledgerService.importCsv,
    adoptOrphans: ledgerService.adoptOrphans,
    forget: ledgerService.forget,

    // Enriched with ledger state so the UI can say how many are actually new
    // rather than how many sit in the review queue. `estimatedNew` is an
    // estimate: it cannot know about applicants who left the queue since the
    // last run. The run itself is authoritative.
    // `onHydrating` is called only when a navigation is actually about to
    // happen, so the panel can say "Reading your jobs..." for exactly as long as
    // it is true.
    async listJobs({ onHydrating } = {}) {
      const tab = await tabs.workingTab();
      // The first thing this panel ever says to the page, and the one message
      // worth repeating: a tab can be `complete` a beat before its content
      // scripts are in it.
      let jobs = await tabs.askWhenListening(tab.id, { type: CX.LIST_JOBS });

      // The counts come from a query of their own, which the page registers
      // only in the applicants area. Everywhere else the cache holds every
      // title and no counts at all, and no amount of waiting changes that -
      // three attempts at this bug were three ways of waiting for an answer
      // nobody had asked for. So a missing count means one thing now: go where
      // the query lives and ask again.
      //
      // Nothing is remembered between passes. A role that comes back uncounted
      // is asked about next time, and after the first trip the tab is already
      // on the applicant list, so there is usually nowhere to go.
      const blank = jobs.find((job) => job.actionableCount == null);
      if (blank && !controller) {
        onHydrating?.();
        try {
          await tabs.focusJob(tab.id, blank.jobId);
          jobs = await tabs.ask(tab.id, { type: CX.LIST_JOBS });
        } catch {
          // The list is still usable without counts, and a navigation that
          // failed is not worth throwing away the jobs we already have.
        }
      }

      return Promise.all(
        jobs.map(async (job) => {
          // `known`, not `downloaded`. The download counter deliberately does
          // not move when a CSV import or an orphan adoption teaches the ledger
          // about people, so estimating from it promised files the run would
          // then correctly refuse to fetch.
          const { known, downloaded } = await ledgerService.describe(job.jobId);
          // Everyone this extension has already messaged for this role. It is
          // the sibling of `known` and it is here for the same reason: without
          // it the confirm screen counts people the run will then correctly
          // skip, and that screen is the one place a number must not read
          // higher than what will happen.
          //
          // It counts what we did, not who has been accepted. An applicant the
          // operator accepted by hand in Wellfound is in neither this list nor
          // the review queue, and nothing here can see them.
          const accepted = (await ledgerService.acceptedUserIdsFor(job.jobId)).length;
          const estimatedNew =
            job.actionableCount == null ? null : Math.max(0, job.actionableCount - known);
          return { ...job, downloaded, known, accepted, estimatedNew };
        }),
      );
    },

    abort() {
      const wasRunning = Boolean(controller);
      if (wasRunning) trace.record('abort', { kind: 'user' });
      controller?.abort();
      return { aborted: wasRunning };
    },

    // Per job, not per run: the owner wants all of one role and the first 25 of
    // another in a single go. `pageSize` and `actions` stay global because they
    // genuinely are. `limit` is Infinity for "all new".
    // The trace of the run that just happened, exposed so the panel can show it
    // under the summary and store it beside one.
    trace,

    // `acceptMessage` is the operator's wording, passed in rather than reached
    // for: the panel shows the exact text on the confirm screen, and the text
    // that was shown must be the text that is sent. Absent, accept-message.js's
    // own default stands.
    async startRun({ jobs: requested, folder, pageSize, actions: asked, acceptMessage }) {
      const actions = runActions(asked);
      const signal = takeLock();
      trace.reset();
      trace.record('run_start', {
        count: requested.length,
        kind: runKind(actions),
        pageSize,
      });

      // What the operator ASKED FOR, built here, before a single request, and
      // carried to the end untouched. Every diagnosis this session began with
      // the operator being asked which boxes they had ticked, because a trace
      // records effects and the report opened with results.
      //
      // It is a record of intent, so it is captured rather than reconstructed:
      // a run that dies at role three of four still says what it was trying to
      // do, because this object was complete before role one started. Titles
      // are filled in below from the job list, which is the only place they
      // exist - still intent, since it happens before any work.
      const config = {
        mode: runKind(actions),
        actions,
        pageSize,
        folder,
        // The wording in force for THIS run. It is editable per run, so a
        // report of an accept run without it cannot be read afterwards: the one
        // thing a reader would want to know about an irreversible message is
        // what it said. Carried only when the run would actually send.
        ...(actions.accept ? { acceptMessage } : {}),
        roles: requested.map((r) => ({
          jobId: r.jobId,
          jobTitle: null,
          // Infinity survives neither storage nor rendering, and the operator
          // does not read it either. Null is the unlimited case and the report
          // says so in words.
          limit: Number.isFinite(r.limit) ? r.limit : null,
          forceFullWalk: Boolean(r.forceFullWalk),
        })),
      };
      // The scope in the trace as well, minus the message text: the trace is
      // public-safe by design and the wording is the operator own words. Ids
      // and numbers only, exactly like every other entry here.
      for (const role of config.roles) {
        trace.record('run_scope', { jobId: role.jobId, count: role.limit });
      }

      const totals = {
        downloaded: 0,
        failed: 0,
        // What a run with downloads off has to report instead of `downloaded`,
        // which is 0 by definition for a preview.
        previewed: 0,
        skippedNoResume: 0,
        skippedNoId: 0,
        masked: 0,
        // The accept dimension, counted separately from every download number
        // above it: they answer different questions, and a summary that added
        // them together would say a run touched more people than it did.
        accepted: 0,
        // People this run declined to accept because their resume was never
        // captured. Accepting them would have lost that resume for good.
        acceptRefused: 0,
        acceptFailed: 0,
        acceptAlready: 0,
        // People whose send was clicked and whose outcome nothing could settle,
        // even after the accept pass asked again at the end of the role. Kept
        // apart from `accepted` and from `acceptFailed` because it is neither:
        // saying either about these people is the mistake this counter exists
        // to stop the report making.
        acceptUnresolved: 0,
      };
      // Per job, so the summary can name which job hit the limit and which one
      // stopped early. Without this those reasons died inside job_done, which
      // nothing rendered, and a truncated run looked identical to a whole one.
      const jobStops = [];
      const failedNames = [];
      let jobs = [];
      let stoppedBecause = 'finished';

      const titleOf = (id) => jobs.find((j) => j.jobId === id)?.title ?? id;
      // Jobs the user selected that this run never reached. A fatal error at job
      // 3 of 4 leaves job 4 unwalked, and the user has no other way to find out.
      const notWalked = () => {
        const walked = new Set(jobStops.map((j) => j.jobId));
        return requested.map((r) => r.jobId).filter((id) => !walked.has(id)).map(titleOf);
      };

      try {
        const tab = await tabs.workingTab();
        jobs = await tabs.ask(tab.id, { type: CX.LIST_JOBS });
        // The one part of the configuration that cannot be known before the page
        // is asked. Still intent: it happens before the first role is walked,
        // and it renames nothing - the id it belongs to was recorded already.
        for (const role of config.roles) role.jobTitle = titleOf(role.jobId);

        for (const [index, request] of requested.entries()) {
          if (signal.aborted) break;
          const { jobId, limit = Infinity, forceFullWalk = false } = request;
          const job = jobs.find((j) => j.jobId === jobId);
          const jobTitle = job?.title ?? jobId;
          await tabs.focusJob(tab.id, jobId);

          // Reconcile first: a file the user deleted is missing from disk, and
          // the run should quietly fetch it again rather than trusting the
          // ledger's memory of having downloaded it once.
          const status = await reconcileJob(jobId);
          const gone = new Set(status.missing);
          const seen = await ledgerService.seenUserIdsFor(jobId);
          const seenUserIds = seen.filter((id) => !gone.has(id));

          const result = await runJob(
            {
              fetchPage: (args) => tracedFetch(tab.id, args),
              downloadResume,
              // Written per file, not per job: a run that stops early must not
              // lose credit for resumes already on disk.
              recordDownloaded: (r) => ledgerService.recordDownloaded(jobId, r, { jobTitle }),
              sleep,
              emit,
            },
            {
              jobId,
              jobTitle,
              seenUserIds,
              pageSize,
              folder,
              limit,
              forceFullWalk,
              actions,
              signal,
              jobIndex: index + 1,
              jobTotal: requested.length,
            },
          );

          totals.downloaded += result.downloaded.length;
          totals.failed += result.failed.length;
          totals.previewed += result.previewed.length;
          totals.skippedNoResume += result.skippedNoResume.length;
          totals.skippedNoId += result.skippedNoId.length;
          totals.masked += result.masked.length;
          // Named, not just counted: these people are not in the ledger, so
          // "Re-download missing" will never reach them and only the next full
          // run will try again.
          failedNames.push(...result.failed.map((r) => r.name ?? r.userId ?? 'unnamed'));
          const stop = {
            jobId,
            jobTitle,
            // Carried out so the summary can name the number this job was asked
            // for. There is no longer one run-wide limit to name.
            limit,
            stoppedBecause: result.stoppedBecause,
            downloaded: result.downloaded.length,
            pages: result.pages,
            // Filled in below, once the CSV write has been attempted. Pushed
            // before that so the ordering of jobStops still follows the run.
            wroteCsv: false,
          };
          jobStops.push(stop);

          if (actions.download) {
            // The folder is stored with the run so a later re-download lands
            // beside the originals rather than in the default directory.
            await ledgerService.finishRun(jobId, { folder });
            trace.record('ledger_write', { jobId, count: result.downloaded.length });
          }
          // Pass 2, and only now: accepting removes people from the very
          // NEEDS_REVIEW collection pass 1 above paginates with a cursor, so
          // the two passes are never interleaved. It drives the applicant
          // reviewer rather than the API, which is why it is a second pass
          // over the same job rather than a branch inside runJob.
          //
          // Before the CSV write, not after: an accepted candidate can never
          // be fetched again, so this file is the only surviving copy of what
          // happened to them, and its Accept column has to say. The pass never
          // throws - an abort, a refusal or an unclear send all come back as a
          // result - so the CSV below is still written either way.
          // ...unless pass 1 stopped because five downloads failed in a row.
          // That stop exists because continuing would issue hundreds of failing
          // requests at human pacing - the most suspicious pattern this
          // extension can produce. Pass 2 does not merely continue: it drives
          // Wellfound's own UI to send real, irreversible messages under the
          // operator's name. A job whose downloads just collapsed is the worst
          // possible moment to start sending, so the accepts are held back and
          // the run says so rather than leaving a zero to be interpreted.
          //
          // An aborted pass 1 needs nothing here: the operator's signal is the
          // same one the accept pass checks before it opens the reviewer, so an
          // abort already stops pass 2 with nothing sent.
          const heldBack = actions.accept && result.stoppedBecause === 'failing';
          if (heldBack) {
            stop.acceptHeldBack = true;
            trace.record('accept_held_back', { jobId, outcome: 'failing' });
            // The run was accepting, and stopped before it reached anybody.
            // That is exactly NOT_REACHED, and a blank cell here would read as
            // "we tried and nothing happened".
            for (const record of result.records) {
              record.acceptStatus = ACCEPT_STATUS.NOT_REACHED;
            }
          } else if (actions.accept) {
            const acceptResult = await runAcceptPass(
              {
                review: (message) => tabs.ask(tab.id, message),
                recordAccepted: (id, userId) => ledgerService.recordAccepted(id, userId),
                // The way out of an unconfirmed send. It is the same tab and
                // the same query pass 1 walked - there is no second Apollo
                // caller - and the pass calls it only on the ambiguous path.
                checkQueue: (userId) => queueCheck(tab.id, jobId, userId),
                // The coarse refresh. The accept pass decides WHEN; this is
                // the whole of HOW, and it is deliberately two lines of
                // existing machinery rather than a mechanism of its own.
                // `chrome.tabs.reload` needs no permission this extension does
                // not already hold. It is wrapped because it resolves on the
                // REQUEST, and focusJob alone cannot tell the two documents
                // apart - the pre-reload one answers for the same jobId
                // perfectly well. reloadTab watches the navigation commit;
                // focusJob then does what it has always done, which is wait
                // until the page can answer for this job again.
                reloadPage: async () => {
                  trace.record('accept_reload_start', { jobId });
                  await reloadTab(tab.id);
                  trace.record('accept_reload_commit', { jobId });
                  await tabs.focusJob(tab.id, jobId);
                },
                sleep,
                emit,
              },
              {
                jobId,
                jobTitle,
                records: result.records,
                alreadyAccepted: await ledgerService.acceptedUserIdsFor(jobId),
                // The same per-role number pass 1 was given, and the reason it
                // has to be handed on: pass 1 counts it against NEW downloads,
                // and an accepting run forces a full walk, so on a role that
                // was already downloaded pass 1's counter never moves and its
                // limit never fires - while `records` still holds every
                // applicant, every one of them captured and acceptable. A
                // limit of 3 sent 115 messages. Here it means what the
                // operator reads it as: at most this many people are messaged.
                limit,
                template: acceptMessage,
                signal,
              },
            );
            totals.accepted += acceptResult.accepted;
            totals.acceptRefused += acceptResult.refusedNoResume;
            totals.acceptFailed += acceptResult.failed;
            totals.acceptAlready += acceptResult.alreadyAccepted;
            totals.acceptUnresolved += acceptResult.unresolved;
            stop.accepted = acceptResult.accepted;
            stop.acceptIntended = acceptResult.intended;
            stop.acceptUnresolved = acceptResult.unresolved;
            stop.acceptStoppedBecause = acceptResult.stoppedBecause;
          } else {
            // A run that was never accepting says so in the column rather than
            // leaving it blank, which reads as "we tried and nothing happened".
            for (const record of result.records) {
              record.acceptStatus = ACCEPT_STATUS.NOT_ACCEPTING;
            }
          }

          // A job that yielded nothing wrote no CSV and said nothing at all,
          // which reads as a silent failure rather than an empty queue.
          const wrote = await writeCsv(jobId, result.records, folder);
          stop.wroteCsv = wrote;
          trace.record(wrote ? 'csv_write' : 'csv_empty', { jobId, count: result.records.length });
          // The live region only: it is overwritten within seconds by the next
          // event, and the post-run screen replaces the screen entirely. The
          // durable account is `wroteCsv` above, which summary.js reads.
          if (!wrote) emit({ type: 'job_note', jobId, jobTitle, note: 'no applicants to export' });

          // The five-failure stop is per job, but the cause almost never is: if
          // Wellfound starts refusing signed URLs, every remaining job would
          // fail its own five and stop, and eight jobs would still mean forty
          // failing requests plus eight navigations and page walks - exactly the
          // traffic pattern that stop exists to prevent. Break here, after the
          // ledger and CSV writes above have preserved this job's partial work.
          if (result.stoppedBecause === 'failing') {
            stoppedBecause = 'failing';
            break;
          }

          // The two accept outcomes that end the RUN, not just the role.
          //
          // `unclear` means a message may have gone out and nobody can vouch
          // for it, and the page is degraded at that point almost by
          // definition - that is how a send comes to be unconfirmed. Carrying
          // on navigates the same tab in the same session and starts sending
          // irreversible messages on it. It is the strongest signal this system
          // has, and it was being spent on one role.
          //
          // `unrecorded` means a message demonstrably went out and the ledger
          // could not remember it. The ledger is the only thing that stops the
          // next run messaging somebody twice, so a run that keeps accepting
          // after it has failed is a run manufacturing more of exactly that.
          //
          // Same place as the five-failure stop, and for the same reason: after
          // this job's ledger and CSV writes, so its partial work survives.
          const acceptStop = stop.acceptStoppedBecause;
          if (acceptStop === 'unclear' || acceptStop === 'unrecorded') {
            stoppedBecause = acceptStop;
            break;
          }
        }

        // Pressing Stop used to leave stoppedBecause at 'finished', so a run
        // halted at candidate 90 of 400 reported as a complete export.
        if (signal.aborted && stoppedBecause === 'finished') stoppedBecause = 'aborted';

        // Failures were being counted and then discarded, so a run where every
        // download failed still reported a plain 'done'.
        emit({
          type: 'done',
          ...totals,
          actions,
          config,
          stoppedBecause,
          jobs: jobStops,
          failedNames,
          notWalked: notWalked(),
        });
      } catch (error) {
        // A fatal error used to replace the whole screen, discarding the counts
        // for jobs that had already finished and written files to disk. Emit the
        // totals with the error attached so the panel can show both.
        emit({
          type: 'done',
          ...totals,
          actions,
          // Carried on the failing path too, and that is the whole point: a run
          // that died at role three of four must still say what it set out to do.
          config,
          stoppedBecause: 'error',
          error: String(error.message || error),
          jobs: jobStops,
          failedNames,
          notWalked: notWalked(),
        });
        throw error;
      } finally {
        controller = null;
      }
    },

    // The same walk a run does, with a guest list. It used to be a second run
    // loop: its own paging, its own cursor advance, its own ledger writes, and -
    // the part that mattered - only the short download delay, never a reading
    // break. Four hundred back-to-back paced requests with no long pause is a
    // different traffic rhythm from the one the pacing model was designed for.
    // Delegating to runJob restores the breaks and puts the Apollo node shape
    // back behind normalize.js, where a renamed field fails loudly instead of
    // silently reporting everyone as still missing.
    async redownloadMissing({ jobId, folder }) {
      const signal = takeLock();
      trace.reset();
      trace.record('redownload_start', { jobId });
      try {
        const status = await reconcileJob(jobId);
        const job = await ledgerService.describe(jobId);
        if (status.missing.length === 0) {
          return { refetched: 0, stillMissing: 0, acceptedGone: 0, jobTitle: job.jobTitle };
        }

        // An accepted candidate is not in NEEDS_REVIEW and never will be, so
        // the walk below cannot find them however far it goes: it would page to
        // its cap and then report them missing, which is forty pages of
        // requests spent to arrive at a wrong answer. Checked here, before a
        // single fetch, and said plainly instead.
        const accepted = new Set(
          (await ledgerService.acceptedUserIdsFor(jobId)).map((id) => String(id)),
        );
        const wanted = status.missing.filter((id) => !accepted.has(String(id)));
        const acceptedGone = status.missing.length - wanted.length;
        if (acceptedGone) trace.record('redownload_accepted', { jobId, count: acceptedGone });
        // Nobody left to look for. Opening a tab and walking a page to confirm
        // what the ledger already knows is the pretending-to-work this project
        // does not do.
        if (wanted.length === 0) {
          return { refetched: 0, stillMissing: 0, acceptedGone, jobTitle: job.jobTitle };
        }

        const tab = await tabs.workingTab();
        await tabs.focusJob(tab.id, jobId);
        const dest = folder ?? job.folder ?? 'wellfound-resumes';

        const result = await runJob(
          {
            downloadResume,
            recordDownloaded: (r) =>
              ledgerService.recordDownloaded(jobId, r, { jobTitle: job.jobTitle }),
            fetchPage: (args) => tracedFetch(tab.id, args),
            sleep,
            emit,
          },
          {
            jobId,
            jobTitle: job.jobTitle,
            // Empty, deliberately: everyone wanted here is already in the
            // ledger, and the guest list is what narrows the walk.
            seenUserIds: [],
            only: wanted,
            pageSize: REDOWNLOAD_PAGE_SIZE,
            pageCap: REDOWNLOAD_PAGE_CAP,
            folder: dest,
            // Downloading is the whole point of this walk, and it never
            // accepts anybody: repairing a missing file is not a decision
            // about a candidate.
            actions: runActions({ download: true }),
            limit: wanted.length,
            signal,
            jobIndex: 1,
            jobTotal: 1,
          },
        );

        // Deliberately no 'done' event: the panel treats that as a finished run
        // and re-renders, which would throw the user off the Library screen
        // mid-action. The button reports its own result.
        return {
          refetched: result.downloaded.length,
          stillMissing: result.stillWanted.length,
          acceptedGone,
          failed: result.failed.length,
          noResume: result.skippedNoResume.length,
          pages: result.pages,
          pageCap: REDOWNLOAD_PAGE_CAP,
          stoppedBecause: result.stoppedBecause,
          jobTitle: job.jobTitle,
        };
      } finally {
        controller = null;
      }
    },
  };
}
