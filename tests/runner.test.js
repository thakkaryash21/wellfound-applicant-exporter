import { describe, it, expect, vi } from 'vitest';
import { runJob, needsFullWalk, MAX_CONSECUTIVE_FAILURES } from '../src/lib/runner.js';
import { RESUME_STATUS } from '../src/lib/csv.js';

// Wellfound's shapes, not ours. submittedAt is a number (Unix seconds) and
// currentLocation is an object; both were confirmed live, and both used to be
// pre-flattened here, which meant the whole end-to-end suite drove code paths
// production never takes. userId is left as the raw number the id counter
// produces, so every walk below runs through normalize.js's String() coercion -
// the one that makes `seen.has(record.userId)` match on a re-run. nodeFor()
// further down passes a string userId, so both shapes are covered.
function node(id) {
  return {
    id: `JP${id}`,
    currentApplication: { submittedAt: 1786465883 },
    recruitCandidate: {
      masked: false,
      candidate: {
        userId: id,
        name: `Person ${id}`,
        currentLocation: {
          __typename: 'Location',
          id: `L${id}`,
          name: 'Berlin',
          country: 'Germany',
          state: null,
        },
        // Relative, as Wellfound actually sends it. normalize.js makes it absolute.
        resumeUrl: `/link/${id}/tok/resume_url`,
      },
    },
  };
}

function pager(pages) {
  let call = 0;
  return vi.fn(async () => {
    const page = pages[call] ?? { edges: [], endCursor: null, hasNextPage: false };
    call += 1;
    return page;
  });
}

const page = (ids, hasNextPage = true) => ({
  edges: ids.map(node),
  endCursor: `cursor-${ids[0] ?? 'end'}`,
  hasNextPage,
  jobTitle: 'Backend Engineer',
});

function deps(overrides = {}) {
  return {
    fetchPage: pager([page([1, 2], false)]),
    downloadResume: vi.fn(async () => ({ filename: 'x.pdf' })),
    recordDownloaded: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    emit: vi.fn(),
    ...overrides,
  };
}

// Neither action: the CSV and nothing else. Named once so every preview test
// says the same thing.
const PREVIEW_ONLY = { download: false, accept: false };

const options = {
  jobId: '9100001',
  jobTitle: 'Backend Engineer',
  seenUserIds: [],
  pageSize: 10,
  folder: 'wellfound-resumes',
  limit: 250,
  forceFullWalk: false,
  actions: { download: true, accept: false },
};

