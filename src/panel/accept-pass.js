import { ACCEPT_STATUS, RESUME_STATUS, acceptFailure } from '../lib/csv.js';
import { composeMessage } from '../lib/accept-message.js';
import { CX } from '../lib/messages.js';
import { PACING, sample, sampleInt } from '../lib/jitter.js';
import { localDateTimeText } from '../lib/local-time.js';

// The second pass over a job: the reviewer walk that accepts the people the
// first pass captured.
//
// It is a separate pass, not a branch inside runJob, for one measured reason:
// accepting removes a candidate from the NEEDS_REVIEW collection the API walk
// paginates with a cursor. Accepting mid-walk mutates the very collection the
// cursor points into, and the walk then returns fewer people and reports
// success - people silently skipped, with no error anywhere. So pass 1 runs to
// completion first, and only then does this run.
//
// Everything here decides and books; the DOM belongs to src/content/reviewer.js
// and the wording to src/lib/accept-message.js. This module never composes a
// selector, never retries a send, and never accepts anybody whose resume this
// extension does not already have on disk.

// The two Resume outcomes that mean "we have their file": fetched by this run,
// or fetched by an earlier one. Anything else - no resume, locked, previewed,
// failed, never reached - means accepting them would forfeit their resume
// forever, because an accepted candidate leaves NEEDS_REVIEW and no query this
// extension has can ever reach them again.
const CAPTURED = new Set([RESUME_STATUS.DOWNLOADED, RESUME_STATUS.ALREADY]);

// The one status that is neither a capture nor a refusal. A person with two
// applications has two rows; the walk spends one download and the other row
// says only "the outcome is on the other row". Read as a capture it would
// launder a failed download into an accept, which is the loss this whole
// module exists to prevent. Read as a refusal it would block a person whose
// download plainly succeeded. It is a pointer, so it is neither.
const POINTER = RESUME_STATUS.ANOTHER_ROW;

// The panel's half of the driver's one classification. src/content/reviewer.js
// appends this phrase to every refusal it raises BEFORE the send is clicked,
// and to nothing else; a test asserts the driver's own copy of it is this exact
// string. The two live apart because the driver is a MAIN-world classic script
// with no imports, the same reason the message types are duplicated into it.
export const NOTHING_SENT = 'nothing was sent';

// Leave the page as this pass found it: no reviewer modal, and above all no
// composer sitting there with the operator's message typed into it, one click
// from a stranger's inbox. src/content/reviewer.js does the clicking - `Cancel
// response`, then `Exit` - and never throws doing it.
//
// It is its own message rather than a second duty on CX_STOP_REVIEWER because
// stopping and leaving are two different moments: a stop arrives DURING an
// accept and must touch nothing, and most teardowns follow no stop at all.
//
// Re-exported so this pass's own tests and callers can keep naming it here,
// while the name itself lives with its siblings in messages.js. bridge.js
// carries the same literal in its table, exactly as the other message types are
// duplicated into it, and a test asserts the two agree.
export const CX_CLOSE_REVIEWER = CX.CLOSE_REVIEWER;

// Which of the two a failed accept was. Only certainty is recognised: an error
// this extension did not write - a relay timeout, anything unforeseen - carries
// no phrase and is read as unclear, because an outcome nobody can vouch for is
// exactly what `unclear` means.
//
// `unclear` is the one word in this panel that sends the operator to Wellfound
// to check whether a stranger got a message. Spending it on a composer that was
// slow to render teaches them to ignore it on the run where it is real.
//
// The certain half is `error`, which is not a new word: it is already what this
// pass reports when opening the reviewer, reading a position or skipping fails
// - the same concept, "the pass stopped and nothing went out", and the summary
// already says so in those words. One term, one meaning.
export function sendOutcome(reason) {
  return String(reason).includes(NOTHING_SENT) ? 'error' : 'unclear';
}

// A send that was clicked, that the page did not confirm, and whose outcome
// this pass has NOT finished asking about. Its own word, deliberately, because
// it is not the thing `unclear` names.
//
//   deferred - the click happened, nobody can vouch for it YET, and the pass is
//              still going to ask. The person is booked out of the queue and
//              into the ledger, so nothing will ever message them again.
//   unclear  - the click happened, nobody can vouch for it, and the asking is
//              over. This is the word that sends the operator to Wellfound.
//
// Every deferral ends as one of three things: an accept the queue confirmed
// later, an `unclear` that outlived the pass, or an `unrecorded` if the ledger
// refused it. The distinction exists because the run that produced it was
// neither ambiguous nor broken - it was SLOW. The accept committed 111 s after
// the click, long after every window this pass had, and the person was in the
// review queue for every one of the four looks that concluded otherwise.
export const DEFERRED = 'deferred';

// The Accept cell for a send that is still unresolved when the pass ends.
//
// It must not say `accepted`, which the ledger's own entry for this person
// might be read as, and it must not say `failed`, which is what the cell used
// to say and is exactly the sentence this whole change exists to stop printing
// about somebody who WAS messaged. It says neither, in that order, at the front
// of the cell where a spreadsheet shows it.
//
// This belongs beside its siblings in ACCEPT_STATUS in src/lib/csv.js - that
// file owns the column's vocabulary. Another agent holds csv.js this session,
// so it is declared here and should move there when the file is free.
export const ACCEPT_UNRESOLVED = 'unresolved';

export function acceptUnresolved(reason) {
  return `${ACCEPT_UNRESOLVED}: ${reason}`;
}

// What the operator is told about a send the queue could not settle.
//
// The previous wording said a candidate still in the queue after a minute
// "leans towards the message never leaving". That was reasonable and it was
// wrong, twice: on both runs the person was queued through every look and the
// message had gone. This page commits an accept minutes after the click, and
// while it is doing so a candidate sits in the review queue looking exactly
// like somebody who was never messaged.
//
// So presence in the queue is no longer offered as evidence in either
// direction. What the sentence says instead is what is actually true and what
// the operator can actually act on: nothing here will ever message them again,
// and Wellfound is the only place that can say whether they already were.
//
// The driver's own sentence is kept in front, verbatim: it is the account of
// what happened at the click, and this only adds what was learnt afterwards.
// Nothing appended may ever read as the driver's certainty phrase - `unclear`
// is decided from the ORIGINAL reason, and a test asserts these sentences do
// not disturb that.
export function unresolvedReason(reason, { verdict, looks = 0, waitedMs = 0 } = {}) {
  const kept =
    'They are recorded, so no run of this extension will ever message them again. ' +
    'Only Wellfound can say whether they already were.';
  if (verdict === 'queued') {
    const seconds = Math.round(waitedMs / 1000);
    return (
      `${reason} Checked the review queue ${looks} times over the following ` +
      `${seconds}s and they were still in it every time. That is not evidence the message ` +
      'never left: this page has been measured committing an accept minutes after the click, ' +
      `with the candidate queued throughout. ${kept}`
    );
  }
  if (verdict === 'unknown') {
    return `${reason} The review queue could not be read afterwards, so nothing was learnt. ${kept}`;
  }
  return `${reason} ${kept}`;
}

