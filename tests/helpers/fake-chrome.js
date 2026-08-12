// A fake browser, not a fake module. The panel modules are exercised as written -
// real ledger, real runner, real downloader - against this. Nothing here knows
// what the extension is trying to do, so a test that passes here is a test about
// the extension's behaviour rather than about its mocks.

function listeners() {
  const set = new Set();
  return {
    addListener: (fn) => set.add(fn),
    removeListener: (fn) => set.delete(fn),
    hasListener: (fn) => set.has(fn),
    emit: (...args) => [...set].map((fn) => fn(...args)),
    size: () => set.size,
  };
}

// Chrome's tabs.query url patterns, reduced to the one form this extension uses:
// a prefix ending in '*'.
function matchesPattern(url, pattern) {
  if (!pattern) return true;
  if (pattern.endsWith('*')) return String(url ?? '').startsWith(pattern.slice(0, -1));
  return url === pattern;
}

export function createFakeChrome(options = {}) {
  const {
    tabs: initialTabs = [],
    // tabId -> async (message, { tab }) => response. Answers tabs.sendMessage.
    // The tab is handed over because a real page answers as the document it is:
    // a readiness probe has to be able to reply for the job it is showing.
    pages = {},
    // false means downloads never settle, which is what the stall timeout is for.
    autoComplete = true,
    // What Chrome says the file is. Wellfound's resume link carries no
    // extension, so this is the only thing that decides one - and pinning every
    // download to a pdf would hide a docx named .pdf.
    mime = 'application/pdf',
    storage: initialStorage = {},
  } = options;

  // Chrome reports a load state per tab; a seeded tab is a settled one unless a
  // test says otherwise.
  const tabs = initialTabs.map((t) => ({ status: 'complete', ...t }));
  const store = { ...initialStorage };
  const items = [];
  const onChanged = listeners();
  const onDeterminingFilename = listeners();
  const onUpdated = listeners();
  // Tabs whose reload has been requested and whose new document has not
  // arrived yet.
  const reloading = new Set();
  const calls = { downloads: [], updates: [], sendMessage: [], reloads: [] };
  let nextId = 1;

  function complete(id, { state = 'complete', error = null } = {}) {
    const item = items.find((i) => i.id === id);
    if (!item || item.state !== 'in_progress') return;
    item.state = state;
    onChanged.emit({
      id,
      state: { current: state },
      ...(error ? { error: { current: error } } : {}),
    });
  }

  const chrome = {
    runtime: {
      id: 'wfx-test-extension',
      lastError: null,
    },

    tabs: {
      async query({ url } = {}) {
        return tabs.filter((t) => matchesPattern(t.url, url)).map((t) => ({ ...t }));
      },
      async get(tabId) {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return { ...tab };
      },
      async update(tabId, props) {
        const tab = tabs.find((t) => t.id === tabId);
        calls.updates.push({ tabId, ...props });
        if (tab) Object.assign(tab, props);
        return { ...tab };
      },
      onUpdated,
      // Chrome resolves this when the reload has been REQUESTED. At that
      // instant the tab still holds the OLD document, still says `complete`,
      // and still answers messages - and only later does it flip to `loading`
      // and then to `complete` on the new one. A fake that flipped the status
      // synchronously would agree with any caller that assumed the reload had
      // already happened, which is the window a real reload lands in.
      //
      // `reloading` is the test-side truth about that window: true from the
      // request until the new document is complete. Anything the extension says
      // to the page during it is being said to a document on its way out.
      async reload(tabId) {
        calls.reloads.push(tabId);
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        reloading.add(tabId);
        setTimeout(() => {
          tab.status = 'loading';
          onUpdated.emit(tabId, { status: 'loading' }, { ...tab });
          setTimeout(() => {
            tab.status = 'complete';
            reloading.delete(tabId);
            onUpdated.emit(tabId, { status: 'complete' }, { ...tab });
          }, 0);
        }, 0);
      },
      async sendMessage(tabId, message) {
        calls.sendMessage.push({ tabId, message, reloading: reloading.has(tabId) });
        const page = pages[tabId];
        // Chrome's sentence in full. The half of it that names the cause is the
        // half the panel matches on, so a shortened stand-in here would let a
        // test pass against a string the browser never actually sends.
        if (!page) throw new Error('Could not establish connection. Receiving end does not exist.');
        const tab = tabs.find((t) => t.id === tabId);
        return page(message, { tab: tab ? { ...tab } : null });
      },
    },

    downloads: {
      onChanged,
      onDeterminingFilename,
      async download(opts) {
        calls.downloads.push({ ...opts });
        const id = nextId;
        nextId += 1;
        const item = {
          id,
          url: opts.url,
          finalUrl: opts.url,
          mime,
          state: 'in_progress',
          exists: true,
          // Chrome's own guess, used when no listener suggests anything. A test
          // that sees this name is a test where the naming listener lost.
          filename: `wellfound-server-name-${id}.pdf`,
        };
        items.push(item);
        // Fired before the id is handed back, exactly as Chrome may do it. This
        // is the race downloader.js pre-registers against: a handler that
        // registered after download() resolved would never see this.
        onDeterminingFilename.emit(item, (s) => {
          item.filename = s.filename;
          item.conflictAction = s.conflictAction;
        });
        // On a real timer, so the caller has added its onChanged listener first.
        if (autoComplete) setTimeout(() => complete(id), 0);
        return id;
      },
      async search(query = {}) {
        if (query.id != null) return items.filter((i) => i.id === query.id).map((i) => ({ ...i }));
        if (query.filenameRegex) {
          const re = new RegExp(query.filenameRegex);
          return items.filter((i) => re.test(i.filename)).map((i) => ({ ...i }));
        }
        return items.map((i) => ({ ...i }));
      },
    },

    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return { ...store };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
          }
          return keys in store ? { [keys]: store[keys] } : {};
        },
        async set(values) {
          Object.assign(store, values);
        },
        // Chrome takes one key or a list of them; so does this, or a caller
        // removing two keys at once would silently remove neither.
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        },
      },
    },
  };

  return {
    chrome,
    // Test-side controls, deliberately not on the chrome object: nothing in src/
    // may reach for these by accident.
    items,
    store,
    calls,
    complete,
    fail: (id, error = 'NETWORK_FAILED') => complete(id, { state: 'interrupted', error }),
    // Seeds download history for reconciliation, which reads it to decide which
    // files are on disk.
    addHistory(entry) {
      const id = nextId;
      nextId += 1;
      items.push({ id, state: 'complete', exists: true, ...entry });
      return id;
    },
    setTabUrl(tabId, url) {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab) tab.url = url;
    },
    setTabStatus(tabId, status) {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab) tab.status = status;
    },
  };
}

// Installs the fake as the global `chrome` the panel modules read, and hands
// back a restore function.
export function installFakeChrome(options) {
  const fake = createFakeChrome(options);
  const previous = globalThis.chrome;
  globalThis.chrome = fake.chrome;
  fake.restore = () => {
    globalThis.chrome = previous;
  };
  return fake;
}
