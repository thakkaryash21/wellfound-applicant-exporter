# Candidate tracking model

- Status: **implemented**
- Approved: 2026-08-13
- Review: independently adversarially reviewed against the code and focused
  test paths before documentation

This is the canonical contract for candidate tracking. The implementation is
split across `src/lib/tracking.js` (set derivation), `src/lib/ledger.js`
(durable capture provenance and migration), `src/lib/runner.js` (complete Review
snapshots), and `src/panel/run-controller.js` (fresh reconciliation and the
acceptance gate).

Changes to the definitions, equations, persisted state, or acceptance gates in
this document must update the corresponding tests in the same change. Other
documents should link here rather than restating the model.

## Product questions

The operator needs three answers for each job:

1. How many applicant resumes are available?
2. How many applicants currently in **Needs Review** are genuinely new?
3. Which current applicants may be accepted without risking the loss of a
   resume?

The product does not need to display how many applicants have been accepted.
Acceptance history still exists internally because it prevents duplicate or
uncertain message delivery.

## Identity and scope

All candidate sets are scoped by `jobId` and keyed by Wellfound `userId`.
Names, positions, counts, and list order are never identity.

The same person may apply to more than one job. A capture or acceptance for one
job says nothing about the same user ID on another job. One person may also have
multiple rows within one job; decisions are made once per user ID using the
combined evidence from every row.

A row without a stable user ID is **unidentified**. It can appear in a CSV, but
it cannot be remembered, counted as new with certainty, reconciled to a file,
or accepted by the extension.

## Canonical terms

### Historically captured

The per-job capture registry contains the user ID because a resume download was
confirmed, a verified orphan file was adopted, or a CSV row carrying a captured
resume status was imported.

Before any exact count is derived, every matching orphan that Chrome verifies
as present is adopted automatically. A verified file may never remain outside
the registry while its owner is classified as new.

Historical capture answers whether this person is new. It does not, by itself,
prove that the resume is available now.

### Available capture

There is positive evidence that the resume is available for this job now. One
of these is required:

- the current run completed the download successfully;
- Chrome download history reports a completed matching file that still exists;
- a matching orphan file was verified present and adopted.

Absence of evidence that a file is missing is not positive availability.
In particular, an imported ID with no matching download-history evidence is
**unverifiable**, not available.

### Needs recovery

The person is historically captured but their resume is missing or
unverifiable now. They are not new, and they are not eligible for acceptance.
The remedy is to recover or re-download the resume while the person remains in
Needs Review.

### Current Review snapshot

A time-bounded identity snapshot of one job's current Wellfound review queue.
It is valid only when all of the following are true:

- the observed bucket is exactly `NEEDS_REVIEW`;
- pagination completed without an error, abort, safety cap, or early stop;
- every returned stable user ID was collected and deduplicated;
- unidentified or masked rows were counted separately;
- the snapshot records `jobId`, bucket, completion, and `scannedAt`.

`scannedAt` is the successful completion time, not the time the scan began.
Navigation away from the job, observing a foreign bucket, a partial/failed
scan, interruption, or an observed queue-changing action outside the plan
invalidates the snapshot.

The snapshot is ephemeral. An explicit check for new applicants creates one and
may display exact counts **as of its `scannedAt` time**. An acceptance plan may
use only a snapshot completed in the same uninterrupted run; there is no
wall-clock TTL that turns an older snapshot into permission to send. A stale or
incomplete snapshot may be shown as incomplete, but it may not produce an exact
new count or authorize accepts.

For Home display, the implementation exposes a completed snapshot once, only on
the same tab URL and within five minutes. A later refresh requires another
identity check because equal raw counts cannot prove the members are unchanged.

Building the plan materializes an immutable target identity set. API discovery
order decides which first `N` eligible identities enter that set, but does not
constrain execution order: the reviewer and API orders are independently
measured and may differ. A confirmed
accept performed by that plan invalidates the snapshot for further count
claims, because the queue changed, but does not invalidate the plan's remaining
targets. Each remaining target still passes the live DOM identity/message
interlock at its own click boundary. A document navigation, foreign bucket, or
live identity/message mismatch stops the plan.

