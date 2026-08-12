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
  ]);
  const TIMEOUT_MS = 30000;
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
  ]);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = FROM_PANEL.get(message?.type);
    if (!type) return false;
    ask(type, message.payload).then(sendResponse);
    return true;
  });
})();