// THE INTERLOCK, as a function rather than as three lines buried in a closure,
// for one reason: a rule that cannot be broken in a test is defended by nothing.
// It is called on the one path that destroys the page context, and its whole
// job is to refuse when this pass does not yet durably know what happened to a
// real person.
//
// A reload inside that window destroys the only witness a send has, and the
// queue cannot recover it - a send can land after we stop looking, which this
// project has measured rather than supposed. So this throws, and the throw
// leaves the walk through the handler a failed open or a failed read does: the
// pass stops and says so.
export function guardReload(unresolvedSend) {
  if (unresolvedSend === null || unresolvedSend === undefined) return;
  throw new Error(
    `Refusing to reload the page with the accept for ${unresolvedSend} still unresolved`,
  );
}

// What the operator is told when a message demonstrably went out and the ledger
// refused to remember it. It is neither `error` - which promises nothing went
// out - nor `unclear`, which is about the click. The send is a fact; the record
// of it is what failed.
//
// The ledger is the single thing standing between this person and a second
// message from the next run, so this sentence has to send the operator to the
// one place that can prevent it.
export function unrecordedReason(userId, reason) {
  return (
    `The message to ${userId} was sent, and writing it to the ledger failed: ${reason} ` +
    'The send cannot be undone and nothing was retried. This run stopped there. ' +
    'Before running this role again, check that person in Wellfound: nothing here ' +
    'remembers they were messaged, so another run could message them a second time.'
  );
}

// The same failure on the deferred path, and it may not borrow the sentence
// above: that one opens "The message to X was sent", which is the one thing
// nobody knows here. What IS the same is the consequence, and it is worse -
// this person's only protection from a second message was the ledger entry that
// just failed, and unlike a confirmed accept there is not even a CSV row
// claiming the send happened.
export function unrecordedDeferralReason(userId, reason) {
  return (
    `The accept for ${userId} was clicked, the page never confirmed it, and writing it to ` +
    `the ledger failed: ${reason} Nothing was retried and this run stopped there. ` +
    'Before running this role again, check that person in Wellfound: nothing here ' +
    'remembers the attempt, so another run could message them.'
  );
}

// `[first_name]` is a greeting, not an identity: splitting `name` on
// whitespace is a guess, wrong for a title, a mononym, or family-name-first
// order. It exists only as a fallback for the rare record where Wellfound's
// own `firstName` field is missing. An empty result is fine - composeMessage
// drops the name and keeps the comma rather than skipping the candidate.
export function firstNameOf(name) {
  return String(name ?? '').trim().split(/\s+/)[0] ?? '';
}

// Preference order: the field Wellfound sends, then the first word of the
// display name, then nothing. Never the reverse - a split guess must never
// override the real field, because the real field is what the candidate
// actually typed as their first name.
export function resolveFirstName(record) {
  const real = String(record?.firstName ?? '').trim();
  if (real) return real;
  return firstNameOf(record?.name);
}

// Who this pass will try, who it refuses and why - decided before a single
// keystroke, from the rows pass 1 built. Every row gets an Accept cell here, so
// no row can reach the CSV with a blank one and leave the reader guessing
// whether it was refused, missed, or never attempted.
//
// `limit` is the role's own number - the one the operator typed beside it on
// Home - and here it means exactly one thing: at most this many people are
// MESSAGED from this role. It is the same number pass 1 reads as "take at most
// N new downloads from this role", and the two readings can diverge: a
// download-and-accept run over a role that has been walked before may download
// three new people and message three others who were already on disk. The
// reading chosen is the one that cannot surprise: whatever else a run does,
// somebody who typed 3 gets at most three messages sent under their name.
//
// It bounds the people messaged and nothing else. A refusal is not a message
// and an already-accepted person is not a message, so neither spends the
// number; counting them would let a role with three refusals send nothing and
// still report the limit as honoured, which is the surprise in the other
// direction.
//
// Everyone over the number keeps NOT_REACHED - already the word for "the run
// was accepting and stopped (a limit, an abort) before reaching this
// candidate", which is precisely what happened to them.
export function planAccepts({ records = [], alreadyAccepted = [], limit = Infinity } = {}) {
  const already = new Set(alreadyAccepted.map(String));
  // Grouped before anything is decided, because the decision is about a PERSON
  // and the evidence is spread across their rows. Deciding row by row let one
  // person be refused on the row whose download failed and accepted on the
  // row that merely pointed at it - the same person, both cells in the CSV,
  // and a resume lost for good.
  const rowsById = new Map();
  // Rows with no userId at all, kept apart: nobody without an id can be
  // accepted, since the interlock in the reviewer matches on the id and there
  // is no name-based fallback anywhere.
  const anonymous = [];
  for (const record of records) {
    const userId = record.userId == null ? null : String(record.userId);
    if (!userId) {
      anonymous.push(record);
      continue;
    }
    if (rowsById.has(userId)) rowsById.get(userId).push(record);
    else rowsById.set(userId, [record]);
  }

  const targets = [];
  let refusedNoResume = 0;
  let alreadyCount = 0;

  const refuse = (rows) => {
    for (const row of rows) row.acceptStatus = ACCEPT_STATUS.NO_RESUME;
    refusedNoResume += rows.length;
  };

  refuse(anonymous);

  for (const [userId, rows] of rowsById) {
    // Both halves are load-bearing and neither implies the other. `some`
    // rules out a person whose every row is a pointer or a refusal; `every`
    // rules out the person one of whose rows records a failure or a refusal,
    // whatever their other rows say. A run holds their resume only if a row
    // says so and no row says otherwise.
    const captured =
      rows.some((row) => CAPTURED.has(row.resumeStatus)) &&
      rows.every((row) => CAPTURED.has(row.resumeStatus) || row.resumeStatus === POINTER);
    if (!captured) {
      refuse(rows);
      continue;
    }
    if (already.has(userId)) {
      for (const row of rows) row.acceptStatus = ACCEPT_STATUS.ALREADY;
      alreadyCount += rows.length;
      continue;
    }
    targets.push(userId);
    // Held until the walk reaches them. A pass that stops early leaves this
    // word in the cell, which is the honest one.
    for (const row of rows) row.acceptStatus = ACCEPT_STATUS.NOT_REACHED;
  }

  // Cut here, last, once every row has its cell. Order is the order pass 1
  // handed the records over - Wellfound's own queue order, the order the API
  // paginated them in - carried through `records`, then through this Map's
  // insertion order, and out to `targets` unchanged. It is deliberately not
  // whatever order a Map or an object happens to yield for a set of ids: the
  // people a capped run takes are the ones at the front of the queue, which is
  // also where the reviewer starts, so a small run skips past nobody.
  //
  // `Infinity` is the unlimited case and slices nothing: a role set to
  // "everyone" still accepts everyone.
  const capped = Number.isFinite(limit) ? targets.slice(0, Math.max(0, limit)) : targets;

  return { targets: capped, rowsById, refusedNoResume, alreadyAccepted: alreadyCount };
}

