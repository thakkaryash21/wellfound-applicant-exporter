export const MAX_SEEN = 5000;

const KEY_PREFIX = 'job:';
const key = (jobId) => `${KEY_PREFIX}${jobId}`;

function emptyRecord(jobId) {
  return {
    jobId,
    jobTitle: null,
    seenUserIds: [],
    lastRunAt: null,
    lastRunCount: 0,
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
function seenIds(record) {
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
    // orphan adoption, which is why `known` exists beside it.
    downloaded: record.totalDownloaded ?? 0,
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
    async knownUserIds(jobId) {
      return seenIds(await get(jobId));
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
    async markDownloaded(jobId, entries, meta = {}) {
      const record = await get(jobId);
      const users = merge(seenIds(record), entries.map((e) => e.userId));
      await put({
        ...record,
        jobTitle: meta.jobTitle ?? record.jobTitle,
        seenUserIds: users.list,
        // Counted on unique userIds: one person who applied to the job twice is
        // one file on disk, so they must not count twice. An applicantId list
        // was kept alongside this for a while; nothing ever read it, and two
        // identity sets that could drift apart is a bug waiting to be found.
        totalDownloaded: record.totalDownloaded + users.addedCount,
      });
    },
    async adopt(jobId, entries) {
      const record = await get(jobId);
      const users = merge(seenIds(record), entries.map((e) => e.userId));
      await put({ ...record, seenUserIds: users.list });
    },
    // `folder` is remembered so a later re-download lands beside the originals
    // instead of in whatever default the Library screen would have guessed.
    async finishRun(jobId, { downloaded, folder }) {
      const record = await get(jobId);
      await put({
        ...record,
        lastRunAt: new Date().toISOString(),
        lastRunCount: downloaded,
        folder: folder ?? record.folder ?? null,
      });
    },
    async forget(jobId) {
      await storage.remove(key(jobId));
    },
  };
}
