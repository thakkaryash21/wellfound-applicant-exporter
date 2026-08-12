import { parseFilename } from './filename.js';

// What the ledger says and what the disk says, reconciled. Nothing here knows
// the shape of a filename: this module used to hand-write two regexes for the
// grammar filename.js builds, with no import between them, so changing the
// separator in one place would have left every file reported missing and no
// test failing. filename.js owns the grammar; this owns the arithmetic.
// Takes the seen set and the job id directly. It used to take a `record`, but
// no ledger function produces one of that shape; ledger-service.js hand-built
// the object at the single call site purely to satisfy this signature.
export function reconcile({ jobId, seenUserIds, items }) {
  const ledgerIds = new Set(seenUserIds ?? []);

  // Decide per person, not per download record. Chrome keeps a separate history
  // entry for every attempt, so one candidate can have a completed download and
  // an interrupted retry. Judging each entry on its own would put that person in
  // both the present and the missing bucket.
  const best = new Map(); // userId -> true if any attempt landed a file on disk
  for (const it of items) {
    const userId = parseFilename(it.filename, jobId)?.userId ?? null;
    if (!userId) continue;
    // A download still in flight is neither present nor missing. Ignore it and
    // let the next reconciliation, after it settles, decide.
    if (it.state === 'in_progress') continue;
    const ok = it.state === 'complete' && it.exists !== false;
    best.set(userId, (best.get(userId) ?? false) || ok);
  }

  const present = new Set();
  const missing = new Set();
  const orphans = new Set();
  for (const [userId, ok] of best) {
    if (!ledgerIds.has(userId)) {
      if (ok) orphans.add(userId);
    } else if (ok) {
      present.add(userId);
    } else {
      missing.add(userId);
    }
  }

  const unverifiable = [...ledgerIds].filter((id) => !present.has(id) && !missing.has(id));

  return {
    verified: [...present],
    missing: [...missing],
    unverifiable,
    orphans: [...orphans],
  };
}
