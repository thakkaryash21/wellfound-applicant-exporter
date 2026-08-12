// Loads a classic content script - the kind MV3 runs in a page - and hands back
// what it exposed.
//
// src/content/bridge.js and src/content/collector.js are not modules and cannot
// become modules: MV3 refuses a module content script in the MAIN world, so
// `import` and `export` are unavailable to them by construction. Rather than
// bend the shipped files, the harness does what Chrome does - evaluates the
// file's own text against a global object it prepared - so the code under test
// is the code that ships, byte for byte.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// A window with the two capabilities a content script uses: listening for
// messages and posting them. postMessage delivers synchronously to the
// listeners registered on the same window, which is what `event.source ===
// window` traffic between the two scripts amounts to.
export function createFakeWindow() {
  const listeners = { message: [] };
  const posted = [];
  const window = {
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    postMessage(data) {
      posted.push(data);
      for (const fn of [...(listeners.message ?? [])]) fn({ source: window, data });
    },
  };
  return {
    window,
    // Everything the script posted out, in order.
    posted,
    // A message arriving from the other side of the boundary. `source` defaults
    // to the window, because a message from anywhere else is one both scripts
    // are required to ignore.
    deliver(data, source = window) {
      for (const fn of [...(listeners.message ?? [])]) fn({ source, data });
    },
    listenerCount: () => (listeners.message ?? []).length,
  };
}

// Evaluates a classic script against the given globals. `expose` names the
// container the script publishes its internals into; the object handed back is
// whatever the script put there.
export function loadClassicScript(relativePath, { globals = {}, expose = null } = {}) {
  const source = readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
  const exposed = {};
  const context = {
    ...globals,
    // Resolved at call time so a test may install fake timers after loading.
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    Promise,
    Error,
    JSON,
    Set,
    Map,
    Object,
    String,
    Boolean,
    Array,
  };
  if (expose) context[expose] = exposed;
  runInNewContext(source, context);
  return { exposed, context };
}