describe('runJob', () => {
  it('downloads every fresh applicant exactly once', async () => {
    const d = deps();
    const out = await runJob(d, options);
    expect(d.downloadResume).toHaveBeenCalledTimes(2);
    expect(out.downloaded.map((r) => r.userId)).toEqual(['1', '2']);
    expect(out.stoppedBecause).toBe('exhausted');
  });

  it('returns a complete identity snapshot only after exhausting one review bucket', async () => {
    const first = { ...page([1, 2]), bucket: 'NEEDS_REVIEW' };
    const last = { ...page([2, 3], false), bucket: 'NEEDS_REVIEW' };
    const out = await runJob(deps({ fetchPage: pager([first, last]) }), {
      ...options,
      forceFullWalk: true,
    });

    expect(out.snapshot).toMatchObject({
      jobId: '9100001',
      bucket: 'NEEDS_REVIEW',
      complete: true,
      userIds: ['1', '2', '3'],
      unidentified: 0,
    });
    expect(out.snapshot.scannedAt).toEqual(expect.any(String));
  });

  it('does not authorize a snapshot when any page omits bucket evidence', async () => {
    const first = { ...page([1, 2]), bucket: 'NEEDS_REVIEW' };
    const last = { ...page([3], false), bucket: null };
    const out = await runJob(deps({ fetchPage: pager([first, last]) }), {
      ...options,
      actions: { download: false, accept: true },
    });
    expect(out.snapshot).toMatchObject({ complete: false, bucket: null, scannedAt: null });
  });

  // C3: these three fields used to arrive at runJob already in the shape our own
  // code produces, so no end-to-end test here ever crossed normalize.js's
  // coercions. The fixture now sends what Wellfound sends; this asserts what
  // comes out the other side.
  it('normalizes Wellfound raw shapes into the record the CSV and ledger use', async () => {
    const out = await runJob(deps(), options);
    const [first] = out.records;
    expect(first.userId).toBe('1');
    expect(typeof first.userId).toBe('string');
    expect(first.location).toBe('Berlin');
    expect(first.submittedAt).toBe(1786465883);
    expect(first.resumeUrl).toBe('https://wellfound.com/link/1/tok/resume_url');
  });

  // The ledger stores strings. Wellfound may send a number. If the coercion
  // above ever goes, this walk re-downloads a person it has already got.
  it('recognises a ledger id as already seen when the node sends it as a number', async () => {
    const d = deps();
    const out = await runJob(d, { ...options, seenUserIds: ['1', '2'] });
    expect(d.downloadResume).not.toHaveBeenCalled();
    expect(out.downloaded).toEqual([]);
  });

  it('skips applicants already in the ledger', async () => {
    const d = deps();
    const out = await runJob(d, { ...options, seenUserIds: ['1'] });
    expect(d.downloadResume).toHaveBeenCalledTimes(1);
    expect(out.downloaded.map((r) => r.userId)).toEqual(['2']);
  });

  it('follows the cursor across pages', async () => {
    const d = deps({ fetchPage: pager([page([1, 2]), page([3, 4], false)]) });
    await runJob(d, options);
    expect(d.fetchPage).toHaveBeenNthCalledWith(1, { jobId: '9100001', pageSize: 10, after: null });
    expect(d.fetchPage).toHaveBeenNthCalledWith(2, {
      jobId: '9100001',
      pageSize: 10,
      after: 'cursor-1',
    });
  });

  it('stops after three consecutive fully-seen pages', async () => {
    const d = deps({
      fetchPage: pager([page([1]), page([2]), page([3]), page([4]), page([5])]),
    });
    const out = await runJob(d, { ...options, seenUserIds: ['1', '2', '3', '4', '5'] });
    expect(d.fetchPage).toHaveBeenCalledTimes(3);
    expect(out.stoppedBecause).toBe('early-stop');
  });

  it('walks past fully-seen pages when forceFullWalk is set', async () => {
    const d = deps({
      fetchPage: pager([page([1]), page([2]), page([3]), page([4], false)]),
    });
    const out = await runJob(d, {
      ...options,
      forceFullWalk: true,
      seenUserIds: ['1', '2', '3', '4'],
    });
    expect(d.fetchPage).toHaveBeenCalledTimes(4);
    expect(out.stoppedBecause).toBe('exhausted');
  });

  // The early stop is an economy for a download run. An ACCEPTING run decides
  // who to message from the rows this walk produced, and the operator's main
  // workflow - accept everyone already downloaded - makes every page all-seen
  // by construction. Under the old rule the streak fired on page 3, the walk
  // returned a fifth of the role, and the run accepted a fifth of the number
  // the confirm screen had promised, reporting success.
  it('reads every page when the run is accepting, however many are already seen', async () => {
    const d = deps({
      fetchPage: pager([page([1]), page([2]), page([3]), page([4]), page([5], false)]),
    });
    const out = await runJob(d, {
      ...options,
      actions: { download: false, accept: true },
      seenUserIds: ['1', '2', '3', '4', '5'],
    });
    expect(d.fetchPage).toHaveBeenCalledTimes(5);
    expect(out.stoppedBecause).toBe('exhausted');
    // All five reach the accept pass, which can only act on the rows it is
    // handed. Four of them are the ones the old walk never fetched.
    expect(out.records.map((r) => r.userId)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('honours the per-run limit', async () => {
    const d = deps({ fetchPage: pager([page([1, 2, 3, 4, 5])]) });
    const out = await runJob(d, { ...options, limit: 2 });
    expect(d.downloadResume).toHaveBeenCalledTimes(2);
    expect(out.limitReached).toBe(true);
  });

  // The limit rations downloads. It used to ration pagination too, and a walk
  // that stopped paging cannot say who is in the review queue - so a role set to
  // "first 2" could never publish an exact count on Home, for ever.
  it('reads the whole queue after the limit is spent, so the snapshot still counts', async () => {
    const pages = [
      { ...page([1, 2, 3]), bucket: 'NEEDS_REVIEW' },
      { ...page([4, 5], false), bucket: 'NEEDS_REVIEW' },
    ];
    const d = deps({ fetchPage: pager(pages) });
    const out = await runJob(d, { ...options, limit: 2 });

    expect(d.downloadResume).toHaveBeenCalledTimes(2);
    expect(d.fetchPage).toHaveBeenCalledTimes(2);
    expect(out.snapshot.complete).toBe(true);
    expect(out.snapshot.userIds).toEqual(['1', '2', '3', '4', '5']);
    expect(out.stoppedBecause).toBe('exhausted');
    expect(out.limitReached).toBe(true);
  });

  it('does not claim a limit was reached when the role had fewer people than that', async () => {
    const d = deps({ fetchPage: pager([page([1, 2], false)]) });
    const out = await runJob(d, { ...options, limit: 25 });
    expect(out.limitReached).toBe(false);
  });

  it('keeps scanning after a combined run reaches its download limit', async () => {
    const pages = [
      { ...page([1, 2, 3]), bucket: 'NEEDS_REVIEW' },
      { ...page([4, 5], false), bucket: 'NEEDS_REVIEW' },
    ];
    const d = deps({ fetchPage: pager(pages) });
    const out = await runJob(d, {
      ...options,
      limit: 2,
      actions: { download: true, accept: true },
    });

    expect(out.downloaded.map((record) => record.userId)).toEqual(['1', '2']);
    expect(out.records.map((record) => record.userId)).toEqual(['1', '2', '3', '4', '5']);
    expect(out.snapshot.complete).toBe(true);
    expect(out.stoppedBecause).toBe('exhausted');
  });

  // C2: `previewed` is a preview's `downloaded`, and gating the limit on
  // `downloaded` alone let a preview walk every page of a role the real run
  // would have stopped 375 people earlier. Three screens then showed three
  // different numbers and none of them was what a real run would do.
  describe('the limit a run with downloads off has to honour too', () => {
    it('stops a preview at the same number a real run would stop at', async () => {
      const d = deps({ fetchPage: pager([page([1, 2, 3, 4, 5])]) });
      const out = await runJob(d, { ...options, limit: 2, actions: PREVIEW_ONLY });
      expect(out.previewed).toHaveLength(2);
      expect(out.limitReached).toBe(true);
    });

    it('previews exactly the number the real run downloads, for the same limit', async () => {
      const pages = () => [page([1, 2, 3, 4, 5], true), page([6, 7, 8, 9, 10], false)];
      const live = await runJob(deps({ fetchPage: pager(pages()) }), { ...options, limit: 3 });
      const preview = await runJob(deps({ fetchPage: pager(pages()) }), {
        ...options,
        limit: 3,
        actions: PREVIEW_ONLY,
      });
      expect(preview.previewed).toHaveLength(live.downloaded.length);
      expect(preview.previewed.map((r) => r.userId)).toEqual(live.downloaded.map((r) => r.userId));
      expect(preview.stoppedBecause).toBe(live.stoppedBecause);
    });

    // Accept-only is different from a plain preview: fresh rows are ineligible,
    // while ledger-known rows later in the queue are exactly who the pass is
    // trying to find. The acceptance limit belongs to pass 2, after that filter.
    it('walks past fresh previews to find already-downloaded candidates', async () => {
      const d = deps({ fetchPage: pager([page([1, 2, 3]), page([4, 5, 6], false)]) });
      const out = await runJob(d, {
        ...options,
        limit: 2,
        actions: { download: false, accept: true },
        seenUserIds: ['4', '5'],
      });
      expect(out.previewed.map((record) => record.userId)).toEqual(['1', '2', '3', '6']);
      expect(out.downloaded).toHaveLength(0);
      expect(out.records.filter((record) => record.resumeStatus === RESUME_STATUS.ALREADY))
        .toHaveLength(2);
      expect(out.stoppedBecause).toBe('exhausted');
      expect(d.fetchPage).toHaveBeenCalledTimes(2);
    });

    // It used to stop paging here, and that is exactly the truncation that made
    // an exact count unreachable for a limited role. The preview still previews
    // the number the real run would fetch; it just finishes reading first.
    it('keeps paging once a preview has met the limit, without previewing more', async () => {
      const d = deps({ fetchPage: pager([page([1, 2, 3]), page([4, 5, 6]), page([7, 8], false)]) });
      const out = await runJob(d, { ...options, limit: 2, actions: PREVIEW_ONLY });
      expect(d.fetchPage).toHaveBeenCalledTimes(3);
      expect(out.previewed).toHaveLength(2);
    });

    it('leaves an unlimited preview free to list everybody', async () => {
      const d = deps({ fetchPage: pager([page([1, 2, 3, 4, 5], false)]) });
      const out = await runJob(d, { ...options, limit: Infinity, actions: PREVIEW_ONLY });
      expect(out.previewed).toHaveLength(5);
      expect(out.stoppedBecause).toBe('exhausted');
    });

    it('does not count a previewed candidate against a live run limit', async () => {
      const d = deps({ fetchPage: pager([page([1, 2, 3], false)]) });
      const out = await runJob(d, { ...options, limit: 3, actions: { download: true, accept: false } });
      expect(out.downloaded).toHaveLength(3);
      expect(out.previewed).toHaveLength(0);
      expect(out.stoppedBecause).toBe('exhausted');
    });
  });

  it('records applicants without a resume as skipped, not failed', async () => {
    const noResume = node(1);
    noResume.recruitCandidate.candidate.resumeUrl = null;
    const d = deps({
      fetchPage: pager([{ edges: [noResume], endCursor: 'c', hasNextPage: false }]),
    });
    const out = await runJob(d, options);
    expect(d.downloadResume).not.toHaveBeenCalled();
    expect(out.skipped).toHaveLength(1);
    expect(out.downloaded).toHaveLength(0);
  });

  it('records each download as it lands, not once at the end', async () => {
    const order = [];
    const d = deps({
      downloadResume: vi.fn(async () => {
        order.push('download');
        return { filename: 'x.pdf' };
      }),
      recordDownloaded: vi.fn(async () => {
        order.push('record');
      }),
    });
    await runJob(d, options);
    expect(d.recordDownloaded).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['download', 'record', 'download', 'record']);
  });

  it('does not record an applicant whose download failed', async () => {
    const d = deps({
      downloadResume: vi
        .fn()
        .mockRejectedValueOnce(new Error('interrupted'))
        .mockResolvedValueOnce({ filename: 'ok.pdf' }),
    });
    await runJob(d, options);
    expect(d.recordDownloaded).toHaveBeenCalledTimes(1);
    expect(d.recordDownloaded.mock.calls[0][0].userId).toBe('2');
  });

  it('records nothing in preview mode', async () => {
    const d = deps();
    await runJob(d, { ...options, actions: PREVIEW_ONLY });
    expect(d.recordDownloaded).not.toHaveBeenCalled();
  });

  it('keeps a failed download out of downloaded so it retries next run', async () => {
    const d = deps({
      downloadResume: vi
        .fn()
        .mockRejectedValueOnce(new Error('interrupted'))
        .mockResolvedValueOnce({ filename: 'ok.pdf' }),
    });
    const out = await runJob(d, options);
    expect(out.failed.map((r) => r.userId)).toEqual(['1']);
    expect(out.downloaded.map((r) => r.userId)).toEqual(['2']);
  });

  it('writes the landed filename onto the record so the CSV column is filled', async () => {
    const d = deps({
      fetchPage: pager([page([1], false)]),
      downloadResume: vi.fn(async () => ({ filename: 'C:/dl/Person 1-1-9100001.pdf' })),
    });
    const out = await runJob(d, options);
    expect(out.records[0].resumeFilename).toBe('C:/dl/Person 1-1-9100001.pdf');
  });

  it('emits every applicant into the CSV record set, downloaded or not', async () => {
    const noResume = node(2);
    noResume.recruitCandidate.candidate.resumeUrl = null;
    const d = deps({
      fetchPage: pager([{ edges: [node(1), noResume], endCursor: 'c', hasNextPage: false }]),
    });
    const out = await runJob(d, options);
    expect(out.records).toHaveLength(2);
  });

  // Counted into no array at all, a preview had nothing to report but
  // "0 downloaded".
  it('counts what a preview listed, so the summary has a number to say', async () => {
    const d = deps();
    const out = await runJob(d, { ...options, actions: PREVIEW_ONLY });
    expect(out.previewed).toHaveLength(2);
    expect(out.downloaded).toHaveLength(0);
  });

  it('aborts the whole run when a page fetch throws', async () => {
    const d = deps({ fetchPage: vi.fn(async () => { throw new Error('429 Too Many Requests'); }) });
    await expect(runJob(d, options)).rejects.toThrow('429');
    expect(d.downloadResume).not.toHaveBeenCalled();
  });

  it('stops promptly when the abort signal fires', async () => {
    const controller = new AbortController();
    const d = deps({
      fetchPage: pager([page([1, 2]), page([3, 4])]),
      downloadResume: vi.fn(async () => {
        controller.abort();
        return { filename: 'x.pdf' };
      }),
    });
    const out = await runJob(d, { ...options, signal: controller.signal });
    expect(out.stoppedBecause).toBe('aborted');
    expect(d.downloadResume).toHaveBeenCalledTimes(1);
  });

  it('sleeps between downloads and between pages', async () => {
    const d = deps({ fetchPage: pager([page([1, 2]), page([3], false)]) });
    await runJob(d, options);
    expect(d.sleep.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const [ms] of d.sleep.mock.calls) expect(ms).toBeGreaterThan(0);
  });

  it('stops the run after five downloads fail in a row', async () => {
    const d = deps({
      fetchPage: pager([page([1, 2, 3, 4, 5, 6, 7, 8], false)]),
      downloadResume: vi.fn(async () => {
        throw new Error('403 Forbidden');
      }),
    });
    const out = await runJob(d, options);
    expect(d.downloadResume).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
    expect(out.stoppedBecause).toBe('failing');
    const failure = d.emit.mock.calls.map(([e]) => e).find((e) => e.type === 'job_error');
    expect(failure.error).toContain(String(MAX_CONSECUTIVE_FAILURES));
  });

  it('does not stop when failures are broken up by a success', async () => {
    let call = 0;
    const d = deps({
      fetchPage: pager([page([1, 2, 3, 4, 5, 6, 7, 8], false)]),
      downloadResume: vi.fn(async () => {
        call += 1;
        if (call % 3 === 0) return { filename: 'ok.pdf' };
        throw new Error('flaky');
      }),
    });
    const out = await runJob(d, options);
    expect(d.downloadResume).toHaveBeenCalledTimes(8);
    expect(out.stoppedBecause).toBe('exhausted');
  });

  it('refuses to download a candidate with no userId and reports them', async () => {
    const nameless = node(1);
    nameless.recruitCandidate.candidate.userId = null;
    const d = deps({
      fetchPage: pager([{ edges: [nameless, node(2)], endCursor: 'c', hasNextPage: false }]),
    });
    const out = await runJob(d, options);
    expect(d.downloadResume).toHaveBeenCalledTimes(1);
    expect(out.downloaded.map((r) => r.userId)).toEqual(['2']);
    expect(out.skipped.map((r) => r.name)).toEqual(['Person 1']);
    const outcomes = d.emit.mock.calls.map(([e]) => e.outcome);
    expect(outcomes).toContain('no-id');
  });

  // The shared node() fixture derives userId from the same counter as the
  // applicant id, so it cannot produce two rows for one person. Under a userId
  // key that shape is real: one candidate can hold two applications on the same
  // page, and diffPage judged the page against `seen` as it stood before the
  // page was walked, so both rows arrive in `fresh`.
  function nodeFor(applicantNumber, userId) {
    const n = node(applicantNumber);
    n.recruitCandidate.candidate.userId = String(userId);
    n.recruitCandidate.candidate.name = `Person ${userId}`;
    return n;
  }

  // The one that must fail if anybody ever disconnects accepting from the full
  // walk again. It asserts the RELATIONSHIP rather than a symptom, so a change
  // that keeps the walk complete by some other means still has to say so here.
  describe('needsFullWalk', () => {
    it('is true for every accepting run, whatever else it was asked to do', () => {
      expect(needsFullWalk({ actions: { download: false, accept: true } })).toBe(true);
      expect(needsFullWalk({ actions: { download: true, accept: true } })).toBe(true);
    });

    it('leaves a run that is not accepting free to stop early', () => {
      expect(needsFullWalk({ actions: { download: true, accept: false } })).toBe(false);
      // The default, spelled out: `accept` is opt-in at every layer.
      expect(needsFullWalk({})).toBe(false);
    });

    it('still honours the operator s own re-read, and a targeted walk', () => {
      expect(needsFullWalk({ forceFullWalk: true })).toBe(true);
      expect(needsFullWalk({ only: ['7'] })).toBe(true);
    });
  });

  it('downloads one person once when they hold two rows on the same page', async () => {
    const d = deps({
      fetchPage: pager([
        { edges: [nodeFor(1, 7), nodeFor(2, 7)], endCursor: 'c', hasNextPage: false },
      ]),
    });
    const out = await runJob(d, options);
    expect(d.downloadResume).toHaveBeenCalledTimes(1);
    expect(d.recordDownloaded).toHaveBeenCalledTimes(1);
    expect(out.downloaded.map((r) => r.userId)).toEqual(['7']);
    // Both rows still reach the CSV: they are two real applications.
    expect(out.records).toHaveLength(2);
    // The second row is a pointer, not an outcome. It must never read as
    // "already downloaded", which is this walk's word for a file the LEDGER
    // already held - the one status the accept pass treats as proof we have
    // somebody's resume.
    expect(out.records[1].resumeStatus).toBe(RESUME_STATUS.ANOTHER_ROW);
    expect(out.records[1].resumeStatus).not.toBe(RESUME_STATUS.ALREADY);
  });

  // The case the whole ALREADY split exists for. One person, two applications,
  // and the download for the row that was actually attempted fails. Under the
  // old single word the second row read `already downloaded`, the accept pass
  // read that as "we hold their resume", and it sent them a message - which
  // removes them from NEEDS_REVIEW, so the retryable failure became a resume
  // lost for good.
  it('does not stamp the second row already downloaded when the first row s download failed', async () => {
    const d = deps({
      fetchPage: pager([
        { edges: [nodeFor(1, 7), nodeFor(2, 7)], endCursor: 'c', hasNextPage: false },
      ]),
      downloadResume: vi.fn(async () => {
        throw new Error('NETWORK_FAILED');
      }),
    });
    const out = await runJob(d, options);

    expect(out.failed.map((r) => r.userId)).toEqual(['7']);
    expect(out.records.map((r) => r.resumeStatus)).toEqual([
      'failed: NETWORK_FAILED',
      RESUME_STATUS.ANOTHER_ROW,
    ]);
    // Nothing anywhere in this walk's output claims a file for person 7.
    expect(out.records.some((r) => r.resumeStatus === RESUME_STATUS.ALREADY)).toBe(false);
  });

  it('still says already downloaded for the second row when the ledger held them all along', async () => {
    const d = deps({
      fetchPage: pager([
        { edges: [nodeFor(1, 7), nodeFor(2, 7)], endCursor: 'c', hasNextPage: false },
      ]),
    });
    const out = await runJob(d, { ...options, seenUserIds: ['7'] });
    // Both rows: the file is on disk from an earlier run, and that is true of
    // the person, so it is true of every row they hold.
    expect(out.records.map((r) => r.resumeStatus)).toEqual([
      RESUME_STATUS.ALREADY,
      RESUME_STATUS.ALREADY,
    ]);
    expect(d.downloadResume).not.toHaveBeenCalled();
  });

  it('names the job position on started so the running screen can label itself', async () => {
    const d = deps();
    await runJob(d, { ...options, jobIndex: 2, jobTotal: 5 });
    const started = d.emit.mock.calls.map(([e]) => e).find((e) => e.type === 'started');
    expect(started).toMatchObject({ jobTitle: 'Backend Engineer', jobIndex: 2, jobTotal: 5 });
  });

  it('numbers pages on the page event so a walk over known pages is visible', async () => {
    const d = deps({ fetchPage: pager([page([1]), page([2], false)]) });
    await runJob(d, options);
    const pages = d.emit.mock.calls.map(([e]) => e).filter((e) => e.type === 'page');
    expect(pages.map((e) => e.page)).toEqual([1, 2]);
    expect(pages[0]).toMatchObject({ fetched: 1, fresh: 1 });
  });

  // T6: the Resume column. A blank Resume Filename must never be ambiguous.
  describe('resumeStatus', () => {
    it('marks a landed file downloaded', async () => {
      const d = deps({ fetchPage: pager([page([1], false)]) });
      const out = await runJob(d, options);
      expect(out.records[0].resumeStatus).toBe(RESUME_STATUS.DOWNLOADED);
    });

    it('marks a record already in the ledger as already downloaded', async () => {
      const d = deps({ fetchPage: pager([page([1], false)]) });
      const out = await runJob(d, { ...options, seenUserIds: ['1'] });
      expect(out.records[0].resumeStatus).toBe(RESUME_STATUS.ALREADY);
    });

    it('marks a candidate with no resume rather than leaving the cell blank', async () => {
      const noResume = node(1);
      noResume.recruitCandidate.candidate.resumeUrl = null;
      const d = deps({
        fetchPage: pager([{ edges: [noResume], endCursor: 'c', hasNextPage: false }]),
      });
      const out = await runJob(d, options);
      expect(out.records[0].resumeStatus).toBe(RESUME_STATUS.NO_RESUME);
    });

    it('carries the failure message into the Resume column', async () => {
      const d = deps({
        fetchPage: pager([page([1], false)]),
        downloadResume: vi.fn(async () => {
          throw new Error('403 Forbidden');
        }),
      });
      const out = await runJob(d, options);
      expect(out.records[0].resumeStatus).toBe('failed: 403 Forbidden');
    });

    it('marks previewed rows as previewed, not as missing resumes', async () => {
      const d = deps({ fetchPage: pager([page([1], false)]) });
      const out = await runJob(d, { ...options, actions: PREVIEW_ONLY });
      expect(out.records[0].resumeStatus).toBe(RESUME_STATUS.PREVIEW);
    });

    it('marks an unidentifiable record as not identifiable', async () => {
      const nameless = node(1);
      nameless.recruitCandidate.candidate.userId = null;
      const d = deps({
        fetchPage: pager([{ edges: [nameless], endCursor: 'c', hasNextPage: false }]),
      });
      const out = await runJob(d, options);
      expect(out.records[0].resumeStatus).toBe(RESUME_STATUS.NO_ID);
    });

    it('says a row was never reached when the limit cut the run short', async () => {
      const d = deps({ fetchPage: pager([page([1, 2, 3], false)]) });
      const out = await runJob(d, { ...options, limit: 1 });
      expect(out.records[0].resumeStatus).toBe(RESUME_STATUS.DOWNLOADED);
      expect(out.records[1].resumeStatus).toBe(RESUME_STATUS.NOT_REACHED);
      expect(out.records[2].resumeStatus).toBe(RESUME_STATUS.NOT_REACHED);
    });
  });

  // T11: two causes that shared one number and needed different remedies.
  describe('skip causes', () => {
    it('separates no-resume from no-id and keeps the combined array', async () => {
      const noResume = node(1);
      noResume.recruitCandidate.candidate.resumeUrl = null;
      const nameless = node(2);
      nameless.recruitCandidate.candidate.userId = null;
      const d = deps({
        fetchPage: pager([{ edges: [noResume, nameless], endCursor: 'c', hasNextPage: false }]),
      });
      const out = await runJob(d, options);
      expect(out.skippedNoResume.map((r) => r.name)).toEqual(['Person 1']);
      expect(out.skippedNoId.map((r) => r.name)).toEqual(['Person 2']);
      expect(out.skipped).toHaveLength(2);
    });

    it('counts an unidentifiable record once even if a page is walked twice', async () => {
      const nameless = () => {
        const n = node(1);
        n.recruitCandidate.candidate.userId = null;
        return n;
      };
      const d = deps({
        fetchPage: pager([
          { edges: [nameless()], endCursor: 'c', hasNextPage: true },
          { edges: [nameless()], endCursor: 'c2', hasNextPage: false },
        ]),
      });
      const out = await runJob(d, options);
      expect(out.skippedNoId).toHaveLength(1);
    });
  });

  // T12: masked was computed and never read.
  describe('masked candidates', () => {
    it('reports a masked candidate as masked rather than as no-id', async () => {
      const hidden = node(1);
      hidden.recruitCandidate.masked = true;
      hidden.recruitCandidate.candidate.userId = null;
      const d = deps({
        fetchPage: pager([{ edges: [hidden], endCursor: 'c', hasNextPage: false }]),
      });
      const out = await runJob(d, options);
      expect(out.masked.map((r) => r.name)).toEqual(['Person 1']);
      expect(out.skippedNoId).toHaveLength(0);
      expect(out.records[0].resumeStatus).toBe(RESUME_STATUS.LOCKED);
      expect(d.emit.mock.calls.map(([e]) => e.outcome)).toContain('masked');
    });

    // The assumption that masked implies no userId is not verified against a
    // live response, so the branch must hold when the id IS present.
    it('reports a masked candidate that does carry a userId', async () => {
      const hidden = node(1);
      hidden.recruitCandidate.masked = true;
      hidden.recruitCandidate.candidate.resumeUrl = null;
      const d = deps({
        fetchPage: pager([{ edges: [hidden], endCursor: 'c', hasNextPage: false }]),
      });
      const out = await runJob(d, options);
      expect(out.masked.map((r) => r.name)).toEqual(['Person 1']);
      expect(out.skippedNoResume).toHaveLength(0);
      expect(out.records[0].resumeStatus).toBe(RESUME_STATUS.LOCKED);
    });

    it('still downloads a masked candidate whose resume is readable', async () => {
      const hidden = node(1);
      hidden.recruitCandidate.masked = true;
      const d = deps({
        fetchPage: pager([{ edges: [hidden], endCursor: 'c', hasNextPage: false }]),
      });
      const out = await runJob(d, options);
      expect(out.downloaded).toHaveLength(1);
      expect(out.masked).toHaveLength(0);
    });
  });
});

// The targeted walk a re-download uses. It used to be a second, hand-written
// loop in the run controller with no reading breaks and its own copy of the
// Apollo node shape.
describe('runJob with a guest list (only)', () => {
  const targeted = (only, extra = {}) => ({
    ...options,
    seenUserIds: [],
    only,
    pageCap: 40,
    ...extra,
  });

  it('downloads only the wanted userIds', async () => {
    const d = deps({ fetchPage: pager([page([1, 2, 3], false)]) });
    const out = await runJob(d, targeted(['2']));
    expect(d.downloadResume).toHaveBeenCalledTimes(1);
    expect(out.downloaded.map((r) => r.userId)).toEqual(['2']);
  });

  it('stops as soon as everyone wanted has been found', async () => {
    const d = deps({ fetchPage: pager([page([1, 2]), page([3, 4]), page([5, 6])]) });
    const out = await runJob(d, targeted(['2']));
    expect(d.fetchPage).toHaveBeenCalledTimes(1);
    expect(out.stoppedBecause).toBe('found');
    expect(out.stillWanted).toEqual([]);
  });

  it('keeps walking past pages that hold nobody it wants', async () => {
    const d = deps({ fetchPage: pager([page([1, 2]), page([3, 4]), page([5, 6], false)]) });
    const out = await runJob(d, targeted(['6']));
    expect(d.fetchPage).toHaveBeenCalledTimes(3);
    expect(out.downloaded.map((r) => r.userId)).toEqual(['6']);
  });

  it('reports whoever it never reached as still wanted', async () => {
    const d = deps({ fetchPage: pager([page([1, 2], false)]) });
    const out = await runJob(d, targeted(['2', '99']));
    expect(out.stillWanted).toEqual(['99']);
  });

  it('stops at the page cap rather than walking for ever', async () => {
    const d = deps({ fetchPage: pager(Array.from({ length: 10 }, () => page([1, 2]))) });
    const out = await runJob(d, targeted(['77'], { pageCap: 3 }));
    expect(d.fetchPage).toHaveBeenCalledTimes(3);
    expect(out.stoppedBecause).toBe('capped');
    expect(out.stillWanted).toEqual(['77']);
  });

  it('takes reading breaks, exactly as a normal run does', async () => {
    const many = Array.from({ length: 12 }, (_, i) => i + 1);
    const d = deps({ fetchPage: pager([page(many, false)]) });
    // A fixed draw puts the break at the low end of breakEvery, so twelve
    // downloads must cross it.
    await runJob({ ...d, rand: () => 0.5 }, targeted(many.map(String)));
    const breaks = d.emit.mock.calls.filter((c) => c[0].type === 'break');
    expect(breaks.length).toBeGreaterThan(0);
  });

  it('does not report unidentifiable people it was not asked about', async () => {
    const anonymous = { id: 'JP9', recruitCandidate: { masked: false, candidate: {} } };
    const p = page([1, 2], false);
    p.edges.push(anonymous);
    const d = deps({ fetchPage: pager([p]) });
    const out = await runJob(d, targeted(['1']));
    expect(out.skippedNoId).toEqual([]);
    expect(d.emit.mock.calls.filter((c) => c[0].outcome === 'no-id')).toEqual([]);
  });

  it('strikes a wanted person off even when they have no resume', async () => {
    const p = page([1, 2]);
    p.edges[1].recruitCandidate.candidate.resumeUrl = null;
    const d = deps({ fetchPage: pager([p, page([3, 4], false)]) });
    const out = await runJob(d, targeted(['2']));
    expect(out.skippedNoResume.map((r) => r.userId)).toEqual(['2']);
    expect(out.stillWanted).toEqual([]);
    expect(d.fetchPage).toHaveBeenCalledTimes(1);
  });

  it('leaves a normal run untouched: no guest list means everybody', async () => {
    const d = deps({ fetchPage: pager([page([1, 2, 3], false)]) });
    const out = await runJob(d, { ...options, only: null });
    expect(out.downloaded).toHaveLength(3);
    expect(out.stillWanted).toEqual([]);
    expect(out.stoppedBecause).toBe('exhausted');
  });

  it('leaves a normal run untouched: no page cap by default', async () => {
    const d = deps({ fetchPage: pager(Array.from({ length: 6 }, () => page([1, 2]))) });
    const out = await runJob(d, { ...options, forceFullWalk: true });
    expect(d.fetchPage.mock.calls.length).toBeGreaterThan(3);
    expect(out.stoppedBecause).toBe('exhausted');
  });
});

// Seven call sites used to re-list which fields ride on a candidate event, so
// adding one meant editing seven places and any one of them that was missed
// changed what reached the trace and the running screen.
describe('every candidate event, whatever the outcome', () => {
  const candidates = (d) => d.emit.mock.calls.map(([e]) => e).filter((e) => e.type === 'candidate');

  it('carries the same fields for a download, a skip and a failure', async () => {
    const d = deps({
      fetchPage: pager([page([1, 2, 3], false)]),
      downloadResume: vi.fn(async (args) => {
        if (args.userId === '2') throw new Error('403 Forbidden');
        return { filename: 'x.pdf' };
      }),
    });
    await runJob(d, options);
    const events = candidates(d);
    expect(events.map((e) => e.outcome)).toEqual(['downloaded', 'failed', 'downloaded']);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        event.outcome === 'failed'
          ? ['error', 'jobId', 'name', 'outcome', 'type', 'userId']
          : ['jobId', 'name', 'outcome', 'type', 'userId'],
      );
      expect(event.jobId).toBe('9100001');
      expect(event.name).toMatch(/^Person /);
    }
  });

  it('carries no error key at all when nothing went wrong', async () => {
    const d = deps();
    await runJob(d, options);
    for (const event of candidates(d)) expect('error' in event).toBe(false);
  });
});
