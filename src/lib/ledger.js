import { localDateTimeText } from './local-time.js';

const KEY_PREFIX = 'job:';
const SCHEMA_VERSION = 2;
const LEGACY_MAX_SEEN = 5000;
const key = (jobId) => `${KEY_PREFIX}${jobId}`;

function emptyRecord(jobId) {
  return {
    jobId,
    jobTitle: null,
    schemaVersion: SCHEMA_VERSION,
    // userId -> how this extension learned that a resume was captured. The
    // registry is authoritative; the former seenUserIds array is migration
    // input only and is never written again.
    captures: {},
    migrationIncomplete: false,
    lastRunAt: null,
    totalDownloaded: 0,
    folder: null,
    // userId -> local date/time text of the accept. A plain map, not a list
    // like seenUserIds, because an accept is unrepeatable and the moment it
    // happened matters - a raw Unix timestamp has already been a reported
    // defect on this project, so this reuses local-time.js rather than
    // inventing a second way to stamp a record.
    accepted: {},
    // userId -> local date/time text of the CLICK. Sends this ledger cannot
    // yet vouch for, and the reason it is a second map rather than a flag on
    // the one above.
    //
    // Measured on a real run: of two sends the page never confirmed, one had
    // landed and one had not - and the pass wrote both into `accepted`, so the
    // person who was never messaged was permanently written off. `accepted`
    // means "a message reached this person and must never be sent again". That
    // is a claim, and it may only be made when something vouched for it.
    //
    // This map makes no claim. It means "Send was armed and nobody knows
    // whether it was used",
    // and it is the state the sweep RESOLVES: out of here into `accepted` when
    // the queue says they are gone, or out of here and nowhere when the queue
    // still shows them. Anything left in it is a question, not an answer, and a
    // later run can ask it again.
    provisional: {},
  };
}

function captureMap(record) {
  return record?.captures ?? {};
}

function captureIds(record) {
  return Object.keys(captureMap(record));
}

function normalizeRecord(raw, jobId) {
  if (!raw) return { record: emptyRecord(jobId), migrated: false };
  if (raw.schemaVersion === SCHEMA_VERSION && raw.captures) {
    return {
      record: { ...emptyRecord(jobId), ...raw, jobId: String(jobId) },
      migrated: false,
    };
  }

  const legacyIds = [...new Set((raw.seenUserIds ?? []).filter(Boolean).map(String))];
  const captures = Object.fromEntries(legacyIds.map((id) => [id, 'legacy']));
  const { seenUserIds: _legacy, ...rest } = raw;
  const migrationIncomplete =
    Boolean(raw.migrationIncomplete) ||
    legacyIds.length >= LEGACY_MAX_SEEN ||
    Number(raw.totalDownloaded ?? 0) > legacyIds.length;
  return {
    record: {
      ...emptyRecord(jobId),
      ...rest,
      jobId: String(jobId),
      schemaVersion: SCHEMA_VERSION,
      captures,
      migrationIncomplete,
    },
    migrated: true,
  };
}

// Compatibility for existing internal diagnostics and tests. This is derived
// on read and never stored, so there remains one authoritative identity source.
function withSeenProjection(record) {
  return Object.defineProperty({ ...record }, 'seenUserIds', {
    value: captureIds(record),
    enumerable: false,
  });
}

// Same defaulting rule as seenUserIds, and for the same reason: this is the
// one place allowed to know the field is called `accepted`, so a rename
// fails loudly here instead of quietly re-sending messages to everyone.
function acceptedMap(record) {
  return record?.accepted ?? {};
}

// Same defaulting rule again, and the stakes are the mirror image: a rename
// that silently defaulted this to {} would lose the questions a crashed run
// left behind, and every one of those people would be messaged again with no
// record that they might already have been.
function provisionalMap(record) {
  return record?.provisional ?? {};
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
    //
    // There used to be a `known` beside it - the capture registry's size, the
    // strictly broader number that showed a CSV import had done something. Both
    // its readers are gone: the Library row states resumes verified present now,
    // which is the question it is asked, and the import reports its own count
    // where the operator is standing when it finishes. A count nothing renders
    // is a claim nobody checks.
    downloaded: record.totalDownloaded ?? 0,
    migrationIncomplete: Boolean(record.migrationIncomplete),
    lastRunAt: record.lastRunAt ?? null,
    folder: record.folder ?? null,
  };
}

