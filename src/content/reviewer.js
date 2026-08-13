// MAIN world. Drives Wellfound's applicant reviewer - the modal - and nothing
// else. It is the only file in this extension that clicks anything on
// Wellfound's own page.
//
// Accepting a candidate here SENDS THAT CANDIDATE A MESSAGE under the
// operator's name, and it cannot be undone. Every guard below exists because
// the cheapest bug in this file messages a real stranger, twice, or messages
// the wrong one. When anything is unclear the operation stops and reports; it
// never retries a send and never assumes one landed.
//
// The division of labour, kept deliberately narrow: the panel owns the loop,
// the ledger and the message text. This file owns the DOM. It receives an
// already-composed message string (from src/lib/accept-message.js, which it
// cannot import) and an expected userId, and it refuses to act on anything it
// cannot identify exactly.
//
// A classic script, like collector.js: MV3 will not run a module in the MAIN
// world, so there are no imports here and the message type strings are
// duplicated inline from src/lib/messages.js.
(() => {
  // The action button in the reviewer, whose text is exactly `Accept`. On the
  // real page this text matches TWO elements - the button and a
  // keyboard-shortcut legend row - so text is never the whole selector.
  const ACCEPT_LABEL = /^accept$/i;
  // The composer's confirm button: `Accept application & send message`.
  const SEND_LABEL = /accept application/i;
  // The control on the applicant list that opens the reviewer. There is one per
  // applicant card - fifteen of them on a full page - so plurality here is the
  // page working normally, not ambiguity.
  const OPEN_LABEL = /^view application$/i;
  // Advance without acting on the current candidate. Exactly one on the page.
  const NEXT_LABEL = /^next applicant$/i;
  // The two ways out, measured live, and NOT equally important.
  //
  // `Cancel response` exists only while the composer is open - exactly one
  // match, with a box - and clicking it clears the composed message and returns
  // to the profile. That is the one that removes the danger, and it is the one
  // this file can promise.
  //
  // `Exit` closes the reviewer. Exactly one match, enabled, unhidden, and drawn
  // at 0 x 0 in the collapsed shortcut legend. It works when clicked, but a
  // control the page renders at no size is a control the page may move, resize
  // or stop drawing without telling anyone, so closing the modal is best-effort
  // and is reported as such. A reviewer left open with no composed message in it
  // is untidy; a composer left open with one is a message to a stranger.
  //
  // Both are anchored for the same reason `Accept` is: an unanchored /exit/i
  // would reach an "Exit interview" block, and a teardown that clicks the wrong
  // thing is a teardown that can act on a candidate.
  const CANCEL_LABEL = /^cancel response$/i;
  const EXIT_LABEL = /^exit$/i;
  // Nothing on the way out may read as either irreversible verb. `clickSafely`
  // already refuses reject; leaving refuses accept as well, because the one
  // thing teardown must never do is finish a send it was called to abandon.
  const LEAVING_FORBIDDEN = /accept|reject/i;
  // Never clicked, whatever else matched.
  const REJECT_TEXT = /reject/i;
  // Never sent. `R` is Reject and `X` is Quick Reject, one key from `A`.
  // The candidate's identity, as the modal carries it:
  // /link/{userId}/{token}/resume_url. The same id the ledger and the CSV key
  // on. There is no name-based fallback anywhere in this file, on purpose.
  const LINK_ID = /\/link\/(\d+)\/[^/]+\/resume_url/;
  const COUNTER = /(\d+)\s+of\s+(\d+)/;
  // An unsubstituted token in the composed message. Sending one puts a literal
  // bracket in a stranger's inbox.
  const LEFTOVER_TOKEN = /\[[a-z_]+\]/i;

  // This file distinguishes two classes of failure and the distinction is the
  // whole of what the panel can tell the operator afterwards. A refusal raised
  // BEFORE Send is clicked is certain: no message went anywhere. Once the
  // extension dispatches that click, whether Wellfound committed it can be
  // ambiguous, and only that case may send the operator to Wellfound to check.
  //
  // The wire between the two worlds carries a string and nothing else - the
  // bridge relays `error` text - so the classification travels in the text. This
  // phrase is the contract. It reads as English because it is the sentence the
  // operator sees; it is appended verbatim rather than composed, because the
  // panel matches on it. The panel holds the same constant (accept-pass.js) and
  // a test asserts the two are identical, exactly as the message type strings
  // above are duplicated from src/lib/messages.js and checked.
  //
  // The polarity is deliberate: only certainty is marked. An error this file
  // never wrote - a relay timeout, an exception from somewhere unforeseen -
  // carries no mark and is therefore treated as unclear, which is the safe
  // reading of an outcome nobody can vouch for.
  const NOTHING_SENT = 'nothing was sent';

  // Every pre-arm refusal goes through here, so none can be written without
  // the phrase and none can drift in wording.
  function refuse(what) {
    return new Error(`${what}; ${NOTHING_SENT}`);
  }

  // A pause is served in slices so a stop lands inside it rather than after it.
  const PAUSE_SLICE_MS = 100;
  // How long the page is given to show that a send landed, INSIDE this round
  // trip. It is the fast path and it is no longer the deadline for anything.
  //
  // It was 15000, then 40000, and both were wrong in the same way: each was one
  // worst case behind the page. 15000 came from a 20-applicant role resolving in
  // 5-9 s; a 111-applicant role then measured 35.9 s; and a 101-applicant role
  // has since been measured at 25-66 s per accept ON FRESHLY RELOADED
  // DOCUMENTS - so it is not degradation, a large role is simply slow from the
  // first accept, and no constant here can be sized against that.
  //
  // The mistake was not the number, it was that the number decided an outcome.
  // Running out now means `pending`, the panel keeps watching the same two
  // signals with no message round trip holding them open, and a 66 s accept is
  // booked as an ordinary accept.
  //
  // So this reverts to what the healthy band actually is: 5-9 s measured, 12000
  // to cover it with room. Being wrong here costs one panel-side look and no
  // requests at all, which is the whole point of it not being load-bearing.
  const CONFIRM_TIMEOUT_MS = 12000;
  const CONFIRM_POLL_MS = 250;
  const COMPOSER_TIMEOUT_MS = 5000;
  const COMPOSER_POLL_MS = 100;
  const SEND_READY_TIMEOUT_MS = 5000;
  const SEND_READY_POLL_MS = 100;
  // Teardown is not allowed to be slow. It runs after the pass has already
  // ended, so the operator is waiting on it with nothing left to watch, and a
  // control that does not respond in two seconds is reported rather than waited
  // on.
  const TEARDOWN_TIMEOUT_MS = 2000;
  const TEARDOWN_POLL_MS = 100;

  // The longest an ACCEPT_CANDIDATE round trip may occupy, and the reason the
  // pauses below are clamped rather than trusted.
  //
  // The bridge (src/content/bridge.js) gives every message a budget, and if that
  // budget expires around a send the panel is told the page went quiet while the
  // message is still going out: booked as failed, absent from the ledger, and a
  // candidate for being messaged again on a later run. The two numbers used to
  // live in two files with no stated relationship and roughly 2 s between them.
  //
  // So this file states its own worst case, in its own constants, and enforces
  // it: the panel hands the pauses in, and whatever it hands in, the driver
  // honours no more than these. The upper bounds mirror PACING.beforePasteMs
  // and PACING.afterPasteMs in src/lib/jitter.js - duplicated here for the same
  // reason the message types are, since a MAIN-world classic script cannot
  // import - and a clamp cannot drift the wrong way: a panel that samples higher
  // is bounded, and one that samples lower is simply obeyed.
  const MAX_BEFORE_PASTE_MS = 5000;
  const MAX_AFTER_PASTE_MS = 3000;
  // Poll granularity (a waitFor may overshoot its deadline by one interval),
  // click dispatch, and the page's own re-render. Not measured, deliberately
  // generous, and inside the figure below rather than outside it.
  const ACCEPT_SLACK_MS = 2000;
  // 5000 + 5000 + 3000 + 5000 + 12000 + 2000 = 32000, plus the message-length
  // dependent typing time. bridge.js adds that final term from the payload; a
  // test fails if the fixed parts ever stop agreeing.
  const ACCEPT_WORST_CASE_MS =
    COMPOSER_TIMEOUT_MS +
    MAX_BEFORE_PASTE_MS +
    MAX_AFTER_PASTE_MS +
    SEND_READY_TIMEOUT_MS +
    CONFIRM_TIMEOUT_MS +
    ACCEPT_SLACK_MS;

  // A pause the driver is willing to serve. Not an error when it is exceeded:
  // the panel's pacing is a courtesy, and the bound is this file's own promise
  // about how long it may hold the wire.
  function clampPause(ms, max) {
    const asked = Math.max(0, Number(ms) || 0);
    return asked > max ? max : asked;
  }

  // --- the page ---------------------------------------------------------------

  function pageRoot() {
    return document.body || document;
  }

  // The reviewer modal, or the whole page if it does not announce itself as a
  // dialog. Widening the search can only make the exactly-one guard below more
  // likely to abort, never less.
  function dialogRoot() {
    return reviewerRoot() || pageRoot();
  }

  // The modal itself, or null. Every operation reads through dialogRoot, which
  // widens to the page rather than failing; teardown is the one caller that
  // needs the narrow answer, because "there is no modal" is its success case
  // and not something to go looking for controls about.
  function reviewerRoot() {
    return document.querySelector('[role="dialog"]');
  }

  function text(el) {
    return String(el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  // What a click could plausibly reach: the accessible label as well as the
  // visible text, because a control can read `Reject` to a screen reader and
  // show an icon.
  function label(el) {
    return `${text(el)} ${el?.getAttribute?.('aria-label') ?? ''}`.trim();
  }

  // The page saying an element is not part of it. Two different claims live in
  // the two halves below, and separating them is what lets one predicate serve
  // acting and another serve leaving.
  function isPresent(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.getAttribute?.('aria-hidden') === 'true') return false;
    return true;
  }

  // Whether the operator can actually SEE it. A collapsed region draws its
  // controls at 0 x 0 while they remain perfectly real - measured on the live
  // page, where the keyboard-shortcut legend renders `Exit`, `Reject` and
  // `Accept` as enabled, unhidden buttons with no box at all.
  function hasBox(el) {
    if (typeof el?.getBoundingClientRect !== 'function') return true;
    const rect = el.getBoundingClientRect();
    return Boolean(rect) && rect.width > 0 && rect.height > 0;
  }

  function isVisible(el) {
    return isPresent(el) && hasBox(el);
  }

  function isEnabled(el) {
    return !el.disabled && el.getAttribute?.('aria-disabled') !== 'true';
  }

  function controlsMatching(scope, pattern) {
    return Array.from(scope.querySelectorAll('button, [role="button"]')).filter((el) =>
      pattern.test(text(el)),
    );
  }

  // ACTING. Everything on the way IN goes through here, and the box test is
  // load-bearing: a second `Accept` the operator cannot see is genuine
  // ambiguity about what a click does, and the cost of guessing is an
  // irreversible message. Measured live, `/^accept$/i` matches 2 controls and
  // exactly 1 of them has a box. That is this predicate working.
  function usableControls(scope, pattern) {
    const matching = controlsMatching(scope, pattern);
    return { matching, usable: matching.filter((el) => isVisible(el) && isEnabled(el)) };
  }

  // LEAVING, which turned out to be a different question, and the live page is
  // what said so.
  //
  // `Exit` is one control, uniquely labelled, enabled, not hidden - and drawn
  // at 0 x 0, because the legend holding it is collapsed. Clicking it closes
  // the reviewer; that was verified directly. Judged by the predicate above it
  // is `1 matched by text, none usable`, so teardown declined, turned that into
  // a note rather than a throw, and left the modal standing in silence - the
  // exact zombie the teardown was built to end.
  //
  // A box is a proxy for "is it obvious what this click does", and that
  // question belongs to acting. What leaving actually requires is that exactly
  // one control carries the label and that it cannot read as accept or reject,
  // which clickToLeave settles on its own. So the box test is dropped here and
  // NOWHERE ELSE. Presence still counts: `hidden` and `aria-hidden` are the page
  // stating the element is not part of it, which is a different claim from its
  // layout being collapsed, and the only one of the two worth obeying on the
  // way out.
  function reachableControls(scope, pattern) {
    const matching = controlsMatching(scope, pattern);
    return { matching, usable: matching.filter((el) => isPresent(el) && isEnabled(el)) };
  }

  // Exactly one visible, enabled control whose label matches - or nothing
  // happens. Zero and two are both aborts: on the real page the text `Accept`
  // matches two elements, and picking "the first one" is how an extension ends
  // up clicking a legend row, or worse, whatever sits next to it. `Accept`,
  // `Accept application & send message` and `Next applicant` are all singular on
  // the real page, and all three are read through here.
  function uniqueControl(scope, pattern, name) {
    const { matching, usable } = usableControls(scope, pattern);
    if (usable.length === 0) {
      throw new Error(
        `Could not find the ${name} control (${matching.length} matched by text, none usable)`,
      );
    }
    if (usable.length > 1) {
      throw new Error(`Found ${usable.length} ${name} controls, expected exactly one`);
    }
    return usable[0];
  }

  // The other situation, and the reason it gets its own name rather than a flag
  // on the one above: on the applicant list `View application` appears once per
  // card - fifteen matches on a full page, all visible and enabled - and that
  // is the page working normally, not ambiguity about what a click will do.
  // Which one is clicked still matters, so the choice is not arbitrary; see
  // openReviewer.
  function firstOfMany(scope, pattern, name) {
    const { matching, usable } = usableControls(scope, pattern);
    if (usable.length === 0) {
      throw new Error(
        `Could not find a ${name} control (${matching.length} matched by text, none usable)`,
      );
    }
    return usable[0];
  }

  // The single place a click happens, so the never-reject guard sits at the
  // point of clicking rather than at the call site. A caller that mistakenly
  // hands this the Reject button gets an abort, not a rejection.
  function clickSafely(el, name) {
    const seen = label(el);
    if (REJECT_TEXT.test(seen)) {
      throw new Error(`Refusing to click a reject control (asked for ${name}, found "${seen}")`);
    }
    el.click();
  }

  // The way out of a state, as distinct from the way through it. A missing
  // control is an answer here rather than a throw: teardown asks about controls
  // that legitimately may not be on the page, and two matches means the same
  // thing it means everywhere else in this file - do not click.
  function leavingControl(scope, pattern, name) {
    const { matching, usable } = reachableControls(scope, pattern);
    if (usable.length === 1) return { el: usable[0], note: null };
    if (usable.length === 0) {
      return { el: null, note: `no usable ${name} control (${matching.length} matched by text)` };
    }
    return { el: null, note: `found ${usable.length} ${name} controls, so clicked none` };
  }

  // Leaving goes through clickSafely like everything else, so the never-reject
  // guard covers it - and through this extra refusal first. The controls above
  // are anchored and cannot match `Accept application & send message` today;
  // this is the guard that keeps that true after somebody renames a button. A
  // teardown that cannot find its way out must leave the page alone, never
  // press the nearest thing.
  function clickToLeave(el, name) {
    const seen = label(el);
    if (LEAVING_FORBIDDEN.test(seen)) {
      throw new Error(`Refusing to click "${seen}" on the way out (asked for ${name})`);
    }
    clickSafely(el, name);
  }

  function wait(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  // The run's abort, as this document can see it. The panel owns the signal and
  // cannot hand an AbortSignal across the world boundary, so it sends STOP and
  // this flag is what an in-flight accept reads. Cleared when the reviewer is
  // opened, which is where a pass begins.
  let stopped = false;

  // True from the first guard of an accept to the moment its outcome is known.
  // Read by teardown and by nothing else: an accept and a teardown are two
  // drivers of the same modal, and the only one of the two that is allowed to
  // touch it while a send is unresolved is the one that knows whether the send
  // happened.
  let accepting = false;

  // Sleeping in slices, so a stop pressed four seconds into a five-second pause
  // is felt now rather than at the end of it. The panel's own sleep is
  // abort-aware for the same reason; this is that idea, one boundary further in.
  async function pause(ms) {
    const total = Math.max(0, Number(ms) || 0);
    let left = total;
    while (left > 0 && !stopped) {
      const slice = left < PAUSE_SLICE_MS ? left : PAUSE_SLICE_MS;
      await wait(slice);
      left -= slice;
    }
  }

  // Polls a condition to a deadline and reports what it was waiting for. Never
  // repeats an action - only a read.
  async function waitFor(check, { timeoutMs, pollMs, what }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = check();
      if (result) return result;
      if (Date.now() >= deadline) throw new Error(what);
      await wait(pollMs);
    }
  }

  // --- who is on screen -------------------------------------------------------

  // Identity, exactly, or an error. Never a null and never the displayed name:
  // a modal whose id cannot be read is a stop condition for the whole run.
  function readUserId(scope) {
    const ids = new Set();
    for (const anchor of Array.from(scope.querySelectorAll('a'))) {
      const match = LINK_ID.exec(anchor.getAttribute('href') ?? '');
      if (match) ids.add(match[1]);
    }
    if (ids.size === 0) throw new Error('Could not read the candidate id from the reviewer');
    if (ids.size > 1) {
      throw new Error(`The reviewer shows ${ids.size} candidate ids at once; stopping`);
    }
    return Array.from(ids)[0];
  }

  // `N of M`. M shrinks as accepts drain the bucket, which is what confirms a
  // send landed.
  function readCounter(scope) {
    const match = COUNTER.exec(text(scope));
    if (!match) throw new Error('Could not read the reviewer position counter');
    return { index: Number(match[1]), total: Number(match[2]) };
  }

  function readCurrent() {
    const scope = dialogRoot();
    return { userId: readUserId(scope), ...readCounter(scope) };
  }

  // The same read, for polling, where "not yet" and "not readable" are the same
  // answer and neither is a reason to act.
  function readCurrentOrNull() {
    try {
      return readCurrent();
    } catch {
      return null;
    }
  }

  // --- operations -------------------------------------------------------------

  // One click. Not two, and no retry: the double-click that was once observed
  // was an artifact of a scrolling harness, and a second click on a modal that
  // is already open lands somewhere unknown.
  //
  // Which opener is clicked decides where the reviewer opens: card N opens the
  // reviewer AT position N. The first card gives `1 of M`, which is where the
  // loop wants to be - a confirmed accept holds the index and drains the
  // bucket, so position 1 is a place to stay rather than a place to start.
  // Where it landed is read back from the same DOM the rest of this file
  // trusts, rather than assumed from which button was clicked.
  async function openReviewer() {
    stopped = false;
    clickSafely(firstOfMany(pageRoot(), OPEN_LABEL, 'View application'), 'View application');
    const at = await waitFor(() => readCurrentOrNull(), {
      timeoutMs: COMPOSER_TIMEOUT_MS,
      pollMs: COMPOSER_POLL_MS,
      what: 'The reviewer did not open',
    });
    if (at.index !== 1) {
      throw new Error(`The reviewer opened at position ${at.index}, not 1`);
    }
    return { opened: true, ...at };
  }

  // Advance past the current candidate without acting on them. A click, not a
  // key: a synthetic ArrowRight was measured moving the reviewer not at all.
  async function skipCurrent() {
    const before = readCurrent();
    clickSafely(uniqueControl(dialogRoot(), NEXT_LABEL, 'Next applicant'), 'Next applicant');
    return waitFor(
      () => {
        const now = readCurrentOrNull();
        if (!now) return null;
        // Skipping and accepting move the reviewer in two different, measured
        // ways: a skip raises the index and leaves the total alone
        // (1 of 115 -> 2 of 115); an accept holds the index and drops the total
        // (1 of 116 -> 1 of 115). Reusing the accept's signal here would let a
        // skip report success for a message that had gone out.
        const moved = now.userId !== before.userId && now.index > before.index;
        return moved && now.total === before.total ? now : null;
      },
      {
        timeoutMs: CONFIRM_TIMEOUT_MS,
        pollMs: CONFIRM_POLL_MS,
        what: 'The reviewer did not move on to the next candidate',
      },
    );
  }

  // Every userId this document has already been asked to accept. A send is
  // never repeated - not after a timeout, not after an unclear outcome, not on
  // a second call. A repeated accept is a second message to somebody who
  // already received one.
  const sent = new Set();
  const TYPING_INTERVAL_MS = Number(globalThis.__WFX_TYPING_INTERVAL_MS__ ?? 20);

  // React can render the uniquely labelled Send control before its layout and
  // enabled state catch up, especially immediately after the scheduled page
  // reload. Poll only its state; never repeat the Accept click or guess between
  // controls. The final diagnostic retains the exact census used elsewhere.
  async function waitForUniqueControl(scope, pattern, name) {
    const deadline = Date.now() + SEND_READY_TIMEOUT_MS;
    for (;;) {
      const { matching, usable } = usableControls(scope, pattern);
      if (usable.length === 1) return usable[0];
      if (usable.length > 1) {
        throw new Error(`Found ${usable.length} ${name} controls, expected exactly one`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Could not find the ${name} control (${matching.length} matched by text, none usable)`,
        );
      }
      await wait(SEND_READY_POLL_MS);
    }
  }

  // One round trip, deliberately, pauses and all. Splitting this into open /
  // type / arm would let a stopped or failed run leave a half-open composer
  // on the page, and - worse - would put a message boundary between the
  // identity re-read and the arming it guards. The two pause lengths are sampled
  // by the panel from the same PACING the rest of the run uses and handed in;
  // this file owns no timings of its own, and treats a missing one as no pause
  // rather than inventing a number.
  // Everything that happens before Send is clicked: the guards, the
  // composer, incremental entry and the identity re-read. It is a function of
  // its own so that "nothing has gone out yet" is a structural property of a region
  // rather than a claim repeated at each throw - every failure in here, named
  // or unforeseen, is caught by the one handler below and marked certain.
  async function prepareSend({ expected, message, beforePasteMs, afterPasteMs }) {
    if (!expected) throw new Error('Refusing to accept without an expected candidate id');
    if (typeof message !== 'string' || message.trim() === '') {
      throw new Error('Refusing to send an empty message');
    }
    if (LEFTOVER_TOKEN.test(message)) {
      throw new Error('Refusing to send a message with an unsubstituted token');
    }
    if (sent.has(expected)) {
      throw new Error(`Already sent an accept to ${expected}; refusing to send a second`);
    }

    const before = readCurrent();
    if (before.userId !== expected) {
      throw new Error(`The reviewer is showing ${before.userId}, not ${expected}`);
    }

    // Open the composer by clicking, never by pressing `A`: the keyboard puts
    // Reject and Quick Reject one key away from the intent.
    clickSafely(uniqueControl(dialogRoot(), ACCEPT_LABEL, 'Accept'), 'Accept');
    await waitFor(() => composerBox(), {
      timeoutMs: COMPOSER_TIMEOUT_MS,
      pollMs: COMPOSER_POLL_MS,
      what: 'The response composer did not open',
    });

    // A beat while the composer opens and the wording is gathered. Clamped, so
    // this round trip cannot outlast the budget the relay gives it however the
    // panel sampled.
    await pause(clampPause(beforePasteMs, MAX_BEFORE_PASTE_MS));
    if (stopped) throw new Error('Stopped before the message was entered');
    await typeMessage(composerBox(), message);
    // A beat to read it back.
    await pause(clampPause(afterPasteMs, MAX_AFTER_PASTE_MS));
    // After the pause and before dispatch, so a stop during either pause takes
    // effect while nothing has yet gone out. Past this point a send is
    // possible, and nothing here ever retries one.
    if (stopped) throw new Error('Stopped before the message was sent');

    const send = await waitForUniqueControl(
      dialogRoot(),
      SEND_LABEL,
      'Accept application & send message',
    );
    // Everything above this line took time. The actual click boundary below
    // reacquires this control and re-reads both identity and message.
    const atTheClick = readUserId(dialogRoot());
    if (atTheClick !== expected) {
      throw new Error(`The reviewer moved to ${atTheClick} before the send`);
    }
    return { before };
  }

  // The wrapper exists for the flag and for nothing else: for as long as an
  // accept is unresolved, no other operation in this file may drive the modal.
  async function acceptCurrent(payload) {
    accepting = true;
    try {
      return await runAccept(payload ?? {});
    } finally {
      accepting = false;
    }
  }

  async function runAccept({ expectedUserId, message, beforePasteMs, afterPasteMs } = {}) {
    const expected = expectedUserId == null ? '' : String(expectedUserId);

    let before;
    try {
      ({ before } = await prepareSend({
        expected,
        message,
        beforePasteMs,
        afterPasteMs,
      }));
    } catch (error) {
      // Send was never clicked, so this is the certain half of the
      // contract. Marked here and only here: one site, guarding one region,
      // rather than a phrase each throw has to remember to carry.
      throw refuse(String(error.message || error));
    }

    // Reacquire rather than trusting an element retained across the async
    // preparation boundary. React may have replaced the DOM while preserving
    // the visible composer. Both identity and the exact message are checked in
    // the same synchronous turn as the irreversible click.
    let liveSend;
    try {
      const scope = dialogRoot();
      liveSend = uniqueControl(scope, SEND_LABEL, 'Accept application & send message');
      const { usable } = usableControls(scope, SEND_LABEL);
      if (usable.length !== 1 || usable[0] !== liveSend) {
        throw new Error('The Accept application & send message control is no longer uniquely usable');
      }
      const atDispatch = readUserId(scope);
      if (atDispatch !== expected) {
        throw new Error(`The reviewer moved to ${atDispatch} before the send`);
      }
      const liveBox = composerBox();
      if (!liveBox || liveBox.value !== message) {
        throw new Error('The response message changed before the send');
      }
    } catch (error) {
      // This whole region is synchronously before sent.add/clickSafely. DOM
      // churn here is therefore a certain refusal, not an ambiguous send.
      throw refuse(String(error.message || error));
    }

    // Record before the irreversible click. If dispatch or the page dies after
    // receiving it, this document must not attempt the candidate again and the
    // outcome remains ambiguous rather than being called a certain refusal.
    sent.add(expected);
    clickSafely(liveSend, 'Accept application & send message');

    // The extension has clicked the unique Send control. Everything below is
    // observation of whether Wellfound drained the queue; nothing retries it.

    // The only honest confirmation: this candidate is gone from the slot AND
    // the bucket drained by one. Accepting removes them, so the next person
    // slides into the same position - which also means the caller must NOT
    // advance afterwards, or it skips somebody.
    //
    // This wait is now the FAST PATH and nothing more. It used to be the whole
    // confirmation, and its expiry was raised to the panel as a send nobody
    // could vouch for - which is why the number was revised twice, each time
    // one worst case behind the page. It is not a bet on how long Wellfound
    // takes any more: running out is an ordinary result on a large role, it is
    // reported as `pending` rather than thrown, and the panel goes on watching
    // the same two signals without a message round trip holding them.
    //
    // So the predicate below is the ONE definition of "the send landed" in this
    // extension, and the panel re-applies exactly it. What differs between the
    // two is only who is waiting and for how long.
    const landed = () => {
      const now = readCurrentOrNull();
      return now && now.userId !== expected && now.total < before.total ? now : null;
    };
    let next = null;
    try {
      next = await waitFor(landed, {
        timeoutMs: CONFIRM_TIMEOUT_MS,
        pollMs: CONFIRM_POLL_MS,
        what: 'pending',
      });
    } catch {
      // Not an error and deliberately not thrown. `total` is what the panel
      // needs to keep watching - the denominator before dispatch - and
      // `reason` is the sentence to use if the watching runs out too, kept here
      // because this is the account of what happened after arming and the panel
      // does not compose those.
      return {
        userId: expected,
        accepted: false,
        pending: true,
        total: before.total,
        reason:
          `Could not confirm whether Wellfound committed the accept for ${expected} after the extension clicked Send - ` +
          'check the candidate in Wellfound before running again. Nothing was retried.',
      };
    }
    return { userId: expected, accepted: true, next };
  }

  // --- the composer -----------------------------------------------------------

  function composerBox() {
    const scope = dialogRoot();
    const box = scope.querySelector('textarea');
    if (!box) return null;
    // The composer is open only once its confirm button exists; a stray
    // textarea elsewhere on the page is not the composer.
    return hasSendControl(scope) ? box : null;
  }

  function hasSendControl(scope) {
    return Array.from(scope.querySelectorAll('button, [role="button"]')).some((el) =>
      SEND_LABEL.test(text(el)),
    );
  }

  // Enter the message one character at a time through the textarea's native
  // value setter and the same beforeinput/input notifications React consumes.
  // Character KeyboardEvents are deliberately absent: the reviewer binds A,
  // R and X at document level, and message text must never become shortcuts.
  async function typeMessage(box, message) {
    if (typeof box.focus === 'function') box.focus();
    const proto =
      typeof globalThis.HTMLTextAreaElement === 'function'
        ? globalThis.HTMLTextAreaElement.prototype
        : null;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
    let entered = '';
    const characters = [...message];
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index];
      if (typeof InputEvent === 'function') {
        const before = new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          data: character,
          inputType: 'insertText',
        });
        if (!box.dispatchEvent(before)) throw new Error('The composer refused message input');
      }
      entered += character;
      if (setter) setter.call(box, entered);
      else box.value = entered;
      if (typeof InputEvent === 'function') {
        box.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            data: character,
            inputType: 'insertText',
          }),
        );
      } else if (typeof Event === 'function') {
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // A yield between characters is what makes this actual visible typing
      // rather than a synchronous series of mutations painted as one paste.
      if (index < characters.length - 1) await pause(TYPING_INTERVAL_MS);
    }
    if (box.value !== message) throw new Error('The message did not reach the composer');
  }

  // --- leaving ----------------------------------------------------------------

  // The way out, for every state this file can leave the page in.
  //
  // There are three, and they nest. NOTHING OPEN: the pass never touched the
  // modal, or already left it - there is nothing to do and saying so is the
  // whole answer. REVIEWER OPEN, NO COMPOSER: a read failed, a skip failed, the
  // operator stopped between candidates - one click on `Exit`. REVIEWER OPEN
  // WITH THE COMPOSER EXPANDED: the dangerous one, because the operator's
  // message is sitting in the textarea one click from a real person's inbox.
  // `Cancel response` clears it, and only then does `Exit` close what is left.
  //
  // Three properties hold whatever it finds:
  //
  //   - It never throws. It runs on the way out of a pass that may already be
  //     carrying the error the operator needs to read, and a teardown that
  //     throws over that error replaces a message about a candidate with a
  //     message about a button. Every failure becomes a note in the report.
  //   - It never sends. Every click goes through clickToLeave, which refuses
  //     anything reading `accept` or `reject`, and then through clickSafely.
  //     Ambiguity - two matches - clicks nothing at all.
  //   - It is safe to call when there is nothing to tear down, twice in a row,
  //     or on a page that was never the reviewer.
  //
  // What it does NOT do is interrupt an accept. While one is unresolved the
  // modal belongs to it: clicking `Cancel response` next to a send that may
  // have landed is how a teardown becomes the thing that needed tearing down.
  //
  // The two steps are not equal, and the report says which is which rather than
  // averaging them into one boolean. Clearing the composer is the guarantee -
  // it is what stops a message reaching somebody who was never meant to get
  // one. Closing the modal afterwards is best-effort, because the control that
  // does it is drawn at no size and could stop being findable without warning.
  // A run that cancels and cannot exit has removed the hazard and left a mess;
  // saying so plainly is more use than a note that reads like a failure.
  async function closeReviewer() {
    const report = { cancelled: false, closed: false, notes: [] };

    if (accepting) {
      report.notes.push('an accept is still in flight; left the reviewer alone');
      return report;
    }
    if (!reviewerRoot()) {
      report.closed = true;
      return report;
    }

    const hadComposer = Boolean(composerBox());
    if (hadComposer) {
      await leave(CANCEL_LABEL, 'Cancel response', () => !composerBox(), report, 'cancelled');
    }
    if (reviewerRoot()) {
      await leave(EXIT_LABEL, 'Exit', () => !reviewerRoot(), report, 'closed');
    } else {
      report.closed = true;
    }

    // The sentence an operator would want, assembled once from what actually
    // happened rather than left for a reader to infer from two booleans and a
    // list of button names.
    if (!report.closed) {
      report.notes.push(
        report.cancelled || !hadComposer
          ? 'The reviewer is still open on Wellfound, but nothing is composed in it and ' +
              'nothing can be sent from it. Close the tab or press Exit when convenient.'
          : 'The reviewer is still open on Wellfound WITH A COMPOSED MESSAGE IN IT. ' +
              'Nothing was sent. Cancel that response in Wellfound before touching the page.',
      );
    }
    return report;
  }

  // One step of the walk out: find the control, click it, and confirm the state
  // it was supposed to leave is actually gone. Confirmation matters as much
  // here as it does after a send - "clicked Cancel" is not "the message is no
  // longer in the box" - but its failure is a note, never a throw.
  async function leave(pattern, name, gone, report, field) {
    const { el, note } = leavingControl(dialogRoot(), pattern, name);
    if (!el) {
      report.notes.push(note);
      return;
    }
    try {
      clickToLeave(el, name);
      await waitFor(gone, {
        timeoutMs: TEARDOWN_TIMEOUT_MS,
        pollMs: TEARDOWN_POLL_MS,
        what: `Clicked ${name}, but the page did not respond to it`,
      });
      report[field] = true;
    } catch (error) {
      report.notes.push(String(error.message || error));
    }
  }

  // --- the wire ---------------------------------------------------------------

  const handlers = {
    OPEN_REVIEWER: async () => openReviewer(),
    READ_CANDIDATE: async () => readCurrent(),
    ACCEPT_CANDIDATE: (payload) => acceptCurrent(payload),
    SKIP_CANDIDATE: () => skipCurrent(),
    // The operator pressed stop. It arrives on its own round trip, while an
    // accept may still be sitting in one of its pauses, and that is the point:
    // the flag is what the pause and the pre-send check read.
    STOP: async () => {
      stopped = true;
      return { stopped: true };
    },
    // Leaving, which is deliberately NOT part of the message above.
    //
    // STOP is a signal and must stay one: it arrives DURING an accept, has to
    // answer immediately, and must touch nothing - a STOP that also clicked
    // would be clicking the modal an unfinished send is still holding. Teardown
    // is an action, and it is only correct AFTER the pass has unwound.
    //
    // They also do not cover the same occasions. Most teardowns follow no stop
    // at all: a guard refusing, a read failing, a pass simply finishing. Sending
    // STOP on those would record that the operator pressed stop when they did
    // not, and would leave the flag set for the next pass to clear. One message
    // per idea, and these are two ideas.
    CLOSE_REVIEWER: () => closeReviewer(),
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'wfx-cs' || !handlers[msg.type]) return;
    try {
      const data = await handlers[msg.type](msg.payload);
      window.postMessage({ source: 'wfx-page', id: msg.id, ok: true, data }, '*');
    } catch (error) {
      window.postMessage(
        { source: 'wfx-page', id: msg.id, ok: false, error: String(error.message || error) },
        '*',
      );
    }
  });

  // The test seam, exactly as collector.js has one and for the same reason: a
  // MAIN world classic script cannot export, so the harness pre-defines this
  // container and gets the real functions back. Nothing in the extension and
  // nothing on Wellfound's page defines it, so in a browser this is dead code.
  if (globalThis.__WFX_REVIEWER__) {
    Object.assign(globalThis.__WFX_REVIEWER__, {
      openReviewer,
      readCurrent,
      readUserId,
      readCounter,
      acceptCurrent,
      skipCurrent,
      closeReviewer,
      // The budget this file promises to stay inside for one accept. Exposed so
      // the relay's own budget can be checked against it rather than against a
      // number somebody added up in a comment once.
      ACCEPT_WORST_CASE_MS,
      uniqueControl,
      waitForUniqueControl,
      firstOfMany,
      // Both predicates, so a test can count what the driver counts rather than
      // reimplement it and agree with itself - and so the difference between
      // them is something the harness can measure rather than take on trust.
      usableControls,
      reachableControls,
      clickSafely,
      typeMessage,
      pause,
      handlers,
      sent,
      TYPING_INTERVAL_MS,
      // Exposed so a test can assert the panel's copy of it is the same string.
      // A silent divergence here turns "stopped, nothing was sent" back into
      // the alarm it exists to stop crying wolf with.
      NOTHING_SENT,
    });
  }
})();