### Delivery safety state

Two internal per-job maps remain even though accepted counts are not shown:

- `accepted[userId]`: a send was durably confirmed and must never be repeated;
- `provisional[userId]`: Send was clicked but the outcome is unresolved.

An unresolved candidate is never retried. Resolution may move them to accepted
or release them only after the queue proves the send did not occur. A confirmed
send that cannot be persisted is a fatal run outcome; the extension must stop
rather than continue without its duplicate-send protection.

## Persisted and ephemeral state

The persisted state is per job:

```text
capture registry:
  userId -> provenance
  provenance = downloaded | imported | adopted | legacy
  no silent eviction

delivery safety:
  accepted userId -> first confirmed/click timestamp
  provisional userId -> click timestamp

job metadata:
  job title, destination folder, last completed run
```

Availability is derived from the capture registry plus Chrome download history;
it is not a timeless boolean. Immediately before building an acceptance plan,
the extension reconciles availability again and merges that result with
successful downloads from the current run. A cached availability result must
carry the time of reconciliation and may not authorize a later acceptance run.

The current Review snapshot is held in run/panel state, not treated as durable
truth. Persisting it would make yesterday's queue look authoritative today.

The registry must never silently discard old identities. The current 5,000-ID
oldest-first eviction is incompatible with exact new counts: an evicted person
can look new, be downloaded twice, and inflate totals. If storage cannot accept
another identity, the write fails visibly and the run stops before making any
derived claim or acceptance decision.

## Derived sets

For one job:

```text
review = unique identified user IDs in a complete current Review snapshot

historicallyCaptured = all user IDs in the capture registry

availableCaptured = historicallyCaptured user IDs with positive current
                    availability, plus downloads completed in this run

new = review - historicallyCaptured

needsRecovery = (review intersect historicallyCaptured) - availableCaptured

eligibleToAccept = review
                   intersect availableCaptured
                   - accepted
                   - provisional

plannedToAccept = first N eligibleToAccept identities in Review API discovery order
```

These equations use identities, never subtraction between unrelated counts.
`actionableCount - knownCount` is not a valid estimate: accepted, rejected, and
manually moved candidates leave Needs Review while remaining historically
captured.

Unidentified rows are outside all identity equations. They are reported as an
exception and are never silently folded into new, downloaded, or eligible.

`N` is the job's acceptance limit. It is applied after unavailable, accepted,
provisional, and otherwise refused identities have been removed. Those
identities do not consume the limit, and the plan can never contain more than
`N` people. The reviewer may encounter the selected identities in a different
order; immutable membership, the per-target DOM identity gate, and the limit
still constrain every send.

## Resume and acceptance decisions

The acceptance planner consumes the complete Review snapshot, current
availability evidence, current-run records, and delivery safety state through a
single interface. Callers do not recreate the set equations.

For a user ID with multiple rows, capture is sufficient only when at least one
row carries positive capture evidence and every other row either carries the
same evidence or points to that person's evidenced row. A failed, missing,
locked, preview-only, or not-reached row prevents acceptance.

The plan is not permission to click blindly. Immediately before the irreversible
Send click, the reviewer still re-reads the exact DOM user ID and exact message.
The provisional ledger write still precedes dispatch. The DOM interlock and the
tracking model protect different seams and both are required.

Download-and-accept remains two passes:

1. Complete the API walk, download files, and durably record each successful
   capture.
2. Build the acceptance plan from those results, then walk the reviewer.

The passes are never interleaved because accepting mutates the collection being
paginated.

## UI contract

The ordinary job row may show only facts supported by a complete scan and fresh
reconciliation:

```text
100 resumes available
5 new
40 ready to accept
```

The accepted count is not shown on Home or Library. Internal accepted and
provisional maps remain intact.

