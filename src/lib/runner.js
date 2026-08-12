import { normalizeNode } from './normalize.js';
import { diffPage, createEarlyStop } from './dedup.js';
import { PACING, sample, sampleInt } from './jitter.js';
// The Resume column's own vocabulary, and it belongs to the file that
// declares the column. This module used to own these strings and csv.js
// imported upward from it - a run loop owning presentation text, and the
// smallest module in lib/ depending on the largest.
import { RESUME_STATUS, PREVIEW } from './csv.js';

export const MAX_CONSECUTIVE_FAILURES = 5;

export async function runJob(deps, options) {
  const { fetchPage, downloadResume, recordDownloaded, sleep, emit } = deps;
  const rand = deps.rand ?? Math.random;
  const {
    jobId,
    jobTitle,
    seenUserIds,
    pageSize,
    folder,
    limit,
    forceFullWalk,
    dryRun,
    signal,
    jobIndex,
    jobTotal,
    // A re-download is the same walk with a guest list: only these userIds are
    // candidates for a download, and the walk ends as soon as every one of them
    // has been accounted for. Null (the normal run) means everybody.
    only,
    // Only a targeted walk needs this. The people it wants may have left the
    // review bucket entirely, so it cannot rely on hasNextPage to end.
    pageCap = Infinity,
  } = options;

  const seen = new Set(seenUserIds);
  const wanted = only ? new Set(only) : null;
  // A targeted walk starts with an empty `seen`, so no page can ever look fully
  // seen and the streak would never fire anyway. Stated rather than relied upon.
  const earlyStop = createEarlyStop({ forceFullWalk: forceFullWalk || Boolean(wanted) });
  const downloaded = [];
  // One bucket per cause. They used to share a single `skipped` array, which
  // made "we have no resume for them" and "we cannot identify them" the same
  // number - and the remedies are different.
  const skippedNoResume = [];
  const skippedNoId = [];
  const masked = [];
  const failed = [];
  // A previewed candidate used to be counted into nothing at all, so a dry run
  // over 400 applicants ended its summary with "0 downloaded" and no other
  // number anywhere.
  const previewed = [];
  const records = [];
  // Guarantees the unidentifiable are counted once per record per run even if a
  // cursor hands back a page that overlaps one already walked.
  const countedNoId = new Set();

  let after = null;
  let sinceBreak = 0;
  let breakAt = sampleInt(PACING.breakEvery, rand);
  let stoppedBecause = 'exhausted';
  let consecutiveFailures = 0;
  let pageNumber = 0;

  emit({ type: 'started', jobId, jobTitle, jobIndex, jobTotal });

  // Which fields ride on a candidate event, decided once. Seven call sites used
  // to re-list them, so adding a field meant editing seven places and any one
  // of them that was missed changed what reached the trace.
  const emitCandidate = (record, outcome, error) =>
    emit({
      type: 'candidate',
      jobId,
      userId: record.userId,
      name: record.name,
      outcome,
      ...(error === undefined ? {} : { error }),
    });

  while (true) {
    if (signal?.aborted) {
      stoppedBecause = 'aborted';
      break;
    }

    const pageResult = await fetchPage({ jobId, pageSize, after });
    pageNumber += 1;
    const pageRecords = pageResult.edges.map((n) =>
      normalizeNode(n, { jobId, jobTitle: pageResult.jobTitle ?? jobTitle }),
    );
    const { fresh, allSeen } = diffPage(pageRecords, seen);
    records.push(...pageRecords);

    const freshSet = new Set(fresh);
    for (const record of pageRecords) {
      // Anyone already in the ledger keeps their file from an earlier run, so
      // the blank filename cell must not read as a gap.
      if (record.userId && !freshSet.has(record)) record.resumeStatus = RESUME_STATUS.ALREADY;
      // Whatever the loop below does not reach keeps this, so a truncated run
      // says which rows it never got to instead of leaving them blank.
      else if (freshSet.has(record)) record.resumeStatus = RESUME_STATUS.NOT_REACHED;
    }

    // Anyone without a userId cannot be named, deduped or reconciled: their file
    // would be `name--jobId`, which reconciliation can never match and
    // re-download can never repair. Refuse the download and say so. They still
    // reach the CSV, which is the only place they can be acted on.
    // Skipped entirely on a targeted walk: a record with no userId cannot be on
    // the guest list, and reporting every anonymous applicant on forty pages
    // would bury the handful of people the walk is actually there to repair.
    for (const record of wanted ? [] : pageRecords) {
      if (record.userId) continue;
      // Records are fresh objects per page, so identity already counts each one
      // once; the applicantId guard is what catches a cursor handing back a page
      // that overlaps one already walked.
      if (record.applicantId) {
        if (countedNoId.has(record.applicantId)) continue;
        countedNoId.add(record.applicantId);
      }
      // A concealed candidate is not a broken record: the recruiter can unlock
      // them in Wellfound and run again. Saying "no id" hides that remedy.
      if (record.masked) {
        record.resumeStatus = RESUME_STATUS.LOCKED;
        masked.push(record);
        emitCandidate(record, 'masked');
      } else {
        record.resumeStatus = RESUME_STATUS.NO_ID;
        skippedNoId.push(record);
        emitCandidate(record, 'no-id');
      }
    }

    earlyStop.observe(allSeen);
    emit({
      type: 'page',
      jobId,
      page: pageNumber,
      bucket: pageResult.bucket ?? null,
      fetched: pageRecords.length,
      fresh: fresh.length,
    });

    const targets = wanted ? fresh.filter((r) => wanted.has(r.userId)) : fresh;

    for (const record of targets) {
      if (signal?.aborted) {
        stoppedBecause = 'aborted';
        break;
      }
      // A preview counts into `previewed`, never into `downloaded`, so gating on
      // `downloaded` alone meant a dry run could never reach its limit: it
      // walked all forty pages of a 400-applicant role that the real run would
      // have stopped at 25. The two buckets are mutually exclusive - a candidate
      // lands in exactly one - so their sum is "how many of the limit this walk
      // has spent", and a real run's arithmetic is unchanged.
      if (downloaded.length + previewed.length >= limit) {
        stoppedBecause = 'limit';
        break;
      }

      // diffPage judged the page against `seen` as it stood at the top of the
      // page. Now that the key is userId, one person can hold two rows on the
      // same page, so re-check before spending a download on them.
      if (seen.has(record.userId)) {
        record.resumeStatus = RESUME_STATUS.ALREADY;
        continue;
      }
      seen.add(record.userId);
      // Struck off the guest list the moment the walk reaches them, whatever the
      // outcome below. Someone found but unfetchable is still found, and leaving
      // them on the list would keep the walk paging for a person it has already
      // seen - more traffic, for nothing.
      wanted?.delete(record.userId);

      // A masked candidate can carry a userId and still have nothing to fetch.
      // Branching on `masked` rather than on the missing id means this holds
      // either way round.
      if (record.masked && !record.resumeUrl) {
        record.resumeStatus = RESUME_STATUS.LOCKED;
        masked.push(record);
        emitCandidate(record, 'masked');
        continue;
      }

      if (!record.resumeUrl) {
        record.resumeStatus = RESUME_STATUS.NO_RESUME;
        skippedNoResume.push(record);
        emitCandidate(record, 'skipped');
        continue;
      }

      if (dryRun) {
        record.resumeStatus = RESUME_STATUS.PREVIEW;
        previewed.push(record);
        emitCandidate(record, PREVIEW);
        continue;
      }

      try {
        const result = await downloadResume({
          url: record.resumeUrl,
          name: record.name,
          userId: record.userId,
          jobId,
          folder,
        });
        // The record is the same object the CSV writes, so naming the file here
        // is what puts it in the Resume Filename column.
        record.resumeFilename = result?.filename ?? null;
        record.resumeStatus = RESUME_STATUS.DOWNLOADED;
        // Record before anything else can interrupt: a file on disk that the
        // ledger does not know about gets fetched again on the next run.
        await recordDownloaded(record);
        downloaded.push(record);
        emitCandidate(record, 'downloaded');
        consecutiveFailures = 0;
      } catch (error) {
        const message = String(error.message || error);
        record.resumeStatus = `failed: ${message}`;
        failed.push(record);
        consecutiveFailures += 1;
        emitCandidate(record, 'failed', message);
        // If Wellfound starts refusing signed URLs, continuing means issuing
        // hundreds of failing requests at human pacing - the most suspicious
        // pattern this extension could produce - and then reporting success.
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stoppedBecause = 'failing';
          // Deliberately not 'error': that type is the panel's fatal screen, and
          // this run continues on to the next job.
          emit({
            type: 'job_error',
            jobId,
            error: `Stopped after ${consecutiveFailures} downloads failed in a row`,
          });
          break;
        }
      }

      sinceBreak += 1;
      if (sinceBreak >= breakAt) {
        const breakMs = sample(PACING.breakMs[0], PACING.breakMs[1], rand);
        emit({ type: 'break', jobId, ms: breakMs });
        await sleep(breakMs, signal);
        sinceBreak = 0;
        breakAt = sampleInt(PACING.breakEvery, rand);
      } else {
        const restMs = sample(PACING.downloadMs[0], PACING.downloadMs[1], rand);
        emit({ type: 'resting', jobId, ms: restMs });
        await sleep(restMs, signal);
      }
    }

    if (stoppedBecause !== 'exhausted') break;
    if (wanted && wanted.size === 0) {
      stoppedBecause = 'found';
      break;
    }
    if (earlyStop.shouldStop()) {
      stoppedBecause = 'early-stop';
      break;
    }
    if (!pageResult.hasNextPage) break;
    if (pageNumber >= pageCap) {
      stoppedBecause = 'capped';
      break;
    }

    after = pageResult.endCursor;
    const pageMs = sample(PACING.pageMs[0], PACING.pageMs[1], rand);
    emit({ type: 'resting', jobId, ms: pageMs });
    await sleep(pageMs, signal);
  }

  // Kept as one array so callers that only want "how many did we not fetch"
  // still have it, while the causes stay separable.
  const skipped = [...skippedNoResume, ...skippedNoId];

  emit({
    type: 'job_done',
    jobId,
    jobTitle,
    downloaded: downloaded.length,
    pages: pageNumber,
    stoppedBecause,
  });
  return {
    downloaded,
    skipped,
    skippedNoResume,
    skippedNoId,
    masked,
    failed,
    previewed,
    records,
    pages: pageNumber,
    stoppedBecause,
    // Everyone on the guest list the walk never reached. Empty for a normal run.
    stillWanted: wanted ? [...wanted] : [],
  };
}