// How long the pass goes on watching the page for a send the driver's fast
// path did not see land, as the waits BETWEEN successive looks.
//
// This is the rung that was missing, and the run that produced it measured the
// gap exactly: on a 101-applicant role accepts took 25 s, 32 s, 42 s, 46 s,
// 50 s and 66 s - and they took that long on FRESHLY RELOADED documents, so it
// is not degradation and no reload recovers it. A large role is simply slow.
// Against a 40 s deadline a large fraction of a role comes back unconfirmed,
// each one spends a deferral, and two deferrals end the pass: 98 targets need
// about a dozen, so the role could never finish.
//
// Nothing here is a new instrument. It re-applies the DRIVER'S OWN predicate -
// the candidate has left the slot and the denominator has dropped - by reading
// the position again. What changed is that the watching is no longer trapped
// inside one message round trip that has to end. A confirmation this finds is
// an ordinary accept, not a rescue.
//
// It costs NOTHING on the wire: READ_CANDIDATE is a DOM read in the page, not a
// request to Wellfound. That is why patience here is cheap and why it is spent
// before anything that costs a fetch.
//
// Cumulative 125 s, growing, over six looks. Sized past the 66 s measured here
// and past the 111 s commit measured on the previous role - and unlike the
// constants it replaces, being wrong about it is not an outcome: what follows
// is the queue, then a deferral, both of which already exist.
const WATCH_WAITS_MS = [5000, 10000, 15000, 20000, 30000, 45000];

// How long the queue is given to settle ON THE SPOT, as the waits BETWEEN
// successive looks. The first look happens immediately.
//
// This window used to be the whole answer: it waited about 50 s over four
// looks and then declared `unclear` forever. It was lengthened once already,
// from one look to four, and the very next run defeated it by committing the
// accept at +111 s. Lengthening it again would be picking a number one worse
// case ahead of the last one, which is the same mistake with a bigger constant.
//
// So it has been SHORTENED instead, because it no longer has to be right. The
// question is not answered here any more: an unconfirmed send that this window
// cannot settle becomes a deferral, and the sweep below asks again once the
// rest of the role has gone by. Being wrong on the spot now costs a few fetches
// and a page reload rather than a person and a role.
//
// Shorter again, now that the watch above runs first. By the time the queue is
// asked at all, the pass has already spent up to 125 s looking at the page, so
// there is nothing left for a settle window to wait out - one look, then one
// more, and the sweep at the end of the pass is the real second chance.
const QUEUE_SETTLE_WAITS_MS = [15000];

// The other half, and the reason the window above could shrink: the same
// question, asked again after the pass has done everything else it came to do.
//
// An accept that commits at +111 s is not ambiguous, it is slow, and a pass over
// 99 people takes many minutes. So the time the settle window was buying with
// the operator's patience is time the run already spends. The sweep costs one
// or two fetches per deferral per wave - the cursor hint answers `queued` in
// one - and normally none at all, because a role of any size has long since
// outlasted the send by the time the pass ends.
//
// These waits are the case the sweep does NOT get for free: a deferral on the
// last candidate of a small role, where the pass ends seconds after the click.
// Then, and only then, the run waits - up to two and a half minutes across
// three waves, which is more than the 111 s that has actually been measured and
// is spent only when the alternative is telling the operator to go and read a
// stranger's inbox by hand. A stop ends it where it stands.
const DEFERRED_SWEEP_WAITS_MS = [15000, 45000, 90000];

// How many sends a pass will carry on past when the page failed to confirm
// them, and how many of those may be left unresolved when it does.
//
// The old rule was that ONE unconfirmed send ended the pass, and the cost of
// that turned out to be total: 99 targets, one slow accept on the first, 0
// accepted - and the same person reached first on every retry, so the role
// could never be got past at all. The rule was right about the danger and wrong
// about the price.
//
// What makes carrying on safe is not optimism about the page. It is that the
// identity interlock re-reads the candidate's id from the DOM immediately
// before the click, so an unconfirmed send is an unconfirmed send TO AN
// INTENDED TARGET - no stranger is in question - and that the deferral is
// written to the ledger before anything else happens, so that person can never
// be messaged again whatever this pass does next.
//
// What is left to fear is the page: an unconfirmed send is how a degraded page
// announces itself, and a pass that kept sending into one would manufacture
// exactly the pile of unresolved people this bound exists to prevent. So each
// one forces a reload before the next send, one deferral is a slow page, and a
// second is a pattern this module can no longer reason about - which is what
// `unclear` has always meant and where the pass still stops.
//
// The two numbers measure different things and only one of them moved.
//
// UNCONFIRMED_SENDS_PER_PASS bounds COST: it is how many times a pass will walk
// the collection, which is the most expensive thing it can do. It was 3 when
// reaching the queue at all meant something had gone wrong. It no longer does -
// the LAST candidate of every role reaches it as a matter of course, because
// the watch confirms a send by the next person sliding into the slot and on the
// last one there is nobody left to slide in. So one per role is now normal, and
// 3 left almost no room above normal.
//
// DEFERRALS_PER_PASS bounds something else entirely, and it is not about the
// page at all: it is how many real people this pass may leave in limbo for the
// operator to check by hand. That cost is human and it does not get cheaper
// because the mechanism got better. Two is already a chore; ten would not be
// acceptable however healthy the page looked. It stays at 2, and what changed
// is that reaching it now takes a send the page did not show for over two
// minutes AND a queue that would not vouch for it - not merely a slow role.
const UNCONFIRMED_SENDS_PER_PASS = 5;
const DEFERRALS_PER_PASS = 2;

