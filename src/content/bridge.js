// ISOLATED world. A relay and nothing else - no logic, no state beyond pending
// requests. Only the message types below are forwarded.
(() => {
  const ALLOWED = new Set([
    'LIST_JOBS',
    'FETCH_PAGE',
    'QUERY_READY',
    // The applicant reviewer, driven by src/content/reviewer.js. ACCEPT_CANDIDATE
    // sends a real message to a real person and cannot be undone; the relay
    // still has no opinion about that, it only refuses to forward anything not
    // named here.
    'OPEN_REVIEWER',
    'READ_CANDIDATE',
    'ACCEPT_CANDIDATE',
    'SKIP_CANDIDATE',
    'STOP',
    'CLOSE_REVIEWER',
  ]);

  // The budget, and where it comes from.
  //
  // ACCEPT_CANDIDATE is by far the longest message this relay carries, and a
  // budget that expires around one is not a timeout - it is the panel being told
  // the page went quiet while the message is on its way out. The candidate is
  // then booked as failed, never written to the ledger, and is a candidate for
  // being messaged a second time on a later run. Nothing retries the send, but
  // nothing has to: the second run does not know it happened.
  //
  // That budget used to be 30000 against a driver whose own worst case was
  // 28000, in a different file, with the relationship stated nowhere. Two
  // seconds of margin, held by arithmetic in a comment.
  //
  // Now the driver states its worst case and enforces it - src/content/reviewer.js
  // clamps the pauses the panel hands it so that no accept may exceed the figure
  // below - and this is that figure, plus margin. The duplication is the same
  // one the message types above carry, for the same reason: a classic content
  // script cannot import. tests/bridge.test.js reads both constants and fails if
  // they stop agreeing, so the copy cannot drift silently.
  //
  //   composer wait  5000  (COMPOSER_TIMEOUT_MS)
  //   before paste   5000  (clamped, PACING.beforePasteMs upper bound)
  //   after paste    3000  (clamped, PACING.afterPasteMs upper bound)
  //   confirm wait  12000  (CONFIRM_TIMEOUT_MS)
  //   slack          2000  (poll granularity, click dispatch, re-render)
  //                 -----
  //                 27000
  //
  // Smaller than it was, and that is the point rather than a concession. The
  // confirmation no longer happens inside this round trip: the driver reports
  // `pending` when the page has not caught up and the panel goes on watching
  // without holding the wire. So this budget covers the driver's fast path,
  // which is a thing with a measured size, instead of covering however long
  // Wellfound might take, which is not.
  const DRIVER_WORST_CASE_MS = 27000;
  // The margin, and what it is actually an allowance FOR. This used to be
  // described as "half as much again", which is a size and not a reason.
  //
  // The figure above is SCHEDULED time: it is what the driver's own timers and
  // deadlines add up to on a page that lets them run. The driver lives in the
  // MAIN world, on Wellfound's own main thread, and on a large role that thread
  // is not free. Measured: a 111-applicant role took 35.9 s and then 47 s over
  // accepts whose scheduled worst case was 30 s. So wall clock ran past the
  // driver's own arithmetic by more than half again, and it did so because the
  // page starved the driver, not because the driver waited longer.
  //
  // That overrun has no bound this file can state honestly, so this number is
  // not a claim that one exists. It is the point past which waiting stops being
  // the best instrument available: the panel now books an unconfirmed send
  // durably and settles it against the API, so a relay expiry no longer loses a
  // person or ends a role. The measured starvation was more than half again on
  // top of a 30 s budget (a 47 s accept), so it is applied as that proportion
  // of this one rather than carried over as a constant from a budget that no
  // longer exists.
  const MARGIN_MS = 18000;
  const TIMEOUT_MS = DRIVER_WORST_CASE_MS + MARGIN_MS;
  const pending = new Map();
  let counter = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'wfx-page') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg.ok ? { ok: true, data: msg.data } : { ok: false, error: msg.error });
  });

  function ask(type, payload) {
    if (!ALLOWED.has(type)) return Promise.resolve({ ok: false, error: `blocked: ${type}` });
    const id = `wfx-${(counter += 1)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'Page did not respond in time' });
      }, TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      window.postMessage({ source: 'wfx-cs', id, type, payload }, '*');
    });
  }

  // The panel's vocabulary on the left, the page's on the right. A message type
  // absent from this table is not forwarded and not answered.
  // A Map, not an object literal: a lookup table keyed by whatever arrives must
  // not answer for `constructor` or `__proto__`.
  const FROM_PANEL = new Map([
    ['CX_LIST_JOBS', 'LIST_JOBS'],
    ['CX_FETCH_PAGE', 'FETCH_PAGE'],
    ['CX_QUERY_READY', 'QUERY_READY'],
    ['CX_OPEN_REVIEWER', 'OPEN_REVIEWER'],
    ['CX_READ_CANDIDATE', 'READ_CANDIDATE'],
    ['CX_ACCEPT_CANDIDATE', 'ACCEPT_CANDIDATE'],
    ['CX_SKIP_CANDIDATE', 'SKIP_CANDIDATE'],
    ['CX_STOP_REVIEWER', 'STOP'],
    ['CX_CLOSE_REVIEWER', 'CLOSE_REVIEWER'],
  ]);

  // The relay has no logic to reach into and exposes none. These two numbers are
  // the exception: they are a claim about another file, and a claim is worth
  // nothing if nothing can check it.
  if (globalThis.__WFX_BRIDGE__) {
    Object.assign(globalThis.__WFX_BRIDGE__, { TIMEOUT_MS, DRIVER_WORST_CASE_MS, MARGIN_MS });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = FROM_PANEL.get(message?.type);
    if (!type) return false;
    ask(type, message.payload).then(sendResponse);
    return true;
  });
})();
