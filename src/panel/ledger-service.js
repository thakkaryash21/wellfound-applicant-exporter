import { createLedger } from '../lib/ledger.js';
import { reconcile } from '../lib/reconcile.js';
import { userIdsFromCsv } from '../lib/csv.js';
import { filenameRegexForJob } from '../lib/filename.js';

// Everything this extension knows about who has already been fetched, and
// whether their file is still on disk.
//
// It came out of run-controller.js, where it sat beside the run loop for one
// reason: it also needed the ledger. Nothing here takes the run lock, drives
// the working tab or writes to the trace, and nothing here paces itself - the
// Library screen calls all of it while no run is in flight. Splitting it leaves
// run-controller.js owning the tab, the lock and the walk, which is what that
// file is actually about.
//
// It owns the ledger outright rather than sharing one, so there is a single
// module that knows how the ledger is read and written. That is why the run's
// own two writes - recordDownloaded and finishRun - are here too, even though
// the run is what calls them: one owner is worth more than a shorter list.
export function createLedgerService(storage) {
  const ledger = createLedger(storage);

  // What the ledger claims, checked against Chrome's download history. Declared
  // as a closure, not only as a method, so callers may destructure the service
  // without `this` going undefined.
  async function reconcileJob(jobId) {
    const seenUserIds = await ledger.seenUserIds(jobId);
    const items = await chrome.downloads.search({
      filenameRegex: filenameRegexForJob(jobId),
      limit: 0,
    });
    return reconcile({ jobId, seenUserIds, items });
  }

  return {
    reconcileJob,

    seenUserIdsFor: (jobId) => ledger.seenUserIds(jobId),

    describe: (jobId) => ledger.describe(jobId),

    // Written per file, not per job: a run that stops early must not lose
    // credit for resumes already on disk.
    recordDownloaded: (jobId, record, meta) => ledger.markDownloaded(jobId, [record.userId], meta),

    // `folder` is remembered with the run so a later re-download lands beside
    // the originals rather than in whatever default the Library would guess.
    finishRun: (jobId, { folder }) => ledger.finishRun(jobId, { folder }),

    // Every job, with where the ledger and the disk disagree.
    async library() {
      const jobs = await ledger.describeAll();
      const rows = [];
      for (const job of jobs) {
        const status = await reconcileJob(job.jobId);
        rows.push({
          jobId: job.jobId,
          jobTitle: job.jobTitle,
          downloaded: job.downloaded,
          // Everyone the ledger will not re-fetch, including people it learned
          // about from a CSV import or an adoption. After an import of 400,
          // "0 downloaded" alone reads as "the import did nothing".
          known: job.known,
          lastRunAt: job.lastRunAt,
          missing: status.missing.length,
          unverifiable: status.unverifiable.length,
          orphans: status.orphans.length,
        });
      }
      return rows;
    },

    async importCsv(jobId, text) {
      // Only rows whose Resume cell says the file landed. A CSV from a run that
      // hit its limit carries hundreds of "not fetched: the run stopped first"
      // rows, and adopting those would mark people seen who were never fetched -
      // permanently, since nothing ever revisits the ledger.
      const userIds = userIdsFromCsv(text);
      await ledger.adopt(jobId, userIds);
      return { imported: userIds.length };
    },

    // The recovery path for cleared extension storage: files named by this
    // extension are still on disk, so their userIds can be read back out of the
    // download history and returned to the ledger.
    async adoptOrphans(jobId) {
      const status = await reconcileJob(jobId);
      if (status.orphans.length === 0) return { adopted: 0 };
      await ledger.adopt(jobId, status.orphans);
      return { adopted: status.orphans.length };
    },

    forget: (jobId) => ledger.forget(jobId),
  };
}