// One accept taking this long is the page asking to be reloaded.
//
// The counted cadence in PACING is a backstop and cannot be the whole trigger,
// because how fast the page degrades scales with how much of the list it is
// holding. Both measured:
//
//   20 applicants:   5-9 s an accept, steady, reloads at 7, 13, 18, finished
//   111 applicants:  8.3 s, 7.1 s, 35.9 s, then 47 s and the relay gave up
//
// The second run died on its fourth accept, so a cadence of five to seven never
// fired once - the mechanism that makes long passes work was never reached. No
// count protects both roles: small enough for 111 is wasteful on 20. But the
// pass already holds the one number that means the same thing on any size of
// role, which is how long the last accept took.
//
// 20 s, and every part of that is a measurement. The healthy band is 5-9 s and
// the two pauses this pass hands the driver account for up to 8 s of it, so an
// accept reaching 20 s spent at least 12 s inside the page against a healthy
// two or three - it is not ordinary variation, and there is more than a
// doubling of the healthy ceiling between the two. The relay's budget is 45 s,
// so 20 s leaves 25 s of headroom: the reload happens a whole accept before an
// accept could fail. The 35.9 s accept that preceded the failure trips it
// comfortably; nothing in either healthy run comes close.
//
// Wrong in the cheap direction if it is wrong at all: the cost of firing early
// is a page load, and the cost of firing late is a stalled run.
//
// 20000 was that reasoning applied to the evidence available, and the next run
// showed the reasoning had the wrong subject. On a 101-applicant role the
// trigger fired on nearly every accept - and it fired on accepts that had begun
// on a document reloaded seconds earlier, one of them 46 s after
// accept_reload_commit. A threshold that fires on a freshly loaded page is not
// measuring degradation, it is measuring how big the role is, and the reload it
// asks for recovers nothing because there was nothing to recover.
//
// So it is raised to sit above the band a large role simply has (25-66 s
// measured) and left as a backstop for the thing it was named after: an accept
// far outside even that. The mechanism that keeps a long pass alive is now the
// watch above, which costs no requests, and the counted cadence in
// PACING.reloadEvery, which was reloading every five to seven accepts anyway.
const SLOW_ACCEPT_MS = 90000;