export function createLedger(storage) {
  async function get(jobId) {
    const stored = await storage.get(key(jobId));
    const raw = stored[key(jobId)];
    const { record, migrated } = normalizeRecord(raw, jobId);
    if (migrated) await put(record);
    return withSeenProjection(record);
  }

  async function put(record) {
    const { seenUserIds: _projection, ...stored } = record;
    await storage.set({ [key(record.jobId)]: stored });
  }

  function mergeCaptures(record, ids, provenance) {
    const captures = { ...captureMap(record) };
    let addedCount = 0;
    let newlyDownloaded = 0;
    for (const raw of ids) {
      if (!raw) continue;
      const id = String(raw);
      const previous = captures[id];
      if (!previous) addedCount += 1;
      if (provenance === 'downloaded' && !previous) newlyDownloaded += 1;
      if (!previous || provenance === 'downloaded' || provenance === 'adopted') {
        captures[id] = provenance;
      }
    }
    return { captures, addedCount, newlyDownloaded };
  }

  return {
    get,
    // Everyone historically captured for this job. This is not evidence that
    // the file is still available: callers must reconcile it against Chrome
    // download history before using any identity as a download or acceptance
    // exclusion.
    async seenUserIds(jobId) {
      return captureIds(await get(jobId));
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
      const rows = [];
      for (const [storedKey, raw] of Object.entries(everything)) {
        if (!storedKey.startsWith(KEY_PREFIX)) continue;
        const jobId = String(raw?.jobId ?? storedKey.slice(KEY_PREFIX.length));
        const { record, migrated } = normalizeRecord(raw, jobId);
        if (migrated) await put(record);
        rows.push(describeRecord(record));
      }
      return rows;
    },
    // Takes the userIds themselves. It used to take `{ applicantId, userId }`
    // entries and drop the applicantId on the floor, which meant two call sites
    // passed a literal `null` for a field no ledger function has ever read.
    async markDownloaded(jobId, userIds, meta = {}) {
      const record = await get(jobId);
      const merged = mergeCaptures(record, userIds, 'downloaded');
      await put({
        ...record,
        jobTitle: meta.jobTitle ?? record.jobTitle,
        captures: merged.captures,
        // Counted on unique userIds: one person who applied to the job twice is
        // one file on disk, so they must not count twice. userId is the only
        // identity this ledger keeps; two identity sets that could drift apart
        // is a bug waiting to be found.
        totalDownloaded: record.totalDownloaded + merged.newlyDownloaded,
      });
    },
    async adopt(jobId, userIds, provenance = 'imported') {
      const record = await get(jobId);
      const merged = mergeCaptures(record, userIds, provenance);
      await put({ ...record, captures: merged.captures });
    },
    async markMigrationComplete(jobId) {
      const record = await get(jobId);
      if (!record.migrationIncomplete) return;
      await put({ ...record, migrationIncomplete: false });
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
    // Everyone this job has already been sent an accept message for. The
    // accept pass subtracts from this list; it never reaches into the record
    // itself.
    async acceptedUserIds(jobId) {
      return Object.keys(acceptedMap(await get(jobId)));
    },
    // Written per person, not batched at end of run - a stronger version of
    // why markDownloaded is written per file, because a lost accept record
    // means a real person gets messaged a second time. Idempotent: a second
    // call for the same userId keeps the original acceptedAt rather than
    // overwriting it, so retrying after a crash never lies about when the
    // message actually went out.
    async markAccepted(jobId, userId) {
      const record = await get(jobId);
      const accepted = acceptedMap(record);
      if (userId in accepted) return;
      await put({
        ...record,
        accepted: { ...accepted, [userId]: localDateTimeText() },
      });
    },
    // Sends nobody has vouched for, left over from any run - including one that
    // died before it could ask. A later pass resolves them; see resolveHeldOver
    // in src/panel/accept-pass.js.
    async provisionalUserIds(jobId) {
      return Object.keys(provisionalMap(await get(jobId)));
    },
    // Written before anything else can interrupt, exactly as markAccepted is,
    // and idempotent for the same reason: the stamp is the moment of the click,
    // and a second call must not move it.
    //
    // It deliberately does NOT touch `accepted`. Writing there is the claim
    // that a message arrived, and at this point nothing has said so.
    async markProvisional(jobId, userId) {
      const record = await get(jobId);
      const provisional = provisionalMap(record);
      if (userId in provisional) return;
      await put({
        ...record,
        provisional: { ...provisional, [userId]: localDateTimeText() },
      });
    },
    // The queue said they have left NEEDS_REVIEW, so the send landed. One write,
    // so the person is never briefly in both maps or briefly in neither: the
    // whole value of the provisional entry is that it exists continuously from
    // the click until the answer.
    //
    // The original click stamp is carried into `accepted` rather than restamped
    // with the moment of the answer, because the question the column asks is
    // when the message went out, not when we found out.
    async confirmProvisional(jobId, userId) {
      const record = await get(jobId);
      const provisional = { ...provisionalMap(record) };
      const accepted = acceptedMap(record);
      const at = provisional[userId];
      delete provisional[userId];
      await put({
        ...record,
        provisional,
        accepted: userId in accepted ? accepted : { ...accepted, [userId]: at ?? localDateTimeText() },
      });
    },
    // The queue still shows them after the old composer was closed, so the send did not
    // happen. The entry goes, and NOTHING is written in its place: this person
    // was never messaged, so they are eligible again exactly as they were
    // before the attempt.
    //
    // This is the one place in this extension where a record that stops somebody
    // being messaged is deliberately removed. It is safe because it removes only
    // the provisional entry and can never reach `accepted`, so a send anything
    // ever vouched for stays final.
    async releaseProvisional(jobId, userId) {
      const record = await get(jobId);
      const provisional = { ...provisionalMap(record) };
      if (!(userId in provisional)) return;
      delete provisional[userId];
      await put({ ...record, provisional });
    },
    async forget(jobId) {
      await storage.remove(key(jobId));
    },
    // The accept-only equivalent of forget. Deliberately narrower: it clears
    // who has been messaged for this job without touching capture history or
    // totalDownloaded, so a rerun after clearing it re-walks accept targets
    // but does not re-fetch resumes already on disk. Named to say exactly
    // what it clears, so it can never be wired to the same button as forget
    // by accident.
    async forgetAccepted(jobId) {
      const record = await get(jobId);
      // The unanswered questions go with the answers. Leaving them would let a
      // rerun after clearing skip people on the strength of a record the
      // operator has just asked to be rid of.
      await put({ ...record, accepted: {}, provisional: {} });
    },
  };
}
