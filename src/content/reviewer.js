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
  // Never clicked, whatever else matched.
  const REJECT_TEXT = /reject/i;
  // Never sent. `R` is Reject and `X` is Quick Reject, one key from `A`.
  const FORBIDDEN_KEYS = /^(r|x)$/i;
  // The candidate's identity, as the modal carries it:
  // /link/{userId}/{token}/resume_url. The same id the ledger and the CSV key
  // on. There is no name-based fallback anywhere in this file, on purpose.
  const LINK_ID = /\/link\/(\d+)\/[^/]+\/resume_url/;
  const COUNTER = /(\d+)\s+of\s+(\d+)/;
  // An unsubstituted token in the composed message. Sending one puts a literal
  // bracket in a stranger's inbox.
  const LEFTOVER_TOKEN = /\[[a-z_]+\]/i;

  const CONFIRM_TIMEOUT_MS = 15000;
  const CONFIRM_POLL_MS = 250;
  const COMPOSER_TIMEOUT_MS = 5000;
  const COMPOSER_POLL_MS = 100;

  // --- the page ---------------------------------------------------------------

  function pageRoot() {
    return document.body || document;
  }

  // The reviewer modal, or the whole page if it does not announce itself as a
  // dialog. Widening the search can only make the exactly-one guard below more
  // likely to abort, never less.
  function dialogRoot() {
    return document.querySelector('[role="dialog"]') || pageRoot();
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

  function isVisible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.getAttribute?.('aria-hidden') === 'true') return false;
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    }
    return true;
  }

  function isEnabled(el) {
    return !el.disabled && el.getAttribute?.('aria-disabled') !== 'true';
  }

  function usableControls(scope, pattern) {
    const controls = Array.from(scope.querySelectorAll('button, [role="button"]'));
    const matching = controls.filter((el) => pattern.test(text(el)));
    return { matching, usable: matching.filter((el) => isVisible(el) && isEnabled(el)) };
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

  // Nothing in this file calls this, and nothing should. Measured on the live
  // page: a synthetic keydown+keyup for ArrowRight on the document moved the
  // reviewer not at all - userId and `1 of 115` both unchanged - because a
  // scripted KeyboardEvent is not a trusted one and never reaches the site's
  // handlers. The reviewer's shortcut legend advertises keys the extension
  // therefore cannot use, so every operation here clicks instead.
  //
  // It stays as the single gate any future key path would have to pass through,
  // refusing R (Reject) and X (Quick Reject) - a guard over something that
  // provably cannot happen today, kept because the cost of being wrong about
  // that is a rejected candidate.
  function sendKey(key) {
    if (FORBIDDEN_KEYS.test(key)) {
      throw new Error(`Refusing to send the ${key} key: it rejects the candidate`);
    }
    if (typeof KeyboardEvent !== 'function') {
      throw new Error('Cannot send a key on this page');
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }

  function wait(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
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

  async function acceptCurrent({ expectedUserId, message } = {}) {
    const expected = expectedUserId == null ? '' : String(expectedUserId);
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
    typeMessage(composerBox(), message);

    const send = uniqueControl(dialogRoot(), SEND_LABEL, 'Accept application & send message');
    // Identity, re-read immediately before the click and nowhere else that
    // matters. Everything above this line took time, and the reviewer is
    // positional: if it moved while the composer was opening, the click below
    // would message whoever slid into the slot.
    const atTheClick = readUserId(dialogRoot());
    if (atTheClick !== expected) {
      throw new Error(`The reviewer moved to ${atTheClick} before the send; nothing was sent`);
    }
    // Recorded before the click, not after. If the click throws or the page
    // dies mid-send, the message may still have gone out, and this document
    // must never be talked into sending it again.
    sent.add(expected);
    clickSafely(send, 'Accept application & send message');

    // The only honest confirmation: this candidate is gone from the slot AND
    // the bucket drained by one. Accepting removes them, so the next person
    // slides into the same position - which also means the caller must NOT
    // advance afterwards, or it skips somebody.
    const next = await waitFor(
      () => {
        const now = readCurrentOrNull();
        return now && now.userId !== expected && now.total < before.total ? now : null;
      },
      {
        timeoutMs: CONFIRM_TIMEOUT_MS,
        pollMs: CONFIRM_POLL_MS,
        what:
          `Could not confirm the accept for ${expected}. It may or may not have been sent - ` +
          'check the candidate in Wellfound before running again. Nothing was retried.',
      },
    );
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

  // React does not see a plain `value =` assignment, so the native setter is
  // used where one exists and the input event is dispatched by hand.
  function typeMessage(box, message) {
    const proto =
      typeof globalThis.HTMLTextAreaElement === 'function'
        ? globalThis.HTMLTextAreaElement.prototype
        : null;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
    if (setter) setter.call(box, message);
    else box.value = message;
    if (typeof Event === 'function') {
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (box.value !== message) throw new Error('The message did not reach the composer');
  }

  // --- the wire ---------------------------------------------------------------

  const handlers = {
    OPEN_REVIEWER: async () => openReviewer(),
    READ_CANDIDATE: async () => readCurrent(),
    ACCEPT_CANDIDATE: (payload) => acceptCurrent(payload),
    SKIP_CANDIDATE: () => skipCurrent(),
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
      uniqueControl,
      firstOfMany,
      clickSafely,
      sendKey,
      typeMessage,
      handlers,
      sent,
    });
  }
})();