// `review` is one call into the reviewer driver, `recordAccepted` is the
// ledger write, and both are injected for the same reason the download walk
// injects its own: this loop is the part worth testing, and neither a real tab
// nor a real message may be involved in testing it.
//
// `checkQueue` is the third, and it is the only one that is optional: a caller
// that cannot ask the API gets exactly the behaviour this pass had before it
// existed. It answers 'gone', 'queued' or 'unknown' for one userId, and it is
// never given the chance to answer anything about a send that was refused
// before the click.
//
// `reloadPage` is the fourth and is optional for the same reason: it reloads
// the working tab and does not return until the page can answer for this job
// again. The pass owns WHEN a reload happens; it owns nothing about how, which
// is the run controller's business because the tab is.
export async function runAcceptPass(deps, options) {
  const { review, recordAccepted, sleep, emit, checkQueue, reloadPage } = deps;
  const rand = deps.rand ?? Math.random;
  // The clock, injected for the same reason  is: a test that has to make
  // an accept take thirty-six seconds must not take thirty-six seconds.
  const now = deps.now ?? (() => Date.now());
  const {
    jobId,
    jobTitle,
    records = [],
    alreadyAccepted = [],
    template,
    signal,
    // The role's own number. Absent means unbounded, which is what a caller
    // that has no opinion should get - but the run controller always has one,
    // because every role on Home always carries either a number or Infinity.
    limit = Infinity,
  } = options;

  const plan = planAccepts({ records, alreadyAccepted, limit });
  const intended = plan.targets.length;
  const remaining = new Set(plan.targets);
  const totals = {
    accepted: 0,
    refusedNoResume: plan.refusedNoResume,
    alreadyAccepted: plan.alreadyAccepted,
    skipped: 0,
    failed: 0,
    // People whose send was clicked and is still unresolved. Counted apart from
    // `failed`, which promises nothing went out, and apart from `accepted`,
    // which promises something did. It falls back to zero when a deferral is
    // settled later in the pass.
    unresolved: 0,
  };
  let stoppedBecause = 'finished';
  let error;

  // Progress is reported against `intended`, never against the reviewer's own
  // total: that total SHRINKS with every accept, so a percentage of it would
  // run backwards and forwards at once.
  emit({
    type: 'accept_started',
    jobId,
    jobTitle,
    intended,
    refusedNoResume: totals.refusedNoResume,
    alreadyAccepted: totals.alreadyAccepted,
  });

  const emitCandidate = (userId, outcome, extra = {}) =>
    emit({
      type: 'accept_candidate',
      jobId,
      userId,
      outcome,
      accepted: totals.accepted,
      intended,
      ...extra,
    });

  const mark = (userId, status, acceptedAt) => {
    for (const row of plan.rowsById.get(userId) ?? []) {
      row.acceptStatus = status;
      if (acceptedAt !== undefined) row.acceptedAt = acceptedAt;
    }
  };

  // The same reading-break model the download walk paces itself with, and
  // deliberately the same constants: reading a profile before deciding is what
  // a human does here anyway, so this rhythm needs no new numbers.
  let sinceBreak = 0;
  let breakAt = sampleInt(PACING.breakEvery, rand);
  async function pace() {
    sinceBreak += 1;
    if (sinceBreak >= breakAt) {
      const ms = sample(PACING.breakMs[0], PACING.breakMs[1], rand);
      emit({ type: 'break', jobId, ms });
      await sleep(ms, signal);
      sinceBreak = 0;
      breakAt = sampleInt(PACING.breakEvery, rand);
    } else {
      const ms = sample(PACING.downloadMs[0], PACING.downloadMs[1], rand);
      emit({ type: 'resting', jobId, ms });
      await sleep(ms, signal);
    }
  }

  // An accept spends most of its time paused inside the page, where the run's
  // AbortSignal cannot reach: signals do not cross into a content script. So a
  // stop is forwarded as its own message. It is very likely to arrive while an
  // accept is mid-pause, which is exactly the case it exists for - the pause
  // ends there and then, and no send follows it. Its failure is ignored: a tab
  // that has gone away cannot send anything either.
  const forwardStop = () => {
    Promise.resolve(review({ type: CX.STOP_REVIEWER })).catch(() => {});
  };
  signal?.addEventListener('abort', forwardStop, { once: true });

  // Set immediately BEFORE the reviewer is opened, not after it answers: an
  // open that fails part-way - the modal up but at the wrong position - is
  // exactly the case that leaves something behind to close.
  let touchedReviewer = false;

  // The sends this pass clicked and could not confirm on the spot. Each one is
  // already in the ledger and already out of `remaining` by the time it lands
  // here, so this list decides only what the operator is TOLD - never whether
  // anybody is messaged.
  const deferred = [];
  let unconfirmedSends = 0;
  let deferrals = 0;

  // Keep watching the page for a send its fast path did not see land.
  //
  // The predicate is the driver's, exactly: the candidate has left the slot AND
  // the denominator has dropped. One definition of "the send landed" in this
  // extension, applied in two places that differ only in who is waiting.
  //
  // A read that fails is "not yet", never a failure of its own. The reviewer
  // legitimately has nothing to show while it is mid-render, and on the last
  // candidate of a role it may have nothing to show at all - which is
  // UNVERIFIED behaviour this pass has never been able to produce deliberately.
  // Either way the answer is to look again, and to fall through to the queue
  // when the looking runs out.
  //
  // Nothing in here clicks, and nothing in here can send. It reads.
  const watchForLanding = async (userId, beforeTotal) => {
    for (const waitMs of WATCH_WAITS_MS) {
      // A stop ends the watching where it stands. The send is already
      // outstanding and nothing further goes out either way.
      if (signal?.aborted) return false;
      emit({ type: 'resting', jobId, ms: waitMs });
      await sleep(waitMs, signal);
      let at = null;
      try {
        at = await review({ type: CX.READ_CANDIDATE });
      } catch {
        at = null;
      }
      emit({
        type: 'accept_watching',
        jobId,
        userId,
        index: at?.index ?? null,
        total: at?.total ?? null,
      });
      if (at && String(at.userId) !== userId && Number(at.total) < Number(beforeTotal)) return true;
    }
    return false;
  };

  // One question to the API, with its failure treated as an answer rather than
  // an exception: a check that could not reach the API has learnt nothing,
  // which is the same position the pass was in before it asked.
  const lookAtQueue = async (userId, look) => {
    let seen = 'unknown';
    try {
      seen = String((await checkQueue(userId)) ?? 'unknown');
    } catch {
      seen = 'unknown';
    }
    emit({ type: 'accept_checked', jobId, userId, verdict: seen, look });
    return seen;
  };

  // Asking again, once the rest of the role has gone by.
  //
  // `gone` is the whole of the evidence available and it is one-directional -
  // there is no ACCEPTED status to query, only absence from NEEDS_REVIEW - but
  // absence is exactly what a landed accept produces, and it does not expire.
  // A send that committed at +111 s is `gone` at +112 s and at +12 minutes
  // alike, so a question that could not be answered at the click can simply be
  // asked later. That is the whole idea: the settle window's problem was never
  // its length, it was that it insisted on a final answer at the worst moment
  // to want one.
  //
  // Nothing here can send anything. It reads, and it upgrades a deferral to the
  // accept it always was. The ledger entry was written when the send was
  // deferred, so this writes nothing and nobody can be messaged twice by it.
  const settleDeferred = async () => {
    const open = () => deferred.filter((entry) => !entry.resolved);
    if (!checkQueue || open().length === 0) return;
    emit({ type: 'accept_settling', jobId, count: open().length });
    for (let wave = 0; ; wave += 1) {
      for (const entry of open()) {
        entry.looks += 1;
        if ((await lookAtQueue(entry.userId, entry.looks)) !== 'gone') continue;
        // They have left NEEDS_REVIEW, and the click that would remove them
        // from it is the one this pass made. The send landed.
        entry.resolved = true;
        totals.unresolved -= 1;
        totals.accepted += 1;
        mark(entry.userId, ACCEPT_STATUS.ACCEPTED, localDateTimeText());
        emitCandidate(entry.userId, 'accepted', { confirmedBy: 'queue', looks: entry.looks });
      }
      if (open().length === 0) break;
      if (wave >= DEFERRED_SWEEP_WAITS_MS.length) break;
      // An operator who has pressed Stop is not waiting another two minutes for
      // an answer the run will report honestly either way.
      if (signal?.aborted) break;
      emit({ type: 'resting', jobId, ms: DEFERRED_SWEEP_WAITS_MS[wave] });
      await sleep(DEFERRED_SWEEP_WAITS_MS[wave], signal);
    }
    const stillOpen = open();
    if (stillOpen.length === 0) return;
    // The asking is over, so the word changes. This is where `deferred` becomes
    // `unclear` - the one state in this panel that asks the operator to go and
    // look at Wellfound - and it is the only place it can, because it is the
    // only place that knows nothing further will be asked.
    //
    // It does not overwrite a reason the pass already had: `unrecorded` and a
    // failed walk both name something worse and both point at the same page.
    if (stoppedBecause === 'finished' || stoppedBecause === 'aborted') {
      stoppedBecause = 'unclear';
      error = stillOpen[0].told;
    }
  };

  const finish = async () => {
    // Every exit from this pass runs through here, including the two that
    // return rather than throw, which is why the teardown lives in it. Its own
    // failure is swallowed: this pass may already be carrying the error the
    // operator needs to read, and a teardown that threw over it would replace a
    // message about a candidate with a message about a button.
    if (touchedReviewer) {
      try {
        await review({ type: CX_CLOSE_REVIEWER });
      } catch {
        // Nothing to say and nowhere useful to say it. A tab that has gone away
        // has no composer left open on it either.
      }
    }
    // After the page has been let go of and before anything is reported. The
    // sweep touches no DOM at all - it is a query - so it is the one thing this
    // pass can still do honestly once the reviewer is closed, and doing it here
    // means every exit gets it: a finished pass, an aborted one, and the walk
    // that threw.
    await settleDeferred();
    signal?.removeEventListener('abort', forwardStop);
    emit({
      type: 'accept_done',
      jobId,
      jobTitle,
      intended,
      ...totals,
      stoppedBecause,
      ...(error === undefined ? {} : { error }),
    });
    return { intended, ...totals, stoppedBecause, ...(error === undefined ? {} : { error }) };
  };

  // Nobody to accept is not a failure and is not a reason to open the reviewer
  // at all: an accept-only run over a job whose resumes were never captured
  // must touch Wellfound's UI not once.
  if (intended === 0) return finish();
  if (signal?.aborted) {
    stoppedBecause = 'aborted';
    return finish();
  }

  // The refresh cycle. One mechanism, one counter, one call site.
  //
  // There were briefly two - a cheap reopen of the modal every couple of
  // accepts, and a reload of the page underneath it less often. The reload does
  // everything the reopen did and more: it discards the modal as a side effect
  // of discarding the document, and the pass reopens and re-reads position
  // afterwards either way. Two cycles at different scales, both claiming to be
  // why the page is fresh, is a thing no reader could reason about later - so
  // the cheap one is gone rather than nested underneath.
  //
  // `refreshAt` is redrawn every cycle from PACING.reloadEvery, exactly as the
  // reading break redraws `breakEvery`: a refresh that arrived on every sixth
  // accept without fail would be a rhythm nothing human produces, and the
  // bounds live in PACING with the rest of the timing rather than here.
  let acceptsSinceRefresh = 0;
  let refreshAt = sampleInt(PACING.reloadEvery, rand);
  let refreshPending = false;

  // The state guardReload above reads. Holds a userId from the moment before
  // the send is clicked until the moment after that accept has been written to
  // the ledger - the whole of the window in which this pass does not yet
  // durably know what happened to a real person.
  let unresolvedSend = null;

  // Who this pass has already walked past, by identity rather than by visit.
  //
  // A reload lands the reviewer back at position 1, so every skipped person is
  // read again on the way back to the front of the queue. That used to disable
  // the whole refresh cycle: `skipped` was a count of visits, and re-walking
  // them counted the same people twice. The count was defended and the
  // mechanism that keeps a long pass alive was switched off - on the owner's
  // primary workflow, where an accept-only run over a whole role refuses
  // anybody whose resume was never captured and therefore skips somebody within
  // the first few positions.
  //
  // Counting per person makes the re-walk harmless, so nothing has to be
  // switched off. Re-encountering somebody this pass has already passed over is
  // recognised, not prevented.
  const skippedIds = new Set();

  // Let go of the page and take hold of it again.
  //
  // The composer is closed first even though the load discards it anyway: the
  // promise that this pass never leaves the operator's message sitting in a box
  // holds at every instant, not only at the convenient ones.
  //
  // `reloadPage` does not return until the page can answer for THIS job again.
  // That is the run controller's business and it reuses the readiness probe
  // every navigation in this extension already goes through - the one that
  // answers which jobId is live, because a stale document mid-navigation
  // answers a bare "are you there?" perfectly well and takes the run down with
  // it. A caller that cannot reload still gets the close and the open, which is
  // strictly less but costs nothing and keeps the cadence honest.
  //
  // A reload that does not come back throws, and the throw leaves this loop
  // through the same handler a failed open or a failed read does: the pass
  // stops, says so in the panel's own words, and the ledger is already correct
  // because nothing gets here with an accept outstanding.
  //
  // It reads nothing back and assumes nothing about who is on screen. The
  // loop's next act is READ_CANDIDATE, which is the only thing that decides
  // that, so a refresh cannot step over anybody.
  const refresh = async () => {
    guardReload(unresolvedSend);
    emit({
      type: reloadPage ? 'accept_reload' : 'accept_reopen',
      jobId,
      accepted: totals.accepted,
      intended,
    });
    await review({ type: CX_CLOSE_REVIEWER });
    if (reloadPage) await reloadPage();
    // A beat before the click, because a person who reloads a slow page looks
    // at it before doing anything else.
    await pace();
    await review({ type: CX.OPEN_REVIEWER });
    acceptsSinceRefresh = 0;
    refreshAt = sampleInt(PACING.reloadEvery, rand);
    refreshPending = false;
  };

  // Called from exactly one place: the top of the loop, before READ_CANDIDATE
  // has even chosen who the next candidate is. That is what makes a refresh
  // mid-accept unrepresentable rather than merely avoided - and the interlock
  // above is what keeps it unrepresentable after somebody edits this file.
  //
  // A refresh cannot loop and cannot lose anybody. Every refresh is asked for
  // by an accept - the counted cadence counts accepts, and both immediate
  // triggers follow one - so the queue has strictly shrunk since the last one,
  // and a skip never asks for anything. What a refresh costs is re-walking the
  // people already skipped, which is a handful of reads and the pace between
  // them; what it cannot do is accept anybody twice, because `remaining` no
  // longer holds anyone this pass has messaged and the ledger holds them all.
  const refreshIfDue = async () => {
    if (!refreshPending && acceptsSinceRefresh < refreshAt) return;
    await refresh();
  };

  // Booking a confirmed accept: the ledger first, then everything in memory.
  //
  // The order is the second interlock and it is not a convention: at the moment
  // recordAccepted is called this person's row still reads NOT_REACHED and they
  // are still in `remaining`, so nothing can advance past an accept that is not
  // yet written down. A test asserts that state from inside the ledger write.
  //
  // A confirmed send is a fact, and nothing that happens afterwards may retract
  // it. So the write has its own catch, and its failure is NOT the walk's
  // failure: reporting it as `error` - this pass's word for "the pass stopped
  // and nothing went out" - told the operator the opposite of what happened,
  // left the CSV saying `not attempted`, and left the next run free to message
  // that person a second time.
  //
  // Returns whether the pass may carry on, and on a failed write it may not.
  // The ledger is the only thing standing between these people and a second
  // message, so a ledger that has stopped working turns every further accept
  // into another unrecorded message. One is a person to check by hand; a
  // hundred is not recoverable. It stops on the first.
  const bookAccept = async (userId, extra = {}) => {
    let recorded = true;
    let reason = null;
    try {
      await recordAccepted(jobId, userId);
    } catch (ledgerError) {
      recorded = false;
      reason = String(ledgerError.message || ledgerError);
    }
    // Booked either way, because either way the message went out. When the
    // ledger refused it, the CSV row is the only surviving record of the send,
    // so it says accepted and says when.
    unresolvedSend = null;
    remaining.delete(userId);
    mark(userId, ACCEPT_STATUS.ACCEPTED, localDateTimeText());
    totals.accepted += 1;
    emitCandidate(userId, 'accepted', { ...extra, ...(recorded ? {} : { recorded: false }) });
    if (recorded) return true;
    stoppedBecause = 'unrecorded';
    error = unrecordedReason(userId, reason);
    emit({ type: 'accept_unrecorded', jobId, userId, error });
    return false;
  };

  // Booking a send nobody can vouch for yet, and the whole of the durable trace
  // one leaves.
  //
  // The ledger entry is written FIRST, exactly as a confirmed accept's is, and
  // it is the point of this function. Before this change these people got no
  // entry at all: the run reported them as failed and the next run reached them
  // again with nothing remembering the first attempt. The rule that nobody is
  // ever messaged twice was resting on the pass stopping, on the operator
  // reading an alert, and on them not simply pressing the button again.
  //
  // What that entry does NOT claim is the careful part. The ledger's question
  // is "may this extension send to this person?", and the honest answer here is
  // no - permanently, whichever way the send went. It is not a record that the
  // message arrived, and nothing that reads it says so: the CSV cell says
  // `unresolved` and gives the reason, the trace carries the deferral, the
  // summary counts these people apart from the accepted and from the failed,
  // and none of the four tells the operator that nothing was sent.
  //
  // The one cost is that this person now looks accepted to the Library's
  // re-download check, which will decline to fetch a resume it might still be
  // able to reach. That is the safe direction and it is reversible by hand;
  // being wrong the other way is not reversible at all.
  const bookDeferred = async (userId, told) => {
    let recorded = true;
    let reason = null;
    try {
      await recordAccepted(jobId, userId);
    } catch (ledgerError) {
      recorded = false;
      reason = String(ledgerError.message || ledgerError);
    }
    unresolvedSend = null;
    remaining.delete(userId);
    mark(userId, acceptUnresolved(told));
    totals.unresolved += 1;
    deferrals += 1;
    deferred.push({ userId, told, looks: 0, resolved: false });
    emitCandidate(userId, DEFERRED, { error: told, ...(recorded ? {} : { recorded: false }) });
    if (recorded) return true;
    // The ledger is the only thing standing between this person and a second
    // message, and here it is also the only thing that would have remembered
    // the attempt at all. Nothing further is sent.
    stoppedBecause = 'unrecorded';
    error = unrecordedDeferralReason(userId, reason);
    emit({ type: 'accept_unrecorded', jobId, userId, error });
    return false;
  };

  try {
    touchedReviewer = true;
    await review({ type: CX.OPEN_REVIEWER });

    while (remaining.size > 0) {
      if (signal?.aborted) {
        stoppedBecause = 'aborted';
        break;
      }

      await refreshIfDue();

      const at = await review({ type: CX.READ_CANDIDATE });
      const userId = at?.userId == null ? '' : String(at.userId);
      emit({
        type: 'accept_considering',
        jobId,
        userId,
        index: at?.index ?? null,
        total: at?.total ?? null,
        accepted: totals.accepted,
        intended,
      });

      if (!remaining.has(userId)) {
        // The only path that navigates. A skip advances the index and leaves
        // the bucket alone, which is why it is safe here and catastrophic
        // after an accept.
        await review({ type: CX.SKIP_CANDIDATE });
        // Not counted or announced at all for somebody this pass deferred. If
        // their send did not land they are still sitting at the front of the
        // queue, so the walk does pass over them - but the panel has already
        // said `deferred` about that person, and "skipped" alongside it reads
        // as a second, milder account of the same event.
        if (!deferred.some((entry) => entry.userId === userId)) {
          // Counted by person, not by visit: a reload returns the reviewer to
          // position 1, so these same people are walked past again on the way
          // back to the front, and a pass that skipped four must not report
          // twelve because it reloaded twice.
          const seenBefore = skippedIds.has(userId);
          skippedIds.add(userId);
          totals.skipped = skippedIds.size;
          // Said once per person, for the same reason. The trace and the panel
          // both read these, and a second sentence about the same skip is noise
          // that reads as a second person.
          if (!seenBefore) emitCandidate(userId, 'skipped');
        }
        await pace();
        continue;
      }

      let message;
      try {
        message = composeMessage({
          template,
          firstName: resolveFirstName(plan.rowsById.get(userId)?.[0]),
          roleName: jobTitle,
        });
      } catch (composeError) {
        // A message that would go out with a literal token in it is not sent,
        // and this candidate is not accepted. The pass carries on past them:
        // the fault is in the wording, not in the page, and skipping is the
        // one navigation that costs nobody anything.
        const reason = String(composeError.message || composeError);
        remaining.delete(userId);
        mark(userId, acceptFailure(reason));
        totals.failed += 1;
        emitCandidate(userId, 'failed', { error: reason });
        await review({ type: CX.SKIP_CANDIDATE });
        await pace();
        continue;
      }

      // The interlock closes HERE, before the click, and opens again only once
      // this person is in the ledger. Everything in between is the window where
      // a real message may exist that nothing durable knows about, and no
      // reload may happen inside it.
      unresolvedSend = userId;
      const sendStartedAt = now();
      try {
        const sent = await review({
          type: CX.ACCEPT_CANDIDATE,
          // Sampled here, per candidate, from the same PACING every other pause
          // in the run draws from. The driver is a classic content script with
          // no imports: it cannot reach jitter.js, and copying the numbers into
          // it would put one concept in two places. So pacing stays the panel's
          // and the DOM stays the driver's, and these two numbers are the whole
          // of what crosses.
          payload: {
            expectedUserId: userId,
            message,
            beforePasteMs: sample(PACING.beforePasteMs[0], PACING.beforePasteMs[1], rand),
            afterPasteMs: sample(PACING.afterPasteMs[0], PACING.afterPasteMs[1], rand),
          },
        });
        // The driver's fast path did not see it land, which on a large role is
        // an ordinary result rather than an alarm. The pass keeps watching the
        // same two signals, for as long as it takes and without a message round
        // trip holding them open. Nothing is retried and nothing is clicked.
        //
        // Only when the watching runs out too does this become the failure the
        // handler below is for, and it is raised in the DRIVER'S OWN words: the
        // sentence describes what happened at the click, which is the driver's
        // to tell, and it carries no certainty phrase - so it reads as unclear,
        // exactly as the same outcome always has.
        if (sent?.pending) {
          emit({ type: 'accept_pending', jobId, userId });
          if (!(await watchForLanding(userId, sent.total))) throw new Error(sent.reason);
        }
      } catch (sendError) {
        // Nothing is ever retried here. The whole of what follows is about
        // LEARNING what happened, never about trying again: the send has either
        // gone out or it has not, and a second click would be a second message
        // to a real person.
        //
        // What differs is what the operator is told. The driver knows whether
        // it refused before clicking and says so; the panel used to flatten
        // both cases into the alarming one.
        const reason = String(sendError.message || sendError);

        // The certain half of the driver's contract: it refused BEFORE the
        // click, so nothing went out, and asking the API about it could only
        // produce a wrong answer since the candidate is still in the queue
        // either way. Nothing is deferred and nothing is written to the ledger,
        // because there is nothing to remember. The pass stops and is never
        // followed by a skip: whatever made the driver refuse is likely to
        // refuse for the next person too.
        if (sendOutcome(reason) === 'error') {
          mark(userId, acceptFailure(reason));
          totals.failed += 1;
          emitCandidate(userId, 'failed', { error: reason });
          stoppedBecause = 'error';
          error = reason;
          break;
        }

        // The click happened and the DOM never confirmed it. From here on the
        // only question is what is KNOWN, never what to try again.
        unconfirmedSends += 1;
        let verdict = null;
        let looks = 0;
        let waitedMs = 0;
        if (checkQueue && unconfirmedSends <= UNCONFIRMED_SENDS_PER_PASS) {
          emit({ type: 'accept_unconfirmed', jobId, userId, error: reason });
          // One look establishes only where the candidate was at that instant,
          // and a send still in flight puts them in the queue exactly as a send
          // that never happened does. `gone` is the only answer that settles
          // anything, so it is the only one that ends the loop early.
          verdict = await lookAtQueue(userId, (looks += 1));
          for (const waitMs of QUEUE_SETTLE_WAITS_MS) {
            if (verdict === 'gone') break;
            // A stop ends the settling where it stands.
            if (signal?.aborted) break;
            emit({ type: 'resting', jobId, ms: waitMs });
            await sleep(waitMs, signal);
            waitedMs += waitMs;
            verdict = await lookAtQueue(userId, (looks += 1));
          }
          if (verdict === 'gone') {
            // They are not in NEEDS_REVIEW any more, and the click that would
            // remove them from it is the one this pass just made. The send
            // landed. Booked exactly as a confirmed one - ledger first, so a
            // later run cannot message them again - and the pass carries on.
            //
            // The page could not vouch for this send, so the page is not
            // trusted for another one: the refresh below is asked for now
            // rather than at the next multiple of the cadence.
            const carryOn = await bookAccept(userId, { confirmedBy: 'queue', looks });
            if (!carryOn) break;
            refreshPending = true;
            await pace();
            continue;
          }
        }

        // Still queued after settling, never asked, or asked and unanswerable.
        // Deferred, not concluded: booked durably so nothing can ever message
        // them again, and asked about once more when the pass is over.
        //
        // The sentence is built from the driver's ORIGINAL one. What was learnt
        // afterwards changes what the operator reads; it does not change which
        // of the two things the driver said happened at the click.
        const told = unresolvedReason(reason, { verdict, looks, waitedMs });
        if (!(await bookDeferred(userId, told))) break;

        // Whether the pass may carry on past it. `queued` is the one answer
        // consistent with a page that is merely slow - the candidate is where a
        // send in flight leaves them, and the API answered, so both instruments
        // still work. Anything else means this pass has lost the only
        // instrument it had left, and it will not keep sending while blind.
        if (verdict !== 'queued') {
          stoppedBecause = 'unclear';
          error = told;
          break;
        }
        // Two of these is not a slow page any more, and neither is a fourth
        // unconfirmed send. The pass stops with everybody it has messaged
        // already written down.
        if (deferrals >= DEFERRALS_PER_PASS || unconfirmedSends >= UNCONFIRMED_SENDS_PER_PASS) {
          stoppedBecause = 'unclear';
          error = told;
          break;
        }
        // The page has just been demonstrably wrong about a send. It gets a new
        // document before it is asked for another one. No skip: if the message
        // went out the reviewer has already advanced, and if it did not the
        // reload puts the walk back at position 1 either way, where
        // READ_CANDIDATE decides who is there rather than this loop assuming.
        refreshPending = true;
        await pace();
        continue;
      }

      // How long the page took over that accept, and what it says about the
      // page. This is the trigger that works on a role of any size: the counted
      // cadence below cannot know that a 111-applicant list degrades five times
      // faster than a 20-applicant one, and a single slow accept says it
      // outright, one whole accept before the relay would give up.
      //
      // Read AFTER the send resolved and BEFORE the ledger write, so it is a
      // measurement of what already happened and never a reason to touch the
      // page while this accept is outstanding. It only ever asks for a refresh
      // at the top of the next turn, exactly as the counter does.
      const tookMs = now() - sendStartedAt;
      if (tookMs >= SLOW_ACCEPT_MS) {
        refreshPending = true;
        emit({ type: 'accept_slow', jobId, userId, ms: tookMs });
      }
      // Recorded before anything else can interrupt, exactly as a download is:
      // an accept the ledger does not know about gets sent a second time. The
      // interlock opens on the far side of that write, inside bookAccept.
      const carryOn = await bookAccept(userId);
      if (!carryOn) break;
      acceptsSinceRefresh += 1;

      // No skip here, ever. A confirmed accept has already auto-advanced -
      // measured live as `1 of 116` becoming `1 of 115` with the next person
      // in the slot - so advancing again would step over somebody unseen.
      await pace();
    }
  } catch (walkError) {
    // Opening the reviewer, reading a position or skipping. None of these send
    // anything, so the pass simply stops and says so; the rows it never
    // reached keep NOT_REACHED.
    stoppedBecause = 'error';
    error = String(walkError.message || walkError);
  }

  return finish();
}
