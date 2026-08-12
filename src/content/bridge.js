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
  //   confirm wait  15000  (CONFIRM_TIMEOUT_MS)
  //   slack          2000  (poll granularity, click dispatch, re-render)
  //                 -----
  //                 30000
  const DRIVER_WORST_CASE_MS = 30000;
  // Half as much again. Large because expiring early costs a person a second
  // message, and waiting too long costs the operator a few seconds in front of
  // a panel that is already telling them the run has stopped.
  const MARGIN_MS = 15000;
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
