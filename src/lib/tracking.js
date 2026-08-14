export const REVIEW_BUCKET = 'NEEDS_REVIEW';

const ids = (values) => new Set((values ?? []).filter(Boolean).map(String));

// The one interface for candidate-set arithmetic. Callers provide evidence;
// this module decides which claims that evidence can support. Order always
// comes from the current Wellfound review snapshot.
//
// It deliberately does NOT apply the per-role limit or produce the accept plan.
// It sees identities and availability; it cannot see that one of a person's
// rows records a failed download, which is a refusal that must not spend one of
// the operator's N slots. `planAccepts` in accept-pass.js has the rows, refuses
// per person, and cuts to N last. Two places holding half the rule each is how
// a refusal comes to consume a slot.
export function deriveTracking({
  jobId,
  snapshot,
  historicallyCaptured = [],
  availableCaptured = [],
  accepted = [],
  provisional = [],
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
  return {
    exact: true,
    scannedAt: snapshot?.scannedAt ?? null,
    unidentified: snapshot?.unidentified ?? 0,
    newUserIds,
    needsRecoveryUserIds,
    eligibleUserIds,
  };
}
