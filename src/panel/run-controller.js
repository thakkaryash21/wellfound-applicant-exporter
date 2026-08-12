import { runJob, runActions } from '../lib/runner.js';
import { toCsv, PREVIEW } from '../lib/csv.js';
import { sleep as realSleep } from '../lib/jitter.js';
import { CX } from '../lib/messages.js';
import { createTrace, scrubVariables } from '../lib/trace.js';
import { localDateStamp } from '../lib/local-time.js';
import { consoleSink } from './verbose-console.js';
import { createTabDriver } from './tab-driver.js';
import { createLedgerService } from './ledger-service.js';
import { registerFilenameHandler, downloadResume, downloadBlobText } from './downloader.js';

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
  const tabs = createTabDriver({ trace });
  let controller = null;
  // At most one silent navigation per panel lifetime. A job whose count stays
  // null after hydration (a draft, say) must not send the tab travelling on
  // every single load.
  let hydrated = false;

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
      let jobs = await tabs.ask(tab.id, { type: CX.LIST_JOBS });

      // The job overview page caches every listing but populates
      // actionableApplicantsCount only for the one being viewed. One trip to an
      // applicant list fills in the rest, and the counts are the whole point of
      // the list: without them the panel cannot say how many are new.
      const blank = jobs.find((job) => job.actionableCount == null);
      if (blank && !hydrated && !controller) {
        onHydrating?.();
        try {
          await tabs.focusJob(tab.id, blank.jobId);
          jobs = await tabs.ask(tab.id, { type: CX.LIST_JOBS });
          // Only on success. Set before the try, one failed navigation disabled
          // retry for the whole life of the panel and left those roles reading
          // "applicant count not loaded yet" with no way back.
          hydrated = true;
        } catch {
          // The list is still usable without counts, and a failed navigation is
          // not worth throwing away the jobs we already have.
        }
      }

      return Promise.all(
        jobs.map(async (job) => {
          // `known`, not `downloaded`. The download counter deliberately does
          // not move when a CSV import or an orphan adoption teaches the ledger
          // about people, so estimating from it promised files the run would
          // then correctly refuse to fetch.
          const { known, downloaded } = await ledgerService.describe(job.jobId);
          const estimatedNew =
            job.actionableCount == null ? null : Math.max(0, job.actionableCount - known);
          return { ...job, downloaded, known, estimatedNew };
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

    async startRun({ jobs: requested, folder, pageSize, actions: asked }) {
      const actions = runActions(asked);
      const signal = takeLock();
      trace.reset();
      trace.record('run_start', {
        count: requested.length,
        kind: runKind(actions),
        pageSize,
      });

      const totals = {
        downloaded: 0,
        failed: 0,
        // What a run with downloads off has to report instead of `downloaded`,
        // which is 0 by definition for a preview.
        previewed: 0,
        skippedNoResume: 0,
        skippedNoId: 0,
        masked: 0,
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
          // A job that yielded nothing wrote no CSV and said nothing at all,
          // which reads as a silent failure rather than an empty queue.
          const wrote = await writeCsv(jobId, result.records, folder);
          stop.wroteCsv = wrote;
          trace.record(wrote ? 'csv_write' : 'csv_empty', { jobId, count: result.records.length });
          // The live region only: it is overwritten within seconds by the next
          // event, and the post-run screen replaces the screen entirely. The
          // durable account is `wroteCsv` above, which summary.js reads.
          if (!wrote) emit({ type: 'job_note', jobId, jobTitle, note: 'no applicants to export' });

          // Where the accept pass slots in, when `actions.accept` is set: it
          // drives the applicant reviewer rather than this API walk, so it is a
          // second pass over the same job rather than a branch inside runJob.
          // The driver that performs it is owned elsewhere and is not wired up
          // here yet, so ticking accept currently changes nothing but the trace.

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
        if (status.missing.length === 0) return { refetched: 0, stillMissing: 0 };
        const tab = await tabs.workingTab();
        await tabs.focusJob(tab.id, jobId);
        const job = await ledgerService.describe(jobId);
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
            only: status.missing,
            pageSize: REDOWNLOAD_PAGE_SIZE,
            pageCap: REDOWNLOAD_PAGE_CAP,
            folder: dest,
            // Downloading is the whole point of this walk, and it never
            // accepts anybody: repairing a missing file is not a decision
            // about a candidate.
            actions: runActions({ download: true }),
            limit: status.missing.length,
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
