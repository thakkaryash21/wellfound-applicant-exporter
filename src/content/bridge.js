// ISOLATED world. A relay and nothing else - no logic, no state beyond pending
// requests. Only the three message types below are forwarded.
(() => {
  const ALLOWED = new Set(['LIST_JOBS', 'FETCH_PAGE', 'QUERY_READY']);
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'CX_LIST_JOBS') {
      ask('LIST_JOBS').then(sendResponse);
      return true;
    }
    if (message?.type === 'CX_FETCH_PAGE') {
      ask('FETCH_PAGE', message.payload).then(sendResponse);
      return true;
    }
    if (message?.type === 'CX_QUERY_READY') {
      ask('QUERY_READY').then(sendResponse);
      return true;
    }
    return false;
  });
})();
