export const MAX_SEEN = 5000;

const KEY_PREFIX = 'job:';
const key = (jobId) => `${KEY_PREFIX}${jobId}`;

function emptyRecord(jobId) {
  return {
    jobId,
    jobTitle: null,
    seenUserIds: [],
    lastRunAt: null,
    totalDownloaded: 0,
    folder: null,
  };
}

// Everyone this ledger will not fetch again: downloads, CSV imports and adopted
// orphans alike. Its own arithmetic, so it lives here rather than being spelled
// out at each call site.
function knownCount(record) {
  return new Set(record?.seenUserIds ?? []).size;
}

// The record's field names stop here.
//
// `record.seenUserIds ?? []` used to be written out at the call sites, which
// made a rename silently survivable in the worst possible way: the field goes
// missing, `?? []` turns that into an empty set, and the run treats every
// applicant as new - hundreds of resumes re-fetched at human pacing with no
// error anywhere. This module is the one place that knows the shape, so it is
// the one place allowed to default it, and a rename inside it fails loudly at
// the only site that could have been forgotten.
function seenUserIds(record) {
  return record?.seenUserIds ?? [];
}

// What a caller outside this module may know about a job. Named fields, not the
// stored record, so nothing downstream can start depending on the storage shape
// again.
function describeRecord(record) {
  return {
    jobId: record.jobId,
    jobTitle: record.jobTitle ?? null,
    // Files this ledger fetched. Deliberately unmoved by a CSV import or an
    // orphan adoption.
    downloaded: record.totalDownloaded ?? 0,
    // The one place this codebase says `known` rather than `seenUserIds`, and
    // deliberately: everywhere else the seen set is the list of userIds a run
    // subtracts from, while this is the strictly broader public count - the
    // same set plus everyone a CSV import or an orphan adoption taught it.
    // After importing 400 people, `downloaded` is still 0 and only this number
    // shows the import did anything.
    known: knownCount(record),
    lastRunAt: record.lastRunAt ?? null,
    folder: record.folder ?? null,
  };
}

export function createLedger(storage) {
  async function get(jobId) {
    const stored = await storage.get(key(jobId));
    return stored[key(jobId)] ?? emptyRecord(jobId);
  }

  async function put(record) {
    await storage.set({ [key(record.jobId)]: record });
  }

  function merge(existingList, ids) {
    const existing = new Set(existingList);
    // Add as we filter, so a batch is deduped against itself as well as against
    // what is already stored.
    const added = ids.filter((id) => {
      if (!id || existing.has(id)) return false;
      existing.add(id);
      return true;
    });
    const list = [...existingList, ...added];
    return {
      list: list.length > MAX_SEEN ? list.slice(list.length - MAX_SEEN) : list,
      addedCount: added.length,
    };
  }

  return {
    get,
    // Everyone this job will not fetch again. The run subtracts from this list;
    // it never reaches into the record to build it.
    async seenUserIds(jobId) {
      return seenUserIds(await get(jobId));
    },
    async describe(jobId) {
      return describeRecord(await get(jobId));
    },
    // Every job this ledger holds, described. One storage read for the whole
    // Library rather than one per row. It replaced an `all()` that handed back
    // the stored records themselves, which is how the Library came to read
    // `totalDownloaded`, `jobTitle` and `lastRunAt` off the storage shape.
    async describeAll() {
      const everything = await storage.get(null);
      return Object.entries(everything)
        .filter(([k]) => k.startsWith(KEY_PREFIX))
        .map(([, v]) => describeRecord(v));
    },
    // Takes the userIds themselves. It used to take `{ applicantId, userId }`
    // entries and drop the applicantId on the floor, which meant two call sites
    // passed a literal `null` for a field no ledger function has ever read.
    async markDownloaded(jobId, userIds, meta = {}) {
      const record = await get(jobId);
      const users = merge(seenUserIds(record), userIds);
      await put({
        ...record,
        jobTitle: meta.jobTitle ?? record.jobTitle,
        seenUserIds: users.list,
        // Counted on unique userIds: one person who applied to the job twice is
        // one file on disk, so they must not count twice. userId is the only
        // identity this ledger keeps; two identity sets that could drift apart
        // is a bug waiting to be found.
        totalDownloaded: record.totalDownloaded + users.addedCount,
      });
    },
    async adopt(jobId, userIds) {
      const record = await get(jobId);
      const users = merge(seenUserIds(record), userIds);
      await put({ ...record, seenUserIds: users.list });
    },
    // `folder` is remembered so a later re-download lands beside the originals
    // instead of in whatever default the Library screen would have guessed.
    // `downloaded` is deliberately not stored. It used to be written as
    // `lastRunCount` on every run and read by nothing; `totalDownloaded` is the
    // number the Library actually shows.
    async finishRun(jobId, { folder }) {
      const record = await get(jobId);
      await put({
        ...record,
        lastRunAt: new Date().toISOString(),
        folder: folder ?? record.folder ?? null,
      });
    },
    async forget(jobId) {
      await storage.remove(key(jobId));
    },
  };
}
