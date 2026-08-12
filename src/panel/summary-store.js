import { storableSummary } from './summary.js';

// The two things about a run that have to outlive the panel: what the last run
// reported, and whether a run was in flight when the panel went away.
//
// What it hides is that the panel is not durable. The run loop lives in the side
// panel, so closing it kills the run with no `done` and no summary at all - and
// the previous run's stored summary would then read as this run's result. These
// six calls are what stands between that and a lie, and every one of them
// degrades to a no-op rather than throwing: storage here is a convenience, and
// losing it costs a notice, never the run.

// Survives the panel being closed. A twelve-minute run whose result vanishes the
// moment the panel loses focus is a result the user cannot act on.
export const SUMMARY_KEY = 'wfx:lastSummary';

// Written when a run starts, cleared when it emits `done`. The run loop lives in
// the panel, so closing it kills the run with no `done` and no summary at all -
// and the previous run's stored summary would then read as this run's result.
// A marker still present at load time is the only evidence that happened.
export const RUNNING_KEY = 'wfx:running';

// Every call below degrades to a no-op on failure, and for one reason: storage
// here is a convenience, never the source of truth. The summary on screen is
// already rendered, and a missing marker costs the interruption notice rather
// than the run. Six byte-identical try/catch blocks each restated that; one
// helper states it once.
//
// Returns `fallback` when the call throws, so a reader still gets a value.
async function bestEffort(fn, fallback = null) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function storeSummary(summary) {
  // Scrubbed on the way in, not on the way out: what is not written cannot
  // leak, and the copy on screen still names who failed.
  await bestEffort(() =>
    chrome.storage.local.set({ [SUMMARY_KEY]: storableSummary(summary) }),
  );
}

export async function loadStoredSummary() {
  // Returned as stored. It used to be tagged `stale: true` for a Home screen
  // that showed the last run's summary under the job list; Home no longer shows
  // it at all, so the flag had no reader left.
  const stored = await bestEffort(() => chrome.storage.local.get(SUMMARY_KEY));
  return stored?.[SUMMARY_KEY] ?? null;
}

// What Done does. The run's own account of itself is finished with, so both the
// summary and any marker go: candidate-adjacent data lives exactly as long as
// the screen showing it, and Home is never greeted by a run the user has closed.
//
// The dedup ledger is deliberately not touched. Its keys are `job:<id>` and they
// are the record of who has been downloaded - the Library's business, and the
// whole point of the tool. Clearing the record of a run must never clear that.
export async function clearRun() {
  await bestEffort(() => chrome.storage.local.remove([SUMMARY_KEY, RUNNING_KEY]));
}

export async function markRunStarted() {
  await bestEffort(() =>
    chrome.storage.local.set({ [RUNNING_KEY]: { running: true, startedAt: Date.now() } }),
  );
}

export async function clearRunMarker() {
  await bestEffort(() => chrome.storage.local.remove(RUNNING_KEY));
}

// Read and cleared in one step: the notice is about the run that just died, and
// showing it twice would be a second lie about a second run.
export async function takeInterruptedRun() {
  return bestEffort(async () => {
    const stored = await chrome.storage.local.get(RUNNING_KEY);
    const marker = stored?.[RUNNING_KEY];
    if (!marker?.running) return null;
    await clearRunMarker();
    return marker;
  });
}