Exceptions appear only when present:

```text
3 previously captured resumes need recovery
2 applicants could not be identified
Candidate check incomplete; refresh before accepting
```

The word **downloaded** in operator-facing tracking means a resume is positively
available, not the lifetime number of transfer attempts. If that wording is
ambiguous in a particular screen, use **resumes available**. Historical transfer
count is not a primary product metric.

When the Review scan is missing, stale, foreign-bucket, or incomplete, the UI
shows no exact new or ready count. Acceptance is disabled until a complete scan
is available.

## Migration

The existing per-job `seenUserIds` are migrated into the capture registry with
`legacy` provenance. Migration preserves identity but does not invent current
availability. Each legacy ID must be reconciled before it can enter
`availableCaptured`.

Migration also scans all matching Chrome download-history records and adopts
every verified-present orphan before deriving counts. This reconstructs capture
identities that the old 5,000-ID cap evicted only when Chrome still retains
their history. History is evidence, not a completeness oracle.

A legacy record is migration-incomplete when its remembered identity list has
reached the old 5,000-ID cap, when `totalDownloaded` exceeds the recoverable
identity union, or when reconciliation itself does not complete. In that state,
the extension publishes no exact new count and authorizes no acceptance. It
offers scoped CSV identity restoration and a complete current-Review recovery
walk that positively captures every current identifiable applicant. CSV rows
are adopted only when their `Job ID` matches the selected Library job. A CSV may
restore historical identities, but it never clears `migrationIncomplete`:
neither its row count nor the legacy download counter proves that an evicted
history is complete. Only the full current-Review recovery walk clears that
state. Migration never claims that a successful but empty history search or a
large CSV reconstructed erased information.

Existing `accepted` and `provisional` maps are retained byte-for-byte. Their UI
counts may be removed, but their meanings and timestamps do not change.

Existing `totalDownloaded` may remain temporarily for migration compatibility,
but it is not used for new counts, availability counts, or acceptance. Once all
readers have moved to the registry-derived model, it can be removed in a
separate migration.

## Required verification before release

Implementation is complete only when automated tests prove all of the following:

- a historically captured candidate who left Review does not reduce the new
  count for somebody else;
- an imported or legacy ID with no positive file evidence is not eligible;
- a deleted file produces needs-recovery and blocks acceptance;
- a current-run successful download becomes eligible in pass 2;
- a missing or unverifiable capture successfully recovered during a combined
  download-and-accept run becomes eligible in pass 2;
- a failed or preview-only download never becomes eligible;
- a verified orphan is adopted before new and availability are derived;
- a complete Needs Review scan produces exact identity-based counts;
- a foreign-bucket, partial, capped, aborted, or failed scan produces no exact
  counts and authorizes no accepts;
- unidentified rows are counted separately and never accepted;
- duplicate rows cannot turn one failed capture into an eligible person;
- accepted and provisional identities remain excluded even when their counts
  are hidden;
- a per-role limit is applied after every refusal/exclusion, selects in API
  discovery order, and never permits more than that many sends even when the
  reviewer presents the selected identities in another order;
- more than 5,000 captured identities remain exact, or storage failure stops
  visibly without accepting anyone;
- a capped or otherwise loss-signalled legacy ledger remains migration-incomplete
  when download history cannot reconstruct it, and publishes no exact claims;
- a planned acceptance invalidates further snapshot count claims after its first
  confirmed send but continues only through its immutable target list and live
  per-target DOM interlock;
- download-only, accept-only, and download-and-accept flows use the same planner
  and preserve the two-pass ordering;
- the final DOM identity/message interlock and provisional-before-click ordering
  remain mutation-tested.

## Non-goals

- Counting everyone Wellfound calls Matched.
- Reconstructing manual accepts, rejections, or pipeline moves.
- Showing an accepted total.
- Treating names as identity.
- Persisting a Review snapshot as evergreen truth.
- Using a missing file as evidence that a candidate is new.
