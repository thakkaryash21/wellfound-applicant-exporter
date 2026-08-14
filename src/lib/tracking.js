export const REVIEW_BUCKET = 'NEEDS_REVIEW';

const ids = (values) => new Set((values ?? []).filter(Boolean).map(String));

// The one interface for candidate-set arithmetic. Callers provide evidence;
// this module decides which claims and irreversible targets that evidence can
// support. Order always comes from the current Wellfound review snapshot.
export function deriveTracking({
  jobId,
  snapshot,
  historicallyCaptured = [],
  availableCaptured = [],
  accepted = [],
  provisional = [],
  limit = Infinity,
} = {}) {
  const valid =
    jobId != null &&
    String(snapshot?.jobId) === String(jobId) &&
    snapshot?.complete === true &&
    snapshot?.bucket === REVIEW_BUCKET &&
    Boolean(snapshot?.scannedAt);
  if (!valid) {
    return {
      exact: false,
      scannedAt: snapshot?.scannedAt ?? null,
      unidentified: snapshot?.unidentified ?? 0,
      newUserIds: null,
      needsRecoveryUserIds: null,
      eligibleUserIds: [],
      plannedUserIds: [],
    };
  }

  const review = [...new Set((snapshot?.userIds ?? []).filter(Boolean).map(String))];
  const historical = ids(historicallyCaptured);
  const available = ids(availableCaptured);
  const sent = ids(accepted);
  const unresolved = ids(provisional);

  const newUserIds = review.filter((id) => !historical.has(id));
  const needsRecoveryUserIds = review.filter(
    (id) => historical.has(id) && !available.has(id),
  );
  const eligibleUserIds = review.filter(
    (id) => available.has(id) && !sent.has(id) && !unresolved.has(id),
  );
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;

  return {
    exact: true,
    scannedAt: snapshot?.scannedAt ?? null,
    unidentified: snapshot?.unidentified ?? 0,
    newUserIds,
    needsRecoveryUserIds,
    eligibleUserIds,
    plannedUserIds: eligibleUserIds.slice(0, count),
  };
}
