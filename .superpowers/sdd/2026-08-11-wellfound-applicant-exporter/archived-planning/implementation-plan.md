# Wellfound Applicant Exporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome MV3 extension that downloads every Wellfound applicant's resume named after the candidate, writes a CSV of the applicant list, and remembers who it already has so later runs fetch only new people.

**Architecture:** Wellfound's `/graphql` endpoint is signature-gated — a replayed request without the page's `x-apollo-signature` returns 404. So a MAIN-world content script drives the page's own Apollo client (`window.__APOLLO_CLIENT__`) instead of forging requests. The side panel orchestrates pacing, dedup and downloads and is also the UI; the service worker does almost nothing. No bundler: MV3 supports ES modules in the service worker and in panel pages, and content scripts are written as classic scripts with no imports.

**Why the run loop is in the panel, not the service worker.** Chrome terminates an MV3 service worker after 30 seconds of inactivity, and neither `setTimeout` nor an open message port resets that timer — only receiving an event or calling an extension API does ([Chrome docs](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)). This extension sleeps on purpose: reading breaks are drawn from 15–40 s and about a third exceed 30 s, and one fires every 8–12 candidates. A worker-hosted loop would be killed mid-run, silently, on essentially every run. The side panel is an ordinary page document with no such timeout, it must stay open for the run anyway, and it can call `chrome.downloads`, `chrome.tabs` and `chrome.storage` directly. Hosting the loop there also makes "closing the panel aborts the run" physics rather than a feature, and removes worker-to-panel event broadcasting entirely.

**Tech Stack:** Vanilla JS (ES2022), Chrome Extensions MV3, `chrome.downloads`, `chrome.storage.local`, `chrome.sidePanel`, Vitest for unit tests. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-11-wellfound-applicant-exporter-design.md` — read it before starting. Every recon finding below was observed live; do not re-derive it.

## Global Constraints

- **Chrome 116+.** `chrome.sidePanel` requires it.
- **Manifest V3.** `"manifest_version": 3`.
- **No bundler, no runtime dependencies.** Vitest is a devDependency only. The unpacked `src/` directory is what loads into Chrome.
- **No network fetches from extension pages.** Extension CSP blocks them. Fonts are bundled as woff2 under `src/assets/fonts/`.
- **Content scripts are classic scripts.** `collector.js` and `bridge.js` may not use `import`. Everything they need is inline.
- **The service worker never calls Wellfound's GraphQL API.** All GraphQL goes through the page's Apollo client, via `collector.js`.
- **Never construct GraphQL variables from scratch.** Copy them from the live observable query and override only `first` and `after`.
- **Strictly serial.** Never more than one in-flight request or download at any moment.
- **Default page size is 10.** That is what the real UI sends. 20 is the server ceiling and is opt-in only.
- **Abort, never retry**, on GraphQL error, 403, 429, or a Cloudflare challenge.
- **Colour tokens** (exact hex, defined once in `tokens.css`): `ground #0E1219`, `surface #161B24`, `surface-hi #1D2430`, `hairline #232A36`, `paper #EDE7DC`, `muted #8A93A3`, `sand #D9B382`, `sage #9BB89A`, `rust #C77B62`.
- **Motion:** `cubic-bezier(0.23, 1, 0.32, 1)`, 150–220 ms, `transform` and `opacity` only. Honour `prefers-reduced-motion`.
- **Copy rule:** buttons name what happens ("Download 255 new", never "Start"), and an action keeps its name through the flow.

## Recon constants (observed live, 2026-08-11)

```
Endpoint            POST https://wellfound.com/graphql (Apollo persisted queries)
List operation      RecruitJobListingApplicants
Variables           { after, filters:{status}, first, jobId, orderBy, preferences, talentCandidateId }
Response path       data.talent.viewer.currentStartup.recruit.jobListing.applicants
Connection          { edges[].node, pageInfo{ endCursor, hasNextPage } }   // no totalCount
Page-size ceiling   20 (first:50 and first:100 both returned 20)
Resume URL          node.recruitCandidate.candidate.resumeUrl
                    = https://wellfound.com/link/{userId}/{token}/resume_url
                    → 302 → https://s3.amazonaws.com/attachments.angel.co/{id}-{hash}.pdf?X-Amz-…
Job list + counts   client.cache.extract() entries with __typename === 'JobListing'
                    → { id, title, actionableApplicantsCount, draft }
```

## File structure

```
manifest.json                   MV3 manifest
package.json                    vitest devDependency, test script
vitest.config.js
src/
  lib/                          pure modules, unit tested, no chrome.* except where noted
    messages.js                 message type constants shared by every context
    filename.js                 name sanitizing, extension detection, filename assembly
    csv.js                      CSV serialization and User ID extraction
    jitter.js                   log-normal delay sampling, sleep
    normalize.js                Apollo node → flat applicant record
    dedup.js                    page diffing and the early-stop rule
    ledger.js                   chrome.storage.local wrapper (injectable storage)
    reconcile.js                ledger vs chrome.downloads history (injectable downloads)
    runner.js                   the run loop, all I/O injected — fully unit tested
  background/
    service-worker.js           side panel behaviour, and nothing else
  content/
    bridge.js                   ISOLATED world postMessage ↔ chrome.runtime relay
    collector.js                MAIN world Apollo access
  panel/
    panel.html
    tokens.css                  colour, type, motion tokens
    panel.css
    downloader.js               chrome.downloads + onDeterminingFilename naming
    run-controller.js           orchestration: tab control, ledger, CSV, run lifecycle
    panel.js                    screen routing and rendering
    breath-lane.js              the signature pacing visualization
    library.js                  Library screen
  assets/fonts/                 InstrumentSans-*.woff2, JetBrainsMono-*.woff2
tests/                          one .test.js per lib module
```

Split by responsibility, not by layer. `runner.js` lives in `lib/` rather than `panel/` precisely because all its I/O is injected — that is what makes the run loop testable without a browser. `downloader.js` and `run-controller.js` live in `panel/` because they must run in a context Chrome will not terminate mid-run.

---

### Task 1: Scaffold, manifest, and an empty side panel that loads

**Files:**
- Create: `package.json`, `vitest.config.js`, `.gitignore`, `manifest.json`
- Create: `src/panel/panel.html`, `src/panel/tokens.css`, `src/panel/panel.css`, `src/panel/panel.js`
- Create: `src/background/service-worker.js`
- Create: `tests/smoke.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a loadable unpacked extension; `npm test` runs Vitest.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "wellfound-applicant-exporter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
.DS_Store
*.zip
```

- [ ] **Step 4: Write `manifest.json`**

`downloads` covers both `download()` and `search()`. `tabs` is needed to navigate the working tab between jobs. No `<all_urls>`, and no permission for the S3 host — `chrome.downloads` does not perform an extension-origin fetch, so redirects are never host-permission checked.

```json
{
  "manifest_version": 3,
  "name": "Wellfound Applicant Exporter",
  "version": "0.1.0",
  "description": "Download applicant resumes and a CSV from your Wellfound job listings.",
  "minimum_chrome_version": "116",
  "permissions": ["storage", "downloads", "sidePanel", "tabs"],
  "host_permissions": ["https://wellfound.com/*"],
  "background": {
    "service_worker": "src/background/service-worker.js",
    "type": "module"
  },
  "side_panel": {
    "default_path": "src/panel/panel.html"
  },
  "action": {
    "default_title": "Wellfound Applicant Exporter"
  },
  "content_scripts": [
    {
      "matches": ["https://wellfound.com/recruit/applicants/*"],
      "js": ["src/content/bridge.js"],
      "world": "ISOLATED",
      "run_at": "document_idle"
    },
    {
      "matches": ["https://wellfound.com/recruit/applicants/*"],
      "js": ["src/content/collector.js"],
      "world": "MAIN",
      "run_at": "document_idle"
    }
  ]
}
```

- [ ] **Step 5: Create placeholder content scripts so the manifest loads**

`src/content/bridge.js`:

```js
// Replaced in Task 10.
console.debug('[wfx] bridge placeholder');
```

`src/content/collector.js`:

```js
// Replaced in Task 9.
console.debug('[wfx] collector placeholder');
```

- [ ] **Step 6: Write `src/panel/tokens.css`**

Font faces are declared here but the files arrive in Task 13; the stack falls back to system faces until then.

```css
:root {
  --ground: #0e1219;
  --surface: #161b24;
  --surface-hi: #1d2430;
  --hairline: #232a36;
  --paper: #ede7dc;
  --muted: #8a93a3;
  --sand: #d9b382;
  --sage: #9bb89a;
  --rust: #c77b62;

  --font-ui: 'Instrument Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;

  --ease: cubic-bezier(0.23, 1, 0.32, 1);
  --dur-fast: 150ms;
  --dur: 200ms;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
}
```

- [ ] **Step 7: Write `src/panel/panel.css`**

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--ground);
  color: var(--paper);
  font-family: var(--font-ui);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--hairline);
}

.topbar h1 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.num {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

:focus-visible {
  outline: 2px solid var(--sand);
  outline-offset: 2px;
}
```

- [ ] **Step 8: Write `src/panel/panel.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Wellfound Applicant Exporter</title>
    <link rel="stylesheet" href="tokens.css" />
    <link rel="stylesheet" href="panel.css" />
  </head>
  <body>
    <header class="topbar">
      <h1>Wellfound</h1>
      <button id="nav-library" type="button" class="label">Library</button>
    </header>
    <main id="screen"></main>
    <script type="module" src="panel.js"></script>
  </body>
</html>
```

- [ ] **Step 9: Write `src/panel/panel.js`**

```js
const screen = document.getElementById('screen');
screen.textContent = 'Panel loaded.';
```

- [ ] **Step 10: Write `src/background/service-worker.js`**

`openPanelOnActionClick` is what makes clicking the toolbar icon open the panel; without it the action does nothing.

```js
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
```

- [ ] **Step 11: Write `tests/smoke.test.js`**

Proves the test runner is wired before any real test depends on it.

```js
import { describe, it, expect } from 'vitest';

describe('test harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 12: Install and run the tests**

```powershell
npm install
npm test
```

Expected: 1 passed.

- [ ] **Step 13: Load the extension in Brave and verify the panel opens**

Go to `brave://extensions`, enable Developer mode, click **Load unpacked**, select the project root. Click the extension's toolbar icon.

Expected: a side panel opens showing "Panel loaded." on a dark blue-slate background. No errors on the extension's **service worker** link.

- [ ] **Step 14: Commit**

```powershell
git add -A
git commit -m "feat: scaffold MV3 extension with side panel and vitest"
```

---

### Task 2: Filename module

**Files:**
- Create: `src/lib/filename.js`
- Test: `tests/filename.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sanitizeName(name: string): string`
  - `extensionFromUrl(url: string): string | null`
  - `buildFilename({ name, userId, jobId, url, mimeType }): string` — returns a path-safe basename with extension, e.g. `Jane Doe-7700001-9100001.pdf`

- [ ] **Step 1: Write the failing tests**

`tests/filename.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { sanitizeName, extensionFromUrl, buildFilename } from '../src/lib/filename.js';

describe('sanitizeName', () => {
  it('strips Windows-reserved characters', () => {
    expect(sanitizeName('A/B\\C:D*E?F"G<H>I|J')).toBe('ABCDEFGHIJ');
  });

  it('collapses whitespace', () => {
    expect(sanitizeName('  Jane   Q.  Doe ')).toBe('Jane Q. Doe');
  });

  it('trims trailing dots and spaces, which Windows rejects', () => {
    expect(sanitizeName('Jane Doe. .')).toBe('Jane Doe');
  });

  it('strips control characters', () => {
    expect(sanitizeName('Jane\u0000\u001fDoe')).toBe('JaneDoe');
  });

  it('caps the base name at 100 characters', () => {
    expect(sanitizeName('x'.repeat(300))).toHaveLength(100);
  });

  it('never ends in a dot after truncation, which Windows would reject', () => {
    const name = `${'x'.repeat(99)}.${'x'.repeat(200)}`;
    const out = sanitizeName(name);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('.')).toBe(false);
  });

  it('falls back to "unknown" for an empty or missing name', () => {
    expect(sanitizeName('')).toBe('unknown');
    expect(sanitizeName(null)).toBe('unknown');
    expect(sanitizeName('   ...  ')).toBe('unknown');
  });
});

describe('extensionFromUrl', () => {
  it('reads the extension from the presigned S3 path, ignoring the query', () => {
    const url =
      'https://s3.amazonaws.com/attachments.angel.co/a1b2c3d4-e5f6a7b8.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc';
    expect(extensionFromUrl(url)).toBe('pdf');
  });

  it('handles docx', () => {
    expect(extensionFromUrl('https://s3.amazonaws.com/a/b-c.docx?X-Amz-Date=1')).toBe('docx');
  });

  it('returns null when the path has no extension', () => {
    expect(extensionFromUrl('https://wellfound.com/link/1/abc/resume_url')).toBe(null);
  });

  it('returns null for an unparseable url', () => {
    expect(extensionFromUrl('not a url')).toBe(null);
  });
});

describe('buildFilename', () => {
  it('assembles name-userId-jobId.ext', () => {
    const out = buildFilename({
      name: 'Jane Doe',
      userId: '7700001',
      jobId: '9100001',
      url: 'https://s3.amazonaws.com/attachments.angel.co/1-a.pdf?X-Amz-Date=1',
    });
    expect(out).toBe('Jane Doe-7700001-9100001.pdf');
  });

  it('falls back to the mime type when the url has no extension', () => {
    const out = buildFilename({
      name: 'Jane Doe',
      userId: '1',
      jobId: '2',
      url: 'https://wellfound.com/link/1/abc/resume_url',
      mimeType: 'application/pdf',
    });
    expect(out).toBe('Jane Doe-1-2.pdf');
  });

  it('falls back to pdf when neither url nor mime type is informative', () => {
    const out = buildFilename({ name: 'Jane Doe', userId: '1', jobId: '2', url: '' });
    expect(out).toBe('Jane Doe-1-2.pdf');
  });

  it('sanitizes the name it was given', () => {
    const out = buildFilename({ name: 'A/B', userId: '1', jobId: '2', url: 'https://x/y.pdf' });
    expect(out).toBe('AB-1-2.pdf');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npx vitest run tests/filename.test.js
```

Expected: FAIL — cannot resolve `../src/lib/filename.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/filename.js`:

```js
const RESERVED = /[\\/:*?"<>|]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const MAX_BASE = 100;

const MIME_EXT = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
};

export function sanitizeName(name) {
  const cleaned = String(name ?? '')
    .replace(CONTROL, '')
    .replace(RESERVED, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BASE)
    // Truncating can expose a new trailing dot or space, so trim after slicing,
    // not before — Windows silently rejects both at the end of a filename.
    .replace(/[. ]+$/, '');
  return cleaned || 'unknown';
}

export function extensionFromUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : null;
}

export function buildFilename({ name, userId, jobId, url, mimeType }) {
  const ext = extensionFromUrl(url) ?? MIME_EXT[mimeType] ?? 'pdf';
  return `${sanitizeName(name)}-${userId}-${jobId}.${ext}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npx vitest run tests/filename.test.js
```

Expected: 14 passed.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/filename.js tests/filename.test.js
git commit -m "feat: add filename sanitizing and extension detection"
```

---

### Task 3: CSV module

**Files:**
- Create: `src/lib/csv.js`
- Test: `tests/csv.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CSV_COLUMNS: Array<{ key: string, header: string }>`
  - `escapeField(value: unknown): string`
  - `toCsv(records: object[]): string` — RFC 4180, CRLF line endings, UTF-8 BOM prefix
  - `userIdsFromCsv(text: string): string[]` — reads the `User ID` column of an exported CSV

- [ ] **Step 1: Write the failing tests**

`tests/csv.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { escapeField, toCsv, userIdsFromCsv, CSV_COLUMNS } from '../src/lib/csv.js';

describe('escapeField', () => {
  it('leaves plain values alone', () => {
    expect(escapeField('Jane Doe')).toBe('Jane Doe');
  });

  it('quotes values containing a comma', () => {
    expect(escapeField('Doe, Jane')).toBe('"Doe, Jane"');
  });

  it('quotes and doubles internal quotes', () => {
    expect(escapeField('Jane "JD" Doe')).toBe('"Jane ""JD"" Doe"');
  });

  it('quotes values containing a newline', () => {
    expect(escapeField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('renders null and undefined as empty', () => {
    expect(escapeField(null)).toBe('');
    expect(escapeField(undefined)).toBe('');
  });

  it('renders booleans as yes/no', () => {
    expect(escapeField(true)).toBe('yes');
    expect(escapeField(false)).toBe('no');
  });
});

describe('toCsv', () => {
  const record = {
    name: 'Doe, Jane',
    userId: '7700001',
    jobId: '9100001',
    jobTitle: 'Platform Engineer',
    location: 'Berlin',
    yearsExperience: 6,
    linkedinUrl: 'https://linkedin.com/in/jd',
    githubUrl: '',
    website: '',
    wellfoundUrl: 'https://wellfound.com/u/jd',
    usAuthorized: false,
    resumeUrl: 'https://wellfound.com/link/1/a/resume_url',
    resumeFilename: 'Jane Doe-7700001-9100001.pdf',
  };

  it('starts with a UTF-8 BOM so Excel reads it as UTF-8', () => {
    expect(toCsv([record]).charCodeAt(0)).toBe(0xfeff);
  });

  it('writes the header row in the declared column order', () => {
    const line = toCsv([record]).slice(1).split('\r\n')[0];
    expect(line).toBe(CSV_COLUMNS.map((c) => c.header).join(','));
  });

  it('quotes a value containing a comma', () => {
    expect(toCsv([record])).toContain('"Doe, Jane"');
  });

  it('uses CRLF line endings', () => {
    expect(toCsv([record]).split('\r\n')).toHaveLength(3); // header, row, trailing
  });

  it('emits a header-only file for no records', () => {
    expect(toCsv([]).slice(1).trim().split('\r\n')).toHaveLength(1);
  });
});

describe('userIdsFromCsv', () => {
  it('reads the User ID column regardless of its position', () => {
    const text = 'Name,User ID,Job ID\r\nJane,111,9100001\r\nBob,222,9100001\r\n';
    expect(userIdsFromCsv(text)).toEqual(['111', '222']);
  });

  it('tolerates a BOM and quoted fields', () => {
    const text = '\ufeff"Name","User ID"\r\n"Doe, Jane","333"\r\n';
    expect(userIdsFromCsv(text)).toEqual(['333']);
  });

  it('returns an empty array when the column is absent', () => {
    expect(userIdsFromCsv('Name,Email\r\nJane,j@x.com\r\n')).toEqual([]);
  });

  it('skips blank lines and blank ids', () => {
    const text = 'User ID\r\n111\r\n\r\n\r\n222\r\n';
    expect(userIdsFromCsv(text)).toEqual(['111', '222']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npx vitest run tests/csv.test.js
```

Expected: FAIL — cannot resolve `../src/lib/csv.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/csv.js`:

```js
export const CSV_COLUMNS = [
  { key: 'name', header: 'Name' },
  { key: 'userId', header: 'User ID' },
  { key: 'jobId', header: 'Job ID' },
  { key: 'jobTitle', header: 'Job Title' },
  { key: 'location', header: 'Location' },
  { key: 'yearsExperience', header: 'Years Experience' },
  { key: 'linkedinUrl', header: 'LinkedIn' },
  { key: 'githubUrl', header: 'GitHub' },
  { key: 'website', header: 'Website' },
  { key: 'wellfoundUrl', header: 'Wellfound URL' },
  { key: 'usAuthorized', header: 'US Authorized' },
  { key: 'resumeUrl', header: 'Resume Link' },
  { key: 'resumeFilename', header: 'Resume Filename' },
];

const BOM = '\ufeff';

export function escapeField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(records) {
  const header = CSV_COLUMNS.map((c) => c.header).join(',');
  const rows = records.map((r) => CSV_COLUMNS.map((c) => escapeField(r[c.key])).join(','));
  return BOM + [header, ...rows].join('\r\n') + '\r\n';
}

// Minimal RFC 4180 row splitter: enough for CSVs this extension wrote.
function parseRow(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

export function userIdsFromCsv(text) {
  const lines = text
    .replace(/^\ufeff/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const index = parseRow(lines[0]).indexOf('User ID');
  if (index === -1) return [];
  return lines
    .slice(1)
    .map((line) => parseRow(line)[index]?.trim())
    .filter((id) => id);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npx vitest run tests/csv.test.js
```

Expected: 15 passed.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/csv.js tests/csv.test.js
git commit -m "feat: add CSV serialization and User ID import"
```

---

### Task 4: Jitter module

**Files:**
- Create: `src/lib/jitter.js`
- Test: `tests/jitter.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PACING: { pageMs: [number, number], downloadMs: [number, number], breakMs: [number, number], breakEvery: [number, number] }`
  - `sample(min: number, max: number, rand?: () => number): number` — log-normal-ish draw clamped to `[min, max]`
  - `sleep(ms: number): Promise<void>`

Delays are drawn from a log-normal shape rather than a uniform one because human inter-action gaps cluster near a mode with a long right tail. A uniform draw has a flat histogram, which is itself a signature.

- [ ] **Step 1: Write the failing tests**

`tests/jitter.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { sample, sleep, PACING } from '../src/lib/jitter.js';

describe('sample', () => {
  it('stays inside the requested bounds across many draws', () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = sample(2500, 7000);
      expect(value).toBeGreaterThanOrEqual(2500);
      expect(value).toBeLessThanOrEqual(7000);
    }
  });

  it('is deterministic when given a fixed random source', () => {
    const fixed = () => 0.5;
    expect(sample(1000, 2000, fixed)).toBe(sample(1000, 2000, fixed));
  });

  it('clusters below the midpoint, unlike a uniform draw', () => {
    const mid = (2500 + 7000) / 2;
    const draws = Array.from({ length: 4000 }, () => sample(2500, 7000));
    const below = draws.filter((d) => d < mid).length;
    expect(below / draws.length).toBeGreaterThan(0.55);
    expect(below / draws.length).toBeLessThan(0.8);
  });

  it('spreads the middle half of draws across at least a quarter of the range', () => {
    const draws = Array.from({ length: 8000 }, () => sample(2500, 7000)).sort((a, b) => a - b);
    const iqr = draws[Math.floor(draws.length * 0.75)] - draws[Math.floor(draws.length * 0.25)];
    expect(iqr / (7000 - 2500)).toBeGreaterThan(0.25);
  });

  it('does not pile draws onto the upper bound', () => {
    const draws = Array.from({ length: 8000 }, () => sample(2500, 7000));
    const atMax = draws.filter((d) => d === 7000).length;
    expect(atMax / draws.length).toBeLessThan(0.01);
  });

  it('produces a spread rather than a constant', () => {
    const draws = new Set(Array.from({ length: 200 }, () => sample(1000, 4000)));
    expect(draws.size).toBeGreaterThan(50);
  });

  it('returns the bound when min equals max', () => {
    expect(sample(1000, 1000)).toBe(1000);
  });
});

describe('PACING', () => {
  it('declares ranges the spec fixed', () => {
    expect(PACING.pageMs).toEqual([2500, 7000]);
    expect(PACING.downloadMs).toEqual([1500, 4000]);
    expect(PACING.breakMs).toEqual([15000, 40000]);
    expect(PACING.breakEvery).toEqual([8, 12]);
  });
});

describe('sleep', () => {
  it('resolves after roughly the requested delay', async () => {
    const started = Date.now();
    await sleep(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npx vitest run tests/jitter.test.js
```

Expected: FAIL — cannot resolve `../src/lib/jitter.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/jitter.js`:

```js
export const PACING = {
  pageMs: [2500, 7000],
  downloadMs: [1500, 4000],
  breakMs: [15000, 40000],
  breakEvery: [8, 12],
};

// The distribution's median sits at this fraction of the range, and SIGMA sets
// how wide the spread is. Tuned so the middle half of draws covers about a third
// of the range: a flat histogram is itself a signature, and so is a tight one.
const MEDIAN_FRACTION = 0.42;
const SIGMA = 0.75;
const MAX_ATTEMPTS = 8;

// Box-Muller gives a normal draw; exponentiating it gives a log-normal shape:
// clustered below the middle with a long right tail, the way human pauses fall.
function standardNormal(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function sample(min, max, rand = Math.random) {
  if (max <= min) return min;
  // Resample rather than clamp when a draw overshoots. Clamping piles ~12% of
  // draws onto the exact upper bound, and a spike at one value is the most
  // fingerprintable shape there is.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const shaped = MEDIAN_FRACTION * Math.exp(SIGMA * standardNormal(rand));
    if (shaped < 1) return Math.round(min + (max - min) * shaped);
  }
  return max;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sampleInt(range, rand = Math.random) {
  const [min, max] = range;
  return Math.floor(min + rand() * (max - min + 1));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npx vitest run tests/jitter.test.js
```

Expected: 7 passed. If the clustering test fails, adjust the divisor in `sample` until the below-midpoint share sits between 0.6 and 0.8 — do not weaken the test.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/jitter.js tests/jitter.test.js
git commit -m "feat: add log-normal jitter sampling"
```

---

### Task 5: Normalize module

**Files:**
- Create: `src/lib/normalize.js`
- Test: `tests/normalize.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeNode(node: object, ctx: { jobId: string, jobTitle: string }): Applicant`

`Applicant` is the record every later task passes around:

```
{
  applicantId, userId, name, headline, location, currentRole,
  yearsExperience, linkedinUrl, githubUrl, website, wellfoundUrl,
  usAuthorized, resumeUrl, submittedAt, masked, jobId, jobTitle
}
```

- [ ] **Step 1: Write the failing tests**

`tests/normalize.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { normalizeNode } from '../src/lib/normalize.js';

const ctx = { jobId: '9100001', jobTitle: 'Backend Engineer' };

function node(overrides = {}) {
  return {
    id: 'JP7700001',
    currentApplication: { submittedAt: '2026-08-01T10:00:00Z' },
    recruitCandidate: {
      masked: false,
      concealed: false,
      candidate: {
        userId: '7700001',
        name: 'Jane Doe',
        headline: 'Backend engineer',
        currentLocation: 'Berlin',
        currentRole: 'Senior Engineer',
        yearsExperienceInRole: 6,
        linkedinUrl: 'https://linkedin.com/in/jd',
        githubUrl: 'https://github.com/jd',
        website: 'https://jd.dev',
        angellistUrl: 'https://wellfound.com/u/jd',
        usAuthorized: true,
        resumeUrl: 'https://wellfound.com/link/7700001/abc/resume_url',
        ...(overrides.candidate ?? {}),
      },
      ...(overrides.recruitCandidate ?? {}),
    },
    ...(overrides.node ?? {}),
  };
}

describe('normalizeNode', () => {
  it('flattens the fields the CSV and downloader need', () => {
    const out = normalizeNode(node(), ctx);
    expect(out).toMatchObject({
      applicantId: 'JP7700001',
      userId: '7700001',
      name: 'Jane Doe',
      location: 'Berlin',
      yearsExperience: 6,
      usAuthorized: true,
      jobId: '9100001',
      jobTitle: 'Backend Engineer',
    });
  });

  it('maps angellistUrl onto wellfoundUrl', () => {
    expect(normalizeNode(node(), ctx).wellfoundUrl).toBe('https://wellfound.com/u/jd');
  });

  it('carries the resume url through untouched', () => {
    expect(normalizeNode(node(), ctx).resumeUrl).toBe(
      'https://wellfound.com/link/7700001/abc/resume_url',
    );
  });

  it('returns null resumeUrl when the candidate has no resume', () => {
    const out = normalizeNode(node({ candidate: { resumeUrl: null } }), ctx);
    expect(out.resumeUrl).toBe(null);
  });

  it('marks masked candidates and still produces a record', () => {
    const out = normalizeNode(node({ recruitCandidate: { masked: true } }), ctx);
    expect(out.masked).toBe(true);
    expect(out.applicantId).toBe('JP7700001');
  });

  it('survives a missing candidate object without throwing', () => {
    const out = normalizeNode({ id: 'JP1', recruitCandidate: null }, ctx);
    expect(out.applicantId).toBe('JP1');
    expect(out.name).toBe(null);
    expect(out.userId).toBe(null);
  });

  it('survives a missing currentApplication', () => {
    expect(normalizeNode({ id: 'JP1' }, ctx).submittedAt).toBe(null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npx vitest run tests/normalize.test.js
```

Expected: FAIL — cannot resolve `../src/lib/normalize.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/normalize.js`:

```js
export function normalizeNode(node, ctx) {
  const rc = node?.recruitCandidate ?? {};
  const c = rc.candidate ?? {};
  return {
    applicantId: node?.id ?? null,
    userId: c.userId != null ? String(c.userId) : null,
    name: c.name ?? null,
    headline: c.headline ?? null,
    location: c.currentLocation ?? null,
    currentRole: c.currentRole ?? null,
    yearsExperience: c.yearsExperienceInRole ?? null,
    linkedinUrl: c.linkedinUrl ?? null,
    githubUrl: c.githubUrl ?? null,
    website: c.website ?? null,
    wellfoundUrl: c.angellistUrl ?? null,
    usAuthorized: c.usAuthorized ?? null,
    resumeUrl: c.resumeUrl ?? null,
    submittedAt: node?.currentApplication?.submittedAt ?? null,
    masked: Boolean(rc.masked || rc.concealed),
    jobId: ctx.jobId,
    jobTitle: ctx.jobTitle,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npx vitest run tests/normalize.test.js
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/normalize.js tests/normalize.test.js
git commit -m "feat: normalize Apollo applicant nodes into flat records"
```

---

### Task 6: Dedup module

**Files:**
- Create: `src/lib/dedup.js`
- Test: `tests/dedup.test.js`

**Interfaces:**
- Consumes: `Applicant` from Task 5.
- Produces:
  - `EARLY_STOP_PAGES = 3`
  - `diffPage(records: Applicant[], seen: Set<string>): { fresh: Applicant[], allSeen: boolean }`
  - `createEarlyStop({ forceFullWalk?: boolean }): { observe(allSeen: boolean): void, shouldStop(): boolean }`

Dedup keys on `applicantId`, not `userId`: one person can appear under two jobs and must be downloaded for each.

- [ ] **Step 1: Write the failing tests**

`tests/dedup.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { diffPage, createEarlyStop, EARLY_STOP_PAGES } from '../src/lib/dedup.js';

const rec = (id) => ({ applicantId: id, userId: id.replace('JP', ''), name: `n${id}` });

describe('diffPage', () => {
  it('returns records not already seen', () => {
    const { fresh } = diffPage([rec('JP1'), rec('JP2')], new Set(['JP1']));
    expect(fresh.map((r) => r.applicantId)).toEqual(['JP2']);
  });

  it('flags a page where everything was already seen', () => {
    const { allSeen, fresh } = diffPage([rec('JP1')], new Set(['JP1']));
    expect(allSeen).toBe(true);
    expect(fresh).toEqual([]);
  });

  it('does not flag a partially seen page', () => {
    expect(diffPage([rec('JP1'), rec('JP2')], new Set(['JP1'])).allSeen).toBe(false);
  });

  it('treats an empty page as fully seen so the walk can terminate', () => {
    expect(diffPage([], new Set()).allSeen).toBe(true);
  });

  it('keys on applicantId so one person can be fetched for two jobs', () => {
    const a = { applicantId: 'JP-jobA', userId: '99' };
    const b = { applicantId: 'JP-jobB', userId: '99' };
    expect(diffPage([a, b], new Set(['JP-jobA'])).fresh).toEqual([b]);
  });
});

describe('createEarlyStop', () => {
  it(`stops after ${EARLY_STOP_PAGES} consecutive fully-seen pages`, () => {
    const stop = createEarlyStop({});
    stop.observe(true);
    stop.observe(true);
    expect(stop.shouldStop()).toBe(false);
    stop.observe(true);
    expect(stop.shouldStop()).toBe(true);
  });

  it('resets the streak when a page has fresh records', () => {
    const stop = createEarlyStop({});
    stop.observe(true);
    stop.observe(true);
    stop.observe(false);
    stop.observe(true);
    expect(stop.shouldStop()).toBe(false);
  });

  it('never stops early when forceFullWalk is set', () => {
    const stop = createEarlyStop({ forceFullWalk: true });
    for (let i = 0; i < 10; i += 1) stop.observe(true);
    expect(stop.shouldStop()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npx vitest run tests/dedup.test.js
```

Expected: FAIL — cannot resolve `../src/lib/dedup.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/dedup.js`:

```js
export const EARLY_STOP_PAGES = 3;

export function diffPage(records, seen) {
  const fresh = records.filter((r) => !seen.has(r.applicantId));
  return { fresh, allSeen: fresh.length === 0 };
}

export function createEarlyStop({ forceFullWalk = false } = {}) {
  let streak = 0;
  return {
    observe(allSeen) {
      streak = allSeen ? streak + 1 : 0;
    },
    shouldStop() {
      return !forceFullWalk && streak >= EARLY_STOP_PAGES;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npx vitest run tests/dedup.test.js
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/dedup.js tests/dedup.test.js
git commit -m "feat: add page dedup and the early-stop rule"
```

---

### Task 7: Ledger module

**Files:**
- Create: `src/lib/ledger.js`
- Test: `tests/ledger.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_SEEN = 5000`
  - `createLedger(storage): Ledger` where `storage` matches `chrome.storage.local`'s `{ get, set, remove }` promise API
  - `Ledger`:
    - `get(jobId): Promise<JobRecord>` — always resolves, with an empty record for an unknown job
    - `all(): Promise<JobRecord[]>`
    - `markDownloaded(jobId, applicantIds: string[], meta: { jobTitle }): Promise<void>`
    - `adopt(jobId, applicantIds: string[]): Promise<void>` — same as `markDownloaded` but does not touch run counters
    - `finishRun(jobId, { downloaded: number }): Promise<void>`
    - `forget(jobId): Promise<void>`
  - `JobRecord = { jobId, jobTitle, seenIds: string[], lastRunAt: string|null, lastRunCount: number, totalDownloaded: number }`

- [ ] **Step 1: Write the failing tests**

`tests/ledger.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { createLedger, MAX_SEEN } from '../src/lib/ledger.js';

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(key) {
      delete data[key];
    },
  };
}

let storage;
let ledger;

beforeEach(() => {
  storage = fakeStorage();
  ledger = createLedger(storage);
});

describe('ledger.get', () => {
  it('returns an empty record for an unknown job', async () => {
    const record = await ledger.get('9100001');
    expect(record).toMatchObject({ jobId: '9100001', seenIds: [], totalDownloaded: 0 });
  });
});

describe('ledger.markDownloaded', () => {
  it('records ids and the job title', async () => {
    await ledger.markDownloaded('9100001', ['JP1', 'JP2'], { jobTitle: 'Backend Engineer' });
    const record = await ledger.get('9100001');
    expect(record.seenIds).toEqual(['JP1', 'JP2']);
    expect(record.jobTitle).toBe('Backend Engineer');
    expect(record.totalDownloaded).toBe(2);
  });

  it('does not duplicate ids within a single call', async () => {
    await ledger.markDownloaded('9100001', ['JP1', 'JP1', 'JP2'], { jobTitle: 'x' });
    const record = await ledger.get('9100001');
    expect(record.seenIds).toEqual(['JP1', 'JP2']);
    expect(record.totalDownloaded).toBe(2);
  });

  it('does not duplicate ids across calls', async () => {
    await ledger.markDownloaded('9100001', ['JP1'], { jobTitle: 'x' });
    await ledger.markDownloaded('9100001', ['JP1', 'JP2'], { jobTitle: 'x' });
    expect((await ledger.get('9100001')).seenIds).toEqual(['JP1', 'JP2']);
    expect((await ledger.get('9100001')).totalDownloaded).toBe(2);
  });

  it(`evicts oldest ids beyond ${MAX_SEEN}`, async () => {
    const many = Array.from({ length: MAX_SEEN + 10 }, (_, i) => `JP${i}`);
    await ledger.markDownloaded('9100001', many, { jobTitle: 'x' });
    const { seenIds } = await ledger.get('9100001');
    expect(seenIds).toHaveLength(MAX_SEEN);
    expect(seenIds[0]).toBe('JP10');
    expect(seenIds.at(-1)).toBe(`JP${MAX_SEEN + 9}`);
  });

  it('writes under a namespaced key so it never collides with settings', async () => {
    await ledger.markDownloaded('9100001', ['JP1'], { jobTitle: 'x' });
    expect(Object.keys(storage.data)).toEqual(['job:9100001']);
  });
});

describe('ledger.adopt', () => {
  it('adds ids without changing totalDownloaded', async () => {
    await ledger.adopt('9100001', ['JP1', 'JP2']);
    const record = await ledger.get('9100001');
    expect(record.seenIds).toEqual(['JP1', 'JP2']);
    expect(record.totalDownloaded).toBe(0);
  });
});

describe('ledger.finishRun', () => {
  it('stamps the run time and count', async () => {
    await ledger.markDownloaded('9100001', ['JP1'], { jobTitle: 'x' });
    await ledger.finishRun('9100001', { downloaded: 1 });
    const record = await ledger.get('9100001');
    expect(record.lastRunCount).toBe(1);
    expect(typeof record.lastRunAt).toBe('string');
  });
});

describe('ledger.all', () => {
  it('returns every job record and ignores unrelated keys', async () => {
    await ledger.markDownloaded('1', ['JP1'], { jobTitle: 'a' });
    await ledger.markDownloaded('2', ['JP2'], { jobTitle: 'b' });
    await storage.set({ settings: { folder: 'x' } });
    const all = await ledger.all();
    expect(all.map((r) => r.jobId).sort()).toEqual(['1', '2']);
  });
});

describe('ledger.forget', () => {
  it('removes the job entirely', async () => {
    await ledger.markDownloaded('1', ['JP1'], { jobTitle: 'a' });
    await ledger.forget('1');
    expect(await ledger.all()).toEqual([]);
    expect((await ledger.get('1')).seenIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npx vitest run tests/ledger.test.js
```

Expected: FAIL — cannot resolve `../src/lib/ledger.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/ledger.js`:

```js
export const MAX_SEEN = 5000;

const KEY_PREFIX = 'job:';
const key = (jobId) => `${KEY_PREFIX}${jobId}`;

function emptyRecord(jobId) {
  return {
    jobId,
    jobTitle: null,
    seenIds: [],
    lastRunAt: null,
    lastRunCount: 0,
    totalDownloaded: 0,
  };
}

export function createLedger(storage) {
  async function get(jobId) {
    const stored = await storage.get(key(jobId));
    return stored[key(jobId)] ?? emptyRecord(jobId);
  }

  async function put(record) {
    await storage.set({ [key(record.jobId)]: record });
  }

  function merge(record, ids) {
    const existing = new Set(record.seenIds);
    // Add as we filter, so a batch is deduped against itself as well as against
    // what is already stored. A page can carry the same applicant twice when the
    // underlying list shifts mid-pagination.
    const added = ids.filter((id) => {
      if (!id || existing.has(id)) return false;
      existing.add(id);
      return true;
    });
    const seenIds = [...record.seenIds, ...added];
    return {
      seenIds: seenIds.length > MAX_SEEN ? seenIds.slice(seenIds.length - MAX_SEEN) : seenIds,
      addedCount: added.length,
    };
  }

  return {
    get,
    async all() {
      const everything = await storage.get(null);
      return Object.entries(everything)
        .filter(([k]) => k.startsWith(KEY_PREFIX))
        .map(([, v]) => v);
    },
    async markDownloaded(jobId, applicantIds, meta = {}) {
      const record = await get(jobId);
      const { seenIds, addedCount } = merge(record, applicantIds);
      await put({
        ...record,
        jobTitle: meta.jobTitle ?? record.jobTitle,
        seenIds,
        totalDownloaded: record.totalDownloaded + addedCount,
      });
    },
    async adopt(jobId, applicantIds) {
      const record = await get(jobId);
      const { seenIds } = merge(record, applicantIds);
      await put({ ...record, seenIds });
    },
    async finishRun(jobId, { downloaded }) {
      const record = await get(jobId);
      await put({ ...record, lastRunAt: new Date().toISOString(), lastRunCount: downloaded });
    },
    async forget(jobId) {
      await storage.remove(key(jobId));
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npx vitest run tests/ledger.test.js
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/ledger.js tests/ledger.test.js
git commit -m "feat: add per-job ledger over chrome.storage.local"
```

---

### Task 8: Reconciliation against Chrome's download history

**Files:**
- Create: `src/lib/reconcile.js`
- Test: `tests/reconcile.test.js`

**Interfaces:**
- Consumes: `JobRecord` from Task 7.
- Produces:
  - `downloadRegexForJob(jobId): string` — a `filenameRegex` for `chrome.downloads.search`
  - `applicantIdFromFilename(path, jobId): string | null`
  - `reconcile({ record, items }): { verified: string[], missing: string[], unverifiable: string[], orphans: string[] }`

Chrome's `DownloadItem` gives `filename` (full path), `state`, and `exists`. The ledger stores `applicantId`, but filenames carry `userId` — so the ledger record also needs a `userId` per applicant. To avoid a second store, `applicantId` is mapped through the filename convention: the run records both, and `reconcile` compares on `userId` extracted from the filename against a `userIds` list the caller derives. Keep it simple and explicit: `reconcile` takes and returns **userIds**, and the caller maps them back.

- [ ] **Step 1: Write the failing tests**

`tests/reconcile.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  downloadRegexForJob,
  userIdFromFilename,
  reconcile,
} from '../src/lib/reconcile.js';

const item = (path, overrides = {}) => ({
  filename: path,
  state: 'complete',
  exists: true,
  ...overrides,
});

describe('downloadRegexForJob', () => {
  it('matches this extension\u2019s filenames for the job', () => {
    const re = new RegExp(downloadRegexForJob('9100001'));
    expect(re.test('C:\\Users\\y\\Downloads\\wf\\Jane Doe-7700001-9100001.pdf')).toBe(true);
  });

  it('does not match another job\u2019s files', () => {
    const re = new RegExp(downloadRegexForJob('9100001'));
    expect(re.test('C:\\Users\\y\\Downloads\\wf\\Jane Doe-7700001-9100004.pdf')).toBe(false);
  });

  it('does not match the CSV', () => {
    const re = new RegExp(downloadRegexForJob('9100001'));
    expect(re.test('C:\\Users\\y\\Downloads\\wf\\applicants-9100001-2026-08-11.csv')).toBe(false);
  });
});

describe('userIdFromFilename', () => {
  it('reads the user id from a Windows path', () => {
    expect(userIdFromFilename('C:\\d\\wf\\Jane Doe-7700001-9100001.pdf', '9100001')).toBe(
      '7700001',
    );
  });

  it('reads the user id from a POSIX path', () => {
    expect(userIdFromFilename('/home/y/wf/Jane Doe-7700001-9100001.docx', '9100001')).toBe(
      '7700001',
    );
  });

  it('returns null for a different job', () => {
    expect(userIdFromFilename('/d/Jane-1-9100004.pdf', '9100001')).toBe(null);
  });

  it('returns null for an unrelated file', () => {
    expect(userIdFromFilename('/d/notes.pdf', '9100001')).toBe(null);
  });
});

describe('reconcile', () => {
  const record = { jobId: '9100001', userIds: ['1', '2', '3'] };

  it('verifies ids whose file is present', () => {
    const items = [item('/d/A-1-9100001.pdf'), item('/d/B-2-9100001.pdf')];
    expect(reconcile({ record, items }).verified.sort()).toEqual(['1', '2']);
  });

  it('reports ids whose file no longer exists on disk', () => {
    const items = [item('/d/A-1-9100001.pdf', { exists: false })];
    expect(reconcile({ record, items }).missing).toEqual(['1']);
  });

  it('reports interrupted downloads as missing', () => {
    const items = [item('/d/A-1-9100001.pdf', { state: 'interrupted' })];
    expect(reconcile({ record, items }).missing).toEqual(['1']);
  });

  it('reports ledger ids with no download record as unverifiable', () => {
    const items = [item('/d/A-1-9100001.pdf')];
    expect(reconcile({ record, items }).unverifiable.sort()).toEqual(['2', '3']);
  });

  it('reports downloads absent from the ledger as orphans to adopt', () => {
    const items = [item('/d/A-1-9100001.pdf'), item('/d/Z-99-9100001.pdf')];
    expect(reconcile({ record, items }).orphans).toEqual(['99']);
  });

  it('counts a retried download as present, never as both present and missing', () => {
    const items = [
      item('/d/A-1-9100001.pdf', { state: 'interrupted' }),
      item('/d/A-1-9100001.pdf'),
    ];
    const out = reconcile({ record, items });
    expect(out.verified).toEqual(['1']);
    expect(out.missing).toEqual([]);
  });

  it('ignores a download still in flight rather than calling it missing', () => {
    const items = [item('/d/A-1-9100001.pdf', { state: 'in_progress' })];
    const out = reconcile({ record, items });
    expect(out.missing).toEqual([]);
    expect(out.verified).toEqual([]);
    expect(out.unverifiable).toContain('1');
  });

  it('handles an empty history without throwing', () => {
    const out = reconcile({ record, items: [] });
    expect(out.verified).toEqual([]);
    expect(out.unverifiable.sort()).toEqual(['1', '2', '3']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npx vitest run tests/reconcile.test.js
```

Expected: FAIL — cannot resolve `../src/lib/reconcile.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/reconcile.js`:

```js
// Filenames are `{name}-{userId}-{jobId}.{ext}`, so a job's files are exactly
// the ones ending in -<digits>-<jobId>.<ext>.
export function downloadRegexForJob(jobId) {
  return `-\\d+-${jobId}\\.[A-Za-z0-9]{2,5}$`;
}

export function userIdFromFilename(path, jobId) {
  const base = String(path).split(/[\\/]/).pop() ?? '';
  const match = base.match(new RegExp(`-(\\d+)-${jobId}\\.[A-Za-z0-9]{2,5}$`));
  return match ? match[1] : null;
}

export function reconcile({ record, items }) {
  const ledgerIds = new Set(record.userIds ?? []);

  // Decide per person, not per download record. Chrome keeps a separate history
  // entry for every attempt, so one candidate can have a completed download and
  // an interrupted retry. Judging each entry on its own would put that person in
  // both the present and the missing bucket.
  const best = new Map(); // userId -> true if any attempt landed a file on disk
  for (const it of items) {
    const userId = userIdFromFilename(it.filename, record.jobId);
    if (!userId) continue;
    // A download still in flight is neither present nor missing. Ignore it and
    // let the next reconciliation, after it settles, decide.
    if (it.state === 'in_progress') continue;
    const ok = it.state === 'complete' && it.exists !== false;
    best.set(userId, (best.get(userId) ?? false) || ok);
  }

  const present = new Set();
  const missing = new Set();
  const orphans = new Set();
  for (const [userId, ok] of best) {
    if (!ledgerIds.has(userId)) {
      if (ok) orphans.add(userId);
    } else if (ok) {
      present.add(userId);
    } else {
      missing.add(userId);
    }
  }

  const unverifiable = [...ledgerIds].filter((id) => !present.has(id) && !missing.has(id));

  return {
    verified: [...present],
    missing: [...missing],
    unverifiable,
    orphans: [...orphans],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npx vitest run tests/reconcile.test.js
```

Expected: 13 passed.

- [ ] **Step 5: Extend the ledger to store userIds alongside applicantIds**

`reconcile` needs `record.userIds`. Modify `src/lib/ledger.js`: `emptyRecord` gains `seenUserIds: []`, `markDownloaded` and `adopt` take `entries: Array<{ applicantId, userId }>` instead of bare ids, and both lists are merged and capped together.

Replace `markDownloaded` and `adopt` in `src/lib/ledger.js`:

```js
    async markDownloaded(jobId, entries, meta = {}) {
      const record = await get(jobId);
      const ids = merge(record.seenIds, entries.map((e) => e.applicantId));
      const users = merge(record.seenUserIds ?? [], entries.map((e) => e.userId));
      await put({
        ...record,
        jobTitle: meta.jobTitle ?? record.jobTitle,
        seenIds: ids.list,
        seenUserIds: users.list,
        totalDownloaded: record.totalDownloaded + ids.addedCount,
      });
    },
    async adopt(jobId, entries) {
      const record = await get(jobId);
      const ids = merge(record.seenIds, entries.map((e) => e.applicantId));
      const users = merge(record.seenUserIds ?? [], entries.map((e) => e.userId));
      await put({ ...record, seenIds: ids.list, seenUserIds: users.list });
    },
```

And change `merge` to operate on a list:

```js
  function merge(existingList, ids) {
    const existing = new Set(existingList);
    // Add as we filter, so a batch is deduped against itself as well as against
    // what is already stored.
    const added = ids.filter((id) => {
      if (!id || existing.has(id)) return false;
      existing.add(id);
      return true;
    });
    const list = [...existingList, ...added];
    return {
      list: list.length > MAX_SEEN ? list.slice(list.length - MAX_SEEN) : list,
      addedCount: added.length,
    };
  }
```

And add `seenUserIds: []` to `emptyRecord`.

- [ ] **Step 6: Update the ledger tests for the new signature**

In `tests/ledger.test.js`, replace every `['JP1', 'JP2']` argument with entry objects, e.g. `[{ applicantId: 'JP1', userId: '1' }, { applicantId: 'JP2', userId: '2' }]`, and the eviction test's array with `Array.from({ length: MAX_SEEN + 10 }, (_, i) => ({ applicantId: 'JP' + i, userId: String(i) }))`. Add one test:

```js
it('tracks userIds alongside applicantIds for reconciliation', async () => {
  await ledger.markDownloaded(
    '9100001',
    [{ applicantId: 'JP1', userId: '111' }],
    { jobTitle: 'x' },
  );
  expect((await ledger.get('9100001')).seenUserIds).toEqual(['111']);
});
```

- [ ] **Step 7: Run the full suite**

```powershell
npm test
```

Expected: all files pass, including the updated ledger tests.

- [ ] **Step 8: Commit**

```powershell
git add src/lib/reconcile.js tests/reconcile.test.js src/lib/ledger.js tests/ledger.test.js
git commit -m "feat: reconcile the ledger against Chrome download history"
```

---

### Task 9: MAIN-world collector

**Files:**
- Create: `src/lib/messages.js`
- Rewrite: `src/content/collector.js`

**Interfaces:**
- Consumes: nothing (classic script, no imports — the constants are duplicated inline by design, with a comment pointing at `messages.js`).
- Produces, over `window.postMessage`:
  - request `{ source: 'wfx-cs', id, type: 'LIST_JOBS' }` → response `{ source: 'wfx-page', id, ok, data: Array<{ jobId, title, actionableCount, draft }> }`
  - request `{ source: 'wfx-cs', id, type: 'FETCH_PAGE', payload: { jobId, first, after } }` → response `{ ok, data: { edges: object[], endCursor, hasNextPage, jobTitle } }`

- [ ] **Step 1: Write `src/lib/messages.js`**

```js
// The only runtime messaging in this extension is panel -> content script.
// The panel imports these; bridge.js and collector.js are classic content
// scripts and cannot import, so they carry the same literals inline.
export const CX = {
  LIST_JOBS: 'CX_LIST_JOBS',
  FETCH_PAGE: 'CX_FETCH_PAGE',
};
```

- [ ] **Step 2: Write `src/content/collector.js`**

The `first`/`after` override is the only change made to the app's own variables — everything else is copied from the live observable query, so the request shape follows the UI exactly.

```js
// MAIN world. Talks to the page's own Apollo client so every request carries
// Wellfound's signature headers. Never constructs a query or its variables.
(() => {
  const OP = 'RecruitJobListingApplicants';

  function client() {
    const c = window.__APOLLO_CLIENT__;
    if (!c) throw new Error('Wellfound app not loaded on this page');
    return c;
  }

  function liveQuery() {
    const queries = [...client().getObservableQueries().values()];
    const found = queries.find((q) => {
      const def = q.options?.query?.definitions?.[0];
      return def?.name?.value === OP;
    });
    if (!found) throw new Error(`${OP} is not active yet`);
    return found;
  }

  function listJobs() {
    const snapshot = client().cache.extract();
    return Object.values(snapshot)
      .filter((v) => v && v.__typename === 'JobListing' && v.id && v.title)
      .map((v) => ({
        jobId: String(v.id),
        title: v.title,
        actionableCount: v.actionableApplicantsCount ?? null,
        draft: Boolean(v.draft),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async function fetchPage({ jobId, first, after }) {
    const q = liveQuery();
    const variables = {
      ...JSON.parse(JSON.stringify(q.options.variables)),
      jobId: String(jobId),
      first,
      after: after ?? null,
    };
    const result = await client().query({
      query: q.options.query,
      variables,
      fetchPolicy: 'network-only',
    });
    if (result.errors?.length) throw new Error(result.errors[0].message);
    const listing = result.data?.talent?.viewer?.currentStartup?.recruit?.jobListing;
    if (!listing) throw new Error('Unexpected response shape');
    const conn = listing.applicants;
    return {
      jobTitle: listing.title ?? null,
      // Whichever tab the recruiter has open. We copy the UI's filters rather
      // than forcing one, so the export follows what they are looking at.
      bucket: variables.filters?.status ?? null,
      edges: conn.edges.map((e) => e.node),
      endCursor: conn.pageInfo.endCursor,
      hasNextPage: Boolean(conn.pageInfo.hasNextPage),
    };
  }

  const handlers = { LIST_JOBS: async () => listJobs(), FETCH_PAGE: (p) => fetchPage(p) };

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

  window.postMessage({ source: 'wfx-page', id: 'ready', ok: true, data: 'ready' }, '*');
})();
```

- [ ] **Step 3: Reload the extension and verify against the live page**

Reload the extension at `brave://extensions`, open a Wellfound applicant page, and in the **page console** (not the extension's) run:

```js
const once = (type, payload) =>
  new Promise((res) => {
    const id = String(Math.random());
    window.addEventListener('message', function h(e) {
      if (e.data?.source === 'wfx-page' && e.data.id === id) {
        window.removeEventListener('message', h);
        res(e.data);
      }
    });
    window.postMessage({ source: 'wfx-cs', id, type, payload }, '*');
  });

await once('LIST_JOBS');
```

Expected: `ok: true` and an array of 5 jobs with titles and `actionableCount` matching the sidebar.

- [ ] **Step 4: Verify pagination**

```js
const p1 = await once('FETCH_PAGE', { jobId: '9100001', first: 10, after: null });
const p2 = await once('FETCH_PAGE', { jobId: '9100001', first: 10, after: p1.data.endCursor });
[p1.data.edges.length, p2.data.edges.length, p1.data.edges[0].id !== p2.data.edges[0].id];
```

Expected: `[10, 10, true]`.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/messages.js src/content/collector.js
git commit -m "feat: drive the page Apollo client from a MAIN-world collector"
```

---

### Task 10: ISOLATED-world bridge

**Files:**
- Rewrite: `src/content/bridge.js`

**Interfaces:**
- Consumes: the collector's `window.postMessage` protocol from Task 9.
- Produces: `chrome.runtime` message handling for `{ type: 'CX_LIST_JOBS' }` and `{ type: 'CX_FETCH_PAGE', payload }`, each resolving to `{ ok, data }` or `{ ok: false, error }`.

- [ ] **Step 1: Write `src/content/bridge.js`**

The allowlist matters: without it, any script on the page could post a message that the bridge would forward into the extension.

```js
// ISOLATED world. A relay and nothing else — no logic, no state beyond pending
// requests. Only the two message types below are forwarded.
(() => {
  const ALLOWED = new Set(['LIST_JOBS', 'FETCH_PAGE']);
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
    return false;
  });
})();
```

- [ ] **Step 2: Reload and verify from the service worker console**

Reload the extension, open a Wellfound applicant page, then open the extension's **service worker** console from `brave://extensions` and run:

```js
const [tab] = await chrome.tabs.query({ url: 'https://wellfound.com/recruit/applicants/*' });
await chrome.tabs.sendMessage(tab.id, { type: 'CX_LIST_JOBS' });
```

Expected: `{ ok: true, data: [ ...5 jobs... ] }`.

- [ ] **Step 3: Verify the allowlist blocks anything else**

In the **page** console:

```js
window.postMessage({ source: 'wfx-cs', id: 'x', type: 'EVIL' }, '*');
```

Expected: nothing happens; no response, no error thrown into the extension.

- [ ] **Step 4: Commit**

```powershell
git add src/content/bridge.js
git commit -m "feat: add ISOLATED-world bridge with a message allowlist"
```

---

### Task 11: Downloader

**Files:**
- Create: `src/panel/downloader.js`

**Interfaces:**
- Consumes: `buildFilename` from Task 2.
- Produces:
  - `registerFilenameHandler(): void` — installs the `onDeterminingFilename` listener; call once at panel module top level
  - `downloadResume({ url, name, userId, jobId, folder }): Promise<{ downloadId, filename }>` — resolves when the download completes, rejects if it is interrupted
  - `downloadCsv({ dataUrl, filename, folder }): Promise<number>`

`onDeterminingFilename` is the only place with access to `finalUrl`, which is where the true file extension lives. The intended name is stashed by `downloadId` before the listener fires.

**This module lives in the panel, not the service worker.** `pendingNames` and the
per-download completion listener are in-memory state whose lifetime must cover a
download. A service worker is terminated after 30 s idle, which would leave the
map empty when the filename event fired — Chrome would fall back to the S3 hash
name, silently, and `downloadResume` would still resolve as if the intended name
had been applied. The panel is open for the whole run by construction, so the
state lives exactly as long as it needs to.

Registering the listener only in the panel also avoids two contexts racing to
`suggest()` on the same event.

Known edge: if the panel is closed while one download is in flight, that file
lands with Chrome's default name and is never recorded in the ledger, so the next
run re-downloads it and overwrites. Self-healing, and at most one file.

- [ ] **Step 1: Write `src/panel/downloader.js`**

```js
import { buildFilename } from '../lib/filename.js';

const pendingNames = new Map(); // downloadId → { name, userId, jobId, folder }

export function registerFilenameHandler() {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const meta = pendingNames.get(item.id);
    if (!meta) return false; // not ours — leave Chrome's default alone
    const filename = buildFilename({
      name: meta.name,
      userId: meta.userId,
      jobId: meta.jobId,
      url: item.finalUrl || item.url,
      mimeType: item.mime,
    });
    suggest({ filename: `${meta.folder}/${filename}`, conflictAction: 'overwrite' });
    pendingNames.delete(item.id);
    return true;
  });
}

function waitForCompletion(downloadId) {
  return new Promise((resolve, reject) => {
    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      } else if (delta.state?.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error(delta.error?.current ?? 'Download interrupted'));
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

export async function downloadResume({ url, name, userId, jobId, folder }) {
  const downloadId = await chrome.downloads.download({ url, conflictAction: 'overwrite' });
  pendingNames.set(downloadId, { name, userId, jobId, folder });
  try {
    await waitForCompletion(downloadId);
  } finally {
    // A download that fails before Chrome ever asks for a filename never reaches
    // the listener, so clean up here too or the map grows for the whole run.
    pendingNames.delete(downloadId);
  }
  const [item] = await chrome.downloads.search({ id: downloadId });
  return { downloadId, filename: item?.filename ?? null };
}

export async function downloadCsv({ dataUrl, filename, folder }) {
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: `${folder}/${filename}`,
    conflictAction: 'uniquify',
  });
  await waitForCompletion(downloadId);
  return downloadId;
}
```

- [ ] **Step 2: Leave the service worker alone**

`src/background/service-worker.js` keeps only the side panel behaviour. It must
**not** import the downloader — the filename listener is registered by the panel,
so that the map it reads and the listener that reads it share one lifetime.

```js
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
```

- [ ] **Step 3: Verify against a real resume**

Reload the extension. On a Wellfound applicant page, get a resume URL from the page console:

```js
const c = window.__APOLLO_CLIENT__;
const q = [...c.getObservableQueries().values()].find(
  (x) => x.options.query.definitions[0].name?.value === 'RecruitJobListingApplicants',
);
const r = await c.query({ query: q.options.query, variables: { ...q.options.variables, first: 1 }, fetchPolicy: 'network-only' });
r.data.talent.viewer.currentStartup.recruit.jobListing.applicants.edges[0].node.recruitCandidate.candidate.resumeUrl;
```

Then open the side panel, right-click inside it, choose Inspect, and in the
**panel's** console paste that URL into:

```js
const { registerFilenameHandler, downloadResume } = await import('./downloader.js');
registerFilenameHandler();
await downloadResume({
  url: '<paste>',
  name: 'Test Candidate',
  userId: '999',
  jobId: '9100001',
  folder: 'wellfound-resumes',
});
```

Expected: resolves, and `Downloads/wellfound-resumes/Test Candidate-999-9100001.pdf` exists and opens as a valid PDF.

- [ ] **Step 4: Delete the test file and commit**

```powershell
Remove-Item "$env:USERPROFILE\Downloads\wellfound-resumes\Test Candidate-999-9100001.pdf"
git add src/background/downloader.js src/background/service-worker.js
git commit -m "feat: download resumes with deterministic filenames"
```

---

### Task 12: The run loop

**Files:**
- Create: `src/lib/runner.js`
- Test: `tests/runner.test.js`

**Interfaces:**
- Consumes: `diffPage`, `createEarlyStop` (Task 6); `normalizeNode` (Task 5); `PACING`, `sample`, `sampleInt` (Task 4).
- Produces:
  - `runJob(deps, options): Promise<RunResult>` where every side effect is injected:

```
deps    = { fetchPage, downloadResume, recordDownloaded, sleep, emit, rand? }
options = { jobId, jobTitle, seenIds: string[], pageSize, folder,
            limit, forceFullWalk, dryRun }
RunResult = { downloaded: Applicant[], skipped: Applicant[], failed: Applicant[],
              records: Applicant[], stoppedBecause: 'exhausted'|'early-stop'|'limit'|'aborted' }
```

All I/O is injected so the loop's pacing, dedup and abort behaviour are testable in milliseconds without a browser.

`recordDownloaded(record)` is awaited after each file lands, so the ledger is
written **incrementally** rather than once at the end of a job. If a run is
aborted or the panel is closed after 200 of 255 downloads, those 200 are already
recorded and the next run does not fetch them again.

- [ ] **Step 1: Write the failing tests**

`tests/runner.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { runJob } from '../src/lib/runner.js';

function node(id) {
  return {
    id: `JP${id}`,
    currentApplication: { submittedAt: '2026-08-01T00:00:00Z' },
    recruitCandidate: {
      masked: false,
      candidate: {
        userId: String(id),
        name: `Person ${id}`,
        resumeUrl: `https://wellfound.com/link/${id}/tok/resume_url`,
      },
    },
  };
}

function pager(pages) {
  let call = 0;
  return vi.fn(async () => {
    const page = pages[call] ?? { edges: [], endCursor: null, hasNextPage: false };
    call += 1;
    return page;
  });
}

const page = (ids, hasNextPage = true) => ({
  edges: ids.map(node),
  endCursor: `cursor-${ids[0] ?? 'end'}`,
  hasNextPage,
  jobTitle: 'Backend Engineer',
});

function deps(overrides = {}) {
  return {
    fetchPage: pager([page([1, 2], false)]),
    downloadResume: vi.fn(async () => ({ filename: 'x.pdf' })),
    recordDownloaded: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    emit: vi.fn(),
    ...overrides,
  };
}

const options = {
  jobId: '9100001',
  jobTitle: 'Backend Engineer',
  seenIds: [],
  pageSize: 10,
  folder: 'wellfound-resumes',
  limit: 250,
  forceFullWalk: false,
  dryRun: false,
};

describe('runJob', () => {
  it('downloads every fresh applicant exactly once', async () => {
    const d = deps();
    const out = await runJob(d, options);
    expect(d.downloadResume).toHaveBeenCalledTimes(2);
    expect(out.downloaded.map((r) => r.userId)).toEqual(['1', '2']);
    expect(out.stoppedBecause).toBe('exhausted');
  });

  it('skips applicants already in the ledger', async () => {
    const d = deps();
    const out = await runJob(d, { ...options, seenIds: ['JP1'] });
    expect(d.downloadResume).toHaveBeenCalledTimes(1);
    expect(out.downloaded.map((r) => r.userId)).toEqual(['2']);
  });

  it('follows the cursor across pages', async () => {
    const d = deps({ fetchPage: pager([page([1, 2]), page([3, 4], false)]) });
    await runJob(d, options);
    expect(d.fetchPage).toHaveBeenNthCalledWith(1, { jobId: '9100001', first: 10, after: null });
    expect(d.fetchPage).toHaveBeenNthCalledWith(2, {
      jobId: '9100001',
      first: 10,
      after: 'cursor-1',
    });
  });

  it('stops after three consecutive fully-seen pages', async () => {
    const d = deps({
      fetchPage: pager([page([1]), page([2]), page([3]), page([4]), page([5])]),
    });
    const out = await runJob(d, { ...options, seenIds: ['JP1', 'JP2', 'JP3', 'JP4', 'JP5'] });
    expect(d.fetchPage).toHaveBeenCalledTimes(3);
    expect(out.stoppedBecause).toBe('early-stop');
  });

  it('walks past fully-seen pages when forceFullWalk is set', async () => {
    const d = deps({
      fetchPage: pager([page([1]), page([2]), page([3]), page([4], false)]),
    });
    const out = await runJob(d, {
      ...options,
      forceFullWalk: true,
      seenIds: ['JP1', 'JP2', 'JP3', 'JP4'],
    });
    expect(d.fetchPage).toHaveBeenCalledTimes(4);
    expect(out.stoppedBecause).toBe('exhausted');
  });

  it('honours the per-run limit', async () => {
    const d = deps({ fetchPage: pager([page([1, 2, 3, 4, 5])]) });
    const out = await runJob(d, { ...options, limit: 2 });
    expect(d.downloadResume).toHaveBeenCalledTimes(2);
    expect(out.stoppedBecause).toBe('limit');
  });

  it('records applicants without a resume as skipped, not failed', async () => {
    const noResume = node(1);
    noResume.recruitCandidate.candidate.resumeUrl = null;
    const d = deps({
      fetchPage: pager([{ edges: [noResume], endCursor: 'c', hasNextPage: false }]),
    });
    const out = await runJob(d, options);
    expect(d.downloadResume).not.toHaveBeenCalled();
    expect(out.skipped).toHaveLength(1);
    expect(out.downloaded).toHaveLength(0);
  });

  it('records each download as it lands, not once at the end', async () => {
    const order = [];
    const d = deps({
      downloadResume: vi.fn(async () => {
        order.push('download');
        return { filename: 'x.pdf' };
      }),
      recordDownloaded: vi.fn(async () => {
        order.push('record');
      }),
    });
    await runJob(d, options);
    expect(d.recordDownloaded).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['download', 'record', 'download', 'record']);
  });

  it('does not record an applicant whose download failed', async () => {
    const d = deps({
      downloadResume: vi
        .fn()
        .mockRejectedValueOnce(new Error('interrupted'))
        .mockResolvedValueOnce({ filename: 'ok.pdf' }),
    });
    await runJob(d, options);
    expect(d.recordDownloaded).toHaveBeenCalledTimes(1);
    expect(d.recordDownloaded.mock.calls[0][0].userId).toBe('2');
  });

  it('records nothing in dry-run mode', async () => {
    const d = deps();
    await runJob(d, { ...options, dryRun: true });
    expect(d.recordDownloaded).not.toHaveBeenCalled();
  });

  it('keeps a failed download out of downloaded so it retries next run', async () => {
    const d = deps({
      downloadResume: vi
        .fn()
        .mockRejectedValueOnce(new Error('interrupted'))
        .mockResolvedValueOnce({ filename: 'ok.pdf' }),
    });
    const out = await runJob(d, options);
    expect(out.failed.map((r) => r.userId)).toEqual(['1']);
    expect(out.downloaded.map((r) => r.userId)).toEqual(['2']);
  });

  it('emits every applicant into the CSV record set, downloaded or not', async () => {
    const noResume = node(2);
    noResume.recruitCandidate.candidate.resumeUrl = null;
    const d = deps({
      fetchPage: pager([{ edges: [node(1), noResume], endCursor: 'c', hasNextPage: false }]),
    });
    const out = await runJob(d, options);
    expect(out.records).toHaveLength(2);
  });

  it('downloads nothing in dry-run mode but still builds records', async () => {
    const d = deps();
    const out = await runJob(d, { ...options, dryRun: true });
    expect(d.downloadResume).not.toHaveBeenCalled();
    expect(out.records).toHaveLength(2);
  });

  it('aborts the whole run when a page fetch throws', async () => {
    const d = deps({ fetchPage: vi.fn(async () => { throw new Error('429 Too Many Requests'); }) });
    await expect(runJob(d, options)).rejects.toThrow('429');
    expect(d.downloadResume).not.toHaveBeenCalled();
  });

  it('stops promptly when the abort signal fires', async () => {
    const controller = new AbortController();
    const d = deps({
      fetchPage: pager([page([1, 2]), page([3, 4])]),
      downloadResume: vi.fn(async () => {
        controller.abort();
        return { filename: 'x.pdf' };
      }),
    });
    const out = await runJob(d, { ...options, signal: controller.signal });
    expect(out.stoppedBecause).toBe('aborted');
    expect(d.downloadResume).toHaveBeenCalledTimes(1);
  });

  it('sleeps between downloads and between pages', async () => {
    const d = deps({ fetchPage: pager([page([1, 2]), page([3], false)]) });
    await runJob(d, options);
    expect(d.sleep.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const [ms] of d.sleep.mock.calls) expect(ms).toBeGreaterThan(0);
  });

  it('emits lifecycle events the panel renders', async () => {
    const d = deps();
    await runJob(d, options);
    const types = d.emit.mock.calls.map(([e]) => e.type);
    expect(types).toContain('started');
    expect(types).toContain('candidate');
    expect(types).toContain('job_done');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npx vitest run tests/runner.test.js
```

Expected: FAIL — cannot resolve `../src/lib/runner.js`.

- [ ] **Step 3: Write the implementation**

`src/lib/runner.js`:

```js
import { normalizeNode } from './normalize.js';
import { diffPage, createEarlyStop } from './dedup.js';
import { PACING, sample, sampleInt } from './jitter.js';

export async function runJob(deps, options) {
  const { fetchPage, downloadResume, recordDownloaded, sleep, emit } = deps;
  const rand = deps.rand ?? Math.random;
  const {
    jobId,
    jobTitle,
    seenIds,
    pageSize,
    folder,
    limit,
    forceFullWalk,
    dryRun,
    signal,
  } = options;

  const seen = new Set(seenIds);
  const earlyStop = createEarlyStop({ forceFullWalk });
  const downloaded = [];
  const skipped = [];
  const failed = [];
  const records = [];

  let after = null;
  let sinceBreak = 0;
  let breakAt = sampleInt(PACING.breakEvery, rand);
  let stoppedBecause = 'exhausted';

  emit({ type: 'started', jobId, jobTitle });

  while (true) {
    if (signal?.aborted) {
      stoppedBecause = 'aborted';
      break;
    }

    const pageResult = await fetchPage({ jobId, first: pageSize, after });
    const pageRecords = pageResult.edges.map((n) =>
      normalizeNode(n, { jobId, jobTitle: pageResult.jobTitle ?? jobTitle }),
    );
    const { fresh, allSeen } = diffPage(pageRecords, seen);
    records.push(...pageRecords);
    earlyStop.observe(allSeen);
    emit({
      type: 'page',
      jobId,
      bucket: pageResult.bucket ?? null,
      fetched: pageRecords.length,
      fresh: fresh.length,
    });

    for (const record of fresh) {
      if (signal?.aborted) {
        stoppedBecause = 'aborted';
        break;
      }
      if (downloaded.length >= limit) {
        stoppedBecause = 'limit';
        break;
      }

      seen.add(record.applicantId);

      if (!record.resumeUrl) {
        skipped.push(record);
        emit({ type: 'candidate', jobId, name: record.name, outcome: 'skipped' });
        continue;
      }

      if (dryRun) {
        emit({ type: 'candidate', jobId, name: record.name, outcome: 'dry-run' });
        continue;
      }

      try {
        await downloadResume({
          url: record.resumeUrl,
          name: record.name,
          userId: record.userId,
          jobId,
          folder,
        });
        // Record before anything else can interrupt: a file on disk that the
        // ledger does not know about gets fetched again on the next run.
        await recordDownloaded(record);
        downloaded.push(record);
        emit({ type: 'candidate', jobId, name: record.name, outcome: 'downloaded' });
      } catch (error) {
        failed.push(record);
        emit({
          type: 'candidate',
          jobId,
          name: record.name,
          outcome: 'failed',
          error: String(error.message || error),
        });
      }

      sinceBreak += 1;
      if (sinceBreak >= breakAt) {
        const breakMs = sample(PACING.breakMs[0], PACING.breakMs[1], rand);
        emit({ type: 'break', jobId, ms: breakMs });
        await sleep(breakMs);
        sinceBreak = 0;
        breakAt = sampleInt(PACING.breakEvery, rand);
      } else {
        const restMs = sample(PACING.downloadMs[0], PACING.downloadMs[1], rand);
        emit({ type: 'resting', jobId, ms: restMs });
        await sleep(restMs);
      }
    }

    if (stoppedBecause !== 'exhausted') break;
    if (earlyStop.shouldStop()) {
      stoppedBecause = 'early-stop';
      break;
    }
    if (!pageResult.hasNextPage) break;

    after = pageResult.endCursor;
    const pageMs = sample(PACING.pageMs[0], PACING.pageMs[1], rand);
    emit({ type: 'resting', jobId, ms: pageMs });
    await sleep(pageMs);
  }

  emit({ type: 'job_done', jobId, downloaded: downloaded.length, stoppedBecause });
  return { downloaded, skipped, failed, records, stoppedBecause };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npx vitest run tests/runner.test.js
```

Expected: 14 passed.

- [ ] **Step 5: Run the full suite**

```powershell
npm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/runner.js tests/runner.test.js
git commit -m "feat: add the paced, dedup-aware run loop"
```

---

### Task 13: Panel run controller

**Files:**
- Create: `src/panel/run-controller.js`
- Verify unchanged: `src/background/service-worker.js`

**Interfaces:**
- Consumes: `runJob` (Task 12), `createLedger` (Task 7), `reconcile`/`downloadRegexForJob` (Task 8), `downloadResume`/`downloadCsv`/`registerFilenameHandler` (Task 11), `toCsv`/`userIdsFromCsv` (Task 3), `sleep` (Task 4).
- Produces:
  - `createController({ onEvent }): Controller`
  - `Controller`: `listJobs()`, `startRun(settings)`, `abort()`, `library()`, `reconcileJob(jobId)`, `importCsv(jobId, text)`, `forget(jobId)`, `redownloadMissing(jobId, folder)` (added in Task 17)

This is the orchestrator. It runs **in the panel**, not the service worker — see
the Architecture note at the top of this plan. There is no `chrome.runtime`
message surface and no event broadcast: the panel imports this module directly
and passes an `onEvent` callback, so run events reach the UI by function call.

Run state lives in this module's closure for exactly as long as the panel is
open, which is exactly as long as a run can last. Closing the panel ends the run
by destroying its context, which is the intended behaviour.

- [ ] **Step 1: Write `src/panel/run-controller.js`**

```js
import { createLedger } from '../lib/ledger.js';
import { runJob } from '../lib/runner.js';
import { toCsv, userIdsFromCsv } from '../lib/csv.js';
import { sleep } from '../lib/jitter.js';
import { downloadRegexForJob, reconcile } from '../lib/reconcile.js';
import { CX } from '../lib/messages.js';
import { registerFilenameHandler, downloadResume, downloadCsv } from './downloader.js';

// Registered here, in the panel, so the listener and the name map it reads share
// one lifetime. See src/panel/downloader.js for why that matters.
registerFilenameHandler();

const APPLICANTS_URL = 'https://wellfound.com/recruit/applicants/';

export function createController({ onEvent }) {
  const ledger = createLedger(chrome.storage.local);
  let controller = null;

  function emit(event) {
    try {
      onEvent(event);
    } catch {
      // A rendering error must never abort a run.
    }
  }

  async function workingTab() {
    const [tab] = await chrome.tabs.query({ url: `${APPLICANTS_URL}*` });
    if (!tab) throw new Error('Open a Wellfound applicant page first');
    return tab;
  }

  async function askTab(tabId, message) {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (!response?.ok) throw new Error(response?.error ?? 'No response from the page');
    return response.data;
  }

  // The page's Apollo client only registers RecruitJobListingApplicants for the
  // job it is currently showing, so the tab is navigated per job and given time
  // to settle before the first fetch.
  async function focusJob(tabId, jobId) {
    const target = `${APPLICANTS_URL}jobs/${jobId}`;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url?.startsWith(target)) {
      await chrome.tabs.update(tabId, { url: target });
      await sleep(4000);
    }
  }

  async function writeCsv(jobId, records, folder) {
    if (records.length === 0) return;
    const text = toCsv(records);
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    try {
      await downloadCsv({ dataUrl: url, filename: `applicants-${jobId}-${date}.csv`, folder });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Declared as a closure, not only as a method, so callers may destructure the
  // controller without `this` going undefined.
  async function reconcileJob(jobId) {
    const record = await ledger.get(jobId);
    const items = await chrome.downloads.search({
      filenameRegex: downloadRegexForJob(jobId),
      limit: 0,
    });
    return reconcile({ record: { jobId, userIds: record.seenUserIds ?? [] }, items });
  }

  return {
    reconcileJob,

    // Enriched with ledger state so the UI can say how many are actually new
    // rather than how many sit in the review queue. `estimatedNew` is an
    // estimate: it cannot know about applicants who left the queue since the
    // last run. The run itself is authoritative.
    async listJobs() {
      const tab = await workingTab();
      const jobs = await askTab(tab.id, { type: CX.LIST_JOBS });
      return Promise.all(
        jobs.map(async (job) => {
          const record = await ledger.get(job.jobId);
          const downloaded = record.totalDownloaded;
          const estimatedNew =
            job.actionableCount == null ? null : Math.max(0, job.actionableCount - downloaded);
          return { ...job, downloaded, estimatedNew };
        }),
      );
    },

    abort() {
      const wasRunning = Boolean(controller);
      controller?.abort();
      return { aborted: wasRunning };
    },

    async startRun({ jobIds, folder, pageSize, limit, forceFullWalk, dryRun }) {
      if (controller) throw new Error('A run is already in progress');
      controller = new AbortController();
      const { signal } = controller;

      try {
        const tab = await workingTab();
        const jobs = await askTab(tab.id, { type: CX.LIST_JOBS });

        for (const jobId of jobIds) {
          if (signal.aborted) break;
          const job = jobs.find((j) => j.jobId === jobId);
          const jobTitle = job?.title ?? jobId;
          await focusJob(tab.id, jobId);

          const record = await ledger.get(jobId);
          const result = await runJob(
            {
              fetchPage: (args) => askTab(tab.id, { type: CX.FETCH_PAGE, payload: args }),
              downloadResume,
              // Written per file, not per job: a run that stops early must not
              // lose credit for resumes already on disk.
              recordDownloaded: (r) =>
                ledger.markDownloaded(
                  jobId,
                  [{ applicantId: r.applicantId, userId: r.userId }],
                  { jobTitle },
                ),
              sleep,
              emit,
            },
            {
              jobId,
              jobTitle,
              seenIds: record.seenIds,
              pageSize,
              folder,
              limit,
              forceFullWalk,
              dryRun,
              signal,
            },
          );

          if (!dryRun) {
            await ledger.finishRun(jobId, { downloaded: result.downloaded.length });
          }
          await writeCsv(jobId, result.records, folder);
        }

        emit({ type: 'done' });
      } catch (error) {
        emit({ type: 'error', error: String(error.message || error) });
        throw error;
      } finally {
        controller = null;
      }
    },

    async library() {
      const records = await ledger.all();
      const rows = [];
      for (const record of records) {
        const status = await reconcileJob(record.jobId);
        rows.push({
          jobId: record.jobId,
          jobTitle: record.jobTitle,
          downloaded: record.totalDownloaded,
          lastRunAt: record.lastRunAt,
          missing: status.missing.length,
          unverifiable: status.unverifiable.length,
          orphans: status.orphans.length,
        });
      }
      return rows;
    },

    async importCsv(jobId, text) {
      const userIds = userIdsFromCsv(text);
      await ledger.adopt(
        jobId,
        userIds.map((userId) => ({ applicantId: `imported:${userId}`, userId })),
      );
      return { imported: userIds.length };
    },

    forget(jobId) {
      return ledger.forget(jobId);
    },
  };
}
```

- [ ] **Step 2: Confirm the service worker was not touched**

`src/background/service-worker.js` must still be exactly:

```js
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
```

No imports, no message handlers, no run state. If it contains anything else, the
run loop has leaked back into a context Chrome will terminate mid-run.

- [ ] **Step 3: Verify job listing from the panel console**

Reload the extension, open a Wellfound applicant page, open the side panel,
right-click inside it and choose Inspect. In the panel's console:

```js
const { createController } = await import('./run-controller.js');
const c = createController({ onEvent: (e) => console.log('[wfx]', e.type, e) });
await c.listJobs();
```

Expected: an array of 5 jobs with titles and `actionableCount` matching the sidebar.

- [ ] **Step 4: Verify a dry run end to end**

```js
await c.startRun({
  jobIds: ['9100003'],
  folder: 'wellfound-resumes',
  pageSize: 10,
  limit: 250,
  forceFullWalk: false,
  dryRun: true,
});
```

Expected: resolves after roughly a minute, logging `page`, `candidate` and
`resting` events; `Downloads/wellfound-resumes/applicants-9100003-<date>.csv`
appears with 15 data rows (Sales Engineer has 15 applicants); no resume files are
written; `chrome.storage.local` gains no `job:` key, because dry runs do not record.

- [ ] **Step 5: Verify the worker idle timeout no longer matters**

Start the same dry run again and leave the panel open without interacting for
two minutes. It must complete. Then open `brave://serviceworker-internals` (or
check the extension card) and confirm the service worker being stopped does not
interrupt the run — the loop is in the panel, so it should not.

- [ ] **Step 6: Commit**

```powershell
git add src/panel/run-controller.js
git commit -m "feat: orchestrate runs from the panel, not the service worker"
```

---

### Task 14: Panel shell, fonts, and the Run screen

**Files:**
- Already vendored: `src/assets/fonts/InstrumentSans-Variable.woff2`, `JetBrainsMono-Variable.woff2`, `OFL-NOTICE.txt`
- Modify: `src/panel/tokens.css`, `src/panel/panel.css`, `src/panel/panel.html`, `src/panel/panel.js`

**Interfaces:**
- Consumes: `createController` from `./run-controller.js` (Task 13).
- Produces: a working Run screen — job list with counts, settings, and a start button that launches a run.

- [ ] **Step 1: Confirm the fonts are present**

They are already vendored, so there is nothing to download. Both are the Latin
subsets Google Fonts serves, and both are variable fonts, so one file covers the
whole weight range for its family. Confirm:

```powershell
Get-ChildItem src/assets/fonts
```

Expected: `InstrumentSans-Variable.woff2` (about 30 KB), `JetBrainsMono-Variable.woff2`
(about 21 KB), and `OFL-NOTICE.txt`. Both fonts are SIL Open Font License, and the
notice file records that. They are vendored rather than fetched because a Chrome
extension page cannot load fonts from the network under its CSP.

- [ ] **Step 2: Add `@font-face` rules to the top of `src/panel/tokens.css`**

Note the `font-weight` RANGE rather than a single value: these are variable fonts,
so one file serves 400 and 600 and the browser interpolates.

```css
@font-face {
  font-family: 'Instrument Sans';
  src: url('../assets/fonts/InstrumentSans-Variable.woff2') format('woff2');
  font-weight: 400 700;
  font-display: swap;
}

@font-face {
  font-family: 'JetBrains Mono';
  src: url('../assets/fonts/JetBrainsMono-Variable.woff2') format('woff2');
  font-weight: 400 700;
  font-display: swap;
}
```

- [ ] **Step 3: Append the Run screen styles to `src/panel/panel.css`**

```css
.jobs {
  padding: var(--space-2) 0;
}

.job {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  border-left: 2px solid transparent;
  padding: var(--space-3) var(--space-4);
  color: var(--paper);
  font: inherit;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease);
}

.job:hover {
  background: var(--surface);
}

.job[aria-pressed='true'] {
  background: var(--surface-hi);
  border-left-color: var(--sand);
}

.job-title {
  font-weight: 600;
}

.job-meta {
  color: var(--muted);
  font-size: 12px;
}

.settings {
  border-top: 1px solid var(--hairline);
  padding: var(--space-4);
  display: grid;
  gap: var(--space-3);
}

.setting {
  display: grid;
  grid-template-columns: 88px 1fr;
  align-items: center;
  gap: var(--space-3);
}

.setting input[type='text'],
.setting input[type='number'] {
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 6px;
  color: var(--paper);
  padding: 8px 10px;
  font: inherit;
  min-height: 36px;
}

.primary {
  width: calc(100% - var(--space-4) * 2);
  margin: 0 var(--space-4) var(--space-4);
  min-height: 44px;
  border: 0;
  border-radius: 8px;
  background: var(--sand);
  color: var(--ground);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease);
}

.primary:active {
  transform: scale(0.97);
}

.primary:disabled {
  opacity: 0.4;
  cursor: default;
}

.empty {
  padding: var(--space-6) var(--space-4);
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  * {
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
  }
}
```

- [ ] **Step 4: Write `src/panel/panel.js`**

```js
import { createController } from './run-controller.js';

const screen = document.getElementById('screen');
const state = { jobs: [], selected: new Set(), running: false };

// The run loop lives in this page, so run events arrive as direct calls rather
// than as messages from the service worker.
const controller = createController({ onEvent: handleRunEvent });

function settingsFromForm() {
  return {
    folder: document.getElementById('folder').value.trim() || 'wellfound-resumes',
    limit: Number(document.getElementById('limit').value) || 250,
    pageSize: document.getElementById('fast').checked ? 20 : 10,
    forceFullWalk: document.getElementById('full').checked,
    dryRun: document.getElementById('dry').checked,
  };
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function jobSubtitle(job) {
  if (job.estimatedNew == null) return ' to review';
  if (job.estimatedNew === 0) return job.downloaded ? ' · all downloaded' : ' to review';
  return ` · ${job.estimatedNew} new`;
}

function startLabel(count, selectedCount) {
  if (!selectedCount) return 'Select a job';
  return count > 0 ? `Download ${count} new` : 'Check for new applicants';
}

function renderRun() {
  const count = [...state.selected].reduce((sum, id) => {
    const job = state.jobs.find((j) => j.jobId === id);
    return sum + (job?.estimatedNew ?? job?.actionableCount ?? 0);
  }, 0);

  screen.innerHTML = `
    <div class="jobs">
      ${
        state.jobs.length === 0
          ? '<p class="empty">No jobs yet. Open a job\u2019s applicant list to add it.</p>'
          : state.jobs
              .map(
                (job) => `
        <button class="job" type="button" data-id="${job.jobId}"
                aria-pressed="${state.selected.has(job.jobId)}">
          <span class="job-title">${escapeHtml(job.title)}</span><br />
          <span class="job-meta num">${job.actionableCount ?? '\u2013'}</span>
          <span class="job-meta">${jobSubtitle(job)}</span>
        </button>`,
              )
              .join('')
      }
    </div>
    <div class="settings">
      <div class="setting"><span class="label">Folder</span>
        <input id="folder" type="text" value="wellfound-resumes" /></div>
      <div class="setting"><span class="label">Stop at</span>
        <input id="limit" type="number" min="1" value="250" /></div>
      <div class="setting"><span class="label">Faster</span>
        <label><input id="fast" type="checkbox" /> 20 per page</label></div>
      <div class="setting"><span class="label">Full walk</span>
        <label><input id="full" type="checkbox" /> ignore early stop</label></div>
      <div class="setting"><span class="label">Dry run</span>
        <label><input id="dry" type="checkbox" /> CSV only</label></div>
    </div>
    <button class="primary" id="start" type="button" ${state.selected.size ? '' : 'disabled'}>
      ${startLabel(count, state.selected.size)}
    </button>`;

  for (const button of screen.querySelectorAll('.job')) {
    button.addEventListener('click', () => {
      const id = button.dataset.id;
      state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
      renderRun();
    });
  }

  document.getElementById('start')?.addEventListener('click', async () => {
    state.running = true;
    renderRunning();
    try {
      await controller.startRun({ jobIds: [...state.selected], ...settingsFromForm() });
    } catch (error) {
      renderError(error.message);
    }
  });
}

function renderRunning() {
  screen.innerHTML = `
    <div class="settings">
      <p class="label">Running</p>
      <p id="progress" class="num">0</p>
      <p id="current"></p>
      <p id="status" class="job-meta"></p>
    </div>
    <button class="primary" id="abort" type="button">Stop the run</button>`;
  document.getElementById('abort').addEventListener('click', () => controller.abort());
}

function renderError(message) {
  state.running = false;
  screen.innerHTML = `<p class="empty">${message}</p>`;
}

function handleRunEvent(event) {
  const progress = document.getElementById('progress');
  if (event.type === 'candidate' && progress) {
    progress.textContent = String(Number(progress.textContent) + 1);
    document.getElementById('current').textContent = event.name ?? '';
  }
  if (event.type === 'resting') {
    document.getElementById('status').textContent = `resting \u00b7 ${Math.round(event.ms / 1000)}s`;
  }
  if (event.type === 'break') {
    document.getElementById('status').textContent = `reading break \u00b7 ${Math.round(event.ms / 1000)}s`;
  }
  if (event.type === 'done') {
    state.running = false;
    load();
  }
  if (event.type === 'error') renderError(event.error);
}

async function load() {
  try {
    state.jobs = await controller.listJobs();
  } catch (error) {
    renderError(error.message);
    return;
  }
  renderRun();
}

load();
```

- [ ] **Step 5: Verify in the browser**

Reload the extension, open a Wellfound applicant page, open the panel.

Expected: 5 jobs listed with counts matching the sidebar. Clicking a job gives it a sand left rule and a `surface-hi` background; the button reads "Download 114 new". Tick **Dry run**, select Sales Engineer, click the button — progress climbs, the status line alternates between resting and reading break, and a CSV lands in `Downloads/wellfound-resumes/`.

- [ ] **Step 6: Commit**

```powershell
git add src/panel src/assets
git commit -m "feat: add the Run screen with job selection and settings"
```

---

### Task 15: The breath lane

**Files:**
- Create: `src/panel/breath-lane.js`
- Modify: `src/panel/panel.css`, `src/panel/panel.js`

**Interfaces:**
- Consumes: run events from Task 13.
- Produces: `createBreathLane(element): { tick(outcome), rest(ms), break(ms), stop() }`

The lane draws the pacing at true scale: a tick per candidate, and the gap between ticks filling over the real interval. It is the panel's only ambient motion. Under `prefers-reduced-motion` it renders ticks but does not animate the gap.

- [ ] **Step 1: Write `src/panel/breath-lane.js`**

```js
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

export function createBreathLane(element) {
  element.classList.add('lane');
  element.innerHTML = '<div class="lane-fill"></div><div class="lane-ticks"></div>';
  const fill = element.querySelector('.lane-fill');
  const ticks = element.querySelector('.lane-ticks');
  let animation = null;

  function stopFill() {
    animation?.cancel();
    animation = null;
    fill.style.transform = 'scaleX(0)';
  }

  function drainOver(ms, className) {
    stopFill();
    element.dataset.mode = className;
    if (REDUCED.matches) return;
    // WAAPI: hardware accelerated, interruptible, and off the main thread.
    animation = fill.animate(
      [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      { duration: ms, easing: 'linear', fill: 'forwards' },
    );
  }

  return {
    tick(outcome) {
      stopFill();
      const mark = document.createElement('i');
      mark.className = `tick tick-${outcome}`;
      ticks.append(mark);
      if (ticks.childElementCount > 120) ticks.firstElementChild.remove();
    },
    rest(ms) {
      drainOver(ms, 'resting');
    },
    break(ms) {
      drainOver(ms, 'break');
    },
    stop() {
      stopFill();
      element.dataset.mode = 'idle';
    },
  };
}
```

- [ ] **Step 2: Append the lane styles to `src/panel/panel.css`**

```css
.lane {
  position: relative;
  height: 24px;
  margin: var(--space-4) var(--space-4) var(--space-2);
  border-bottom: 1px solid var(--hairline);
  overflow: hidden;
}

.lane-fill {
  position: absolute;
  inset: auto 0 0 0;
  height: 1px;
  background: var(--sand);
  transform: scaleX(0);
  transform-origin: left center;
  opacity: 0.5;
}

.lane[data-mode='break'] .lane-fill {
  opacity: 0.2;
}

.lane-ticks {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  gap: 3px;
}

.tick {
  width: 2px;
  height: 10px;
  background: var(--sand);
  animation: tick-in 200ms var(--ease);
}

/* A landed file is a terminal state for that candidate, so it takes the
   terminal colour. Sand stays reserved for what is still in motion: the
   draining fill, and dry-run marks for files that were never fetched. */
.tick-downloaded {
  background: var(--sage);
}

.tick-skipped {
  height: 5px;
  background: var(--muted);
}

.tick-failed {
  background: var(--rust);
}

@keyframes tick-in {
  from {
    opacity: 0;
    transform: scaleY(0.4);
  }
  to {
    opacity: 1;
    transform: scaleY(1);
  }
}
```

- [ ] **Step 3: Wire the lane into `src/panel/panel.js`**

Add the import at the top:

```js
import { createBreathLane } from './breath-lane.js';
```

Add a module-level `let lane = null;` beside `state`, then replace `renderRunning` with:

```js
function renderRunning() {
  screen.innerHTML = `
    <div id="lane"></div>
    <div class="settings">
      <p id="progress" class="num">0</p>
      <p id="current"></p>
      <p id="status" class="job-meta"></p>
    </div>
    <button class="primary" id="abort" type="button">Stop the run</button>`;
  lane = createBreathLane(document.getElementById('lane'));
  document.getElementById('abort').addEventListener('click', () => controller.abort());
}
```

And extend the run-event listener so each branch drives the lane:

```js
  if (event.type === 'candidate' && progress) {
    progress.textContent = String(Number(progress.textContent) + 1);
    document.getElementById('current').textContent = event.name ?? '';
    lane?.tick(event.outcome);
  }
  if (event.type === 'resting') {
    document.getElementById('status').textContent = `resting \u00b7 ${Math.round(event.ms / 1000)}s`;
    lane?.rest(event.ms);
  }
  if (event.type === 'break') {
    document.getElementById('status').textContent = `reading break \u00b7 ${Math.round(event.ms / 1000)}s`;
    lane?.break(event.ms);
  }
  if (event.type === 'done') {
    lane?.stop();
    state.running = false;
    load();
  }
```

- [ ] **Step 4: Verify in the browser**

Run a dry run on Sales Engineer with the panel open.

Expected: ticks accumulate left to right, one per candidate; between ticks a hairline fills across the lane over the real interval; during a reading break the fill dims. Enable **Settings → Accessibility → reduce motion** in the OS and re-run: ticks still appear, the fill no longer animates, and the status text still reports "resting · 4s".

- [ ] **Step 5: Commit**

```powershell
git add src/panel/breath-lane.js src/panel/panel.css src/panel/panel.js
git commit -m "feat: add the breath lane pacing visualization"
```

---

### Task 16: Library screen

**Files:**
- Create: `src/panel/library.js`
- Modify: `src/panel/panel.js`, `src/panel/panel.css`

**Interfaces:**
- Consumes: the controller from Task 13 - library(), reconcileJob(), importCsv(), forget().
- Produces: `renderLibrary(screen, { controller, onBack }): Promise<void>`

- [ ] **Step 1: Write `src/panel/library.js`**

```js
import { MSG } from '../lib/messages.js';

function row(job) {
  const missing = job.missing
    ? `<span class="warn num">${job.missing}</span><span class="job-meta"> missing from disk</span>`
    : '<span class="job-meta">all files present</span>';
  const last = job.lastRunAt ? new Date(job.lastRunAt).toLocaleDateString() : 'never';
  return `
    <div class="lib-row" data-id="${escapeHtml(job.jobId)}">
      <div class="job-title">${job.jobTitle ?? job.jobId}</div>
      <div class="job-meta">
        <span class="num">${job.downloaded}</span> downloaded \u00b7 last run ${last}
      </div>
      <div>${missing}</div>
      <div class="lib-actions">
        <button type="button" data-act="import">Import CSV</button>
        <button type="button" data-act="forget" class="danger">Forget this job</button>
      </div>
    </div>`;
}

export async function renderLibrary(screen, { controller, onBack }) {
  screen.innerHTML = '<p class="empty">Reading your download history\u2026</p>';
  let jobs;
  try {
    jobs = await controller.library();
  } catch (error) {
    screen.innerHTML = `<p class="empty">${error.message}</p>`;
    return;
  }

  screen.innerHTML = `
    <button class="label back" id="back" type="button">\u2190 Back</button>
    ${
      jobs.length === 0
        ? '<p class="empty">Nothing downloaded yet. Run a job to start a library.</p>'
        : jobs.map(row).join('')
    }`;

  document.getElementById('back').addEventListener('click', onBack);

  for (const element of screen.querySelectorAll('.lib-row')) {
    const jobId = element.dataset.id;

    element.querySelector('[data-act="import"]').addEventListener('click', async () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        const { imported } = await controller.importCsv(jobId, await file.text());
        // Re-render rather than append. This screen exists to show when the
        // ledger and the disk disagree, so leaving its own counts stale after
        // changing the ledger would be the one thing it must not do.
        await renderLibrary(screen, { controller, onBack });
        const row = screen.querySelector(`.lib-row[data-id="${jobId}"] .lib-actions`);
        row?.insertAdjacentHTML('afterend', `<div class="job-meta">Imported ${imported} people.</div>`);
      });
      input.click();
    });

    element.querySelector('[data-act="forget"]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (button.dataset.confirm !== 'yes') {
        button.dataset.confirm = 'yes';
        button.textContent = 'Forget \u2014 tap again';
        setTimeout(() => {
          button.dataset.confirm = '';
          button.textContent = 'Forget this job';
        }, 4000);
        return;
      }
      await controller.forget(jobId);
      renderLibrary(screen, { controller, onBack });
    });
  }
}
```

- [ ] **Step 2: Append the Library styles to `src/panel/panel.css`**

```css
.back {
  background: none;
  border: 0;
  color: var(--muted);
  cursor: pointer;
  padding: var(--space-3) var(--space-4);
  font: inherit;
}

.lib-row {
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--hairline);
  display: grid;
  gap: var(--space-1);
}

.lib-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.lib-actions button {
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 6px;
  color: var(--paper);
  padding: 8px 10px;
  min-height: 36px;
  font: inherit;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease);
}

.lib-actions button:active {
  transform: scale(0.97);
}

.danger {
  margin-left: auto;
  color: var(--rust);
}

.warn {
  color: var(--rust);
}
```

- [ ] **Step 3: Route to it from `src/panel/panel.js`**

Add the import:

```js
import { renderLibrary } from './library.js';
```

And at the end of the file, before `load()`:

```js
document.getElementById('nav-library').addEventListener('click', () => {
  renderLibrary(screen, { controller, onBack: load });
});
```

- [ ] **Step 4: Verify in the browser**

After at least one real run, click **Library**.

Expected: the job appears with its download count and last-run date, and "all files present". Delete one downloaded resume from `Downloads/wellfound-resumes/`, reopen Library — it now reads "1 missing from disk". **Forget this job** requires a second tap within 4 seconds before it clears.

- [ ] **Step 5: Commit**

```powershell
git add src/panel/library.js src/panel/panel.js src/panel/panel.css
git commit -m "feat: add the Library screen with reconciliation and CSV import"
```

---

### Task 17: Re-download missing, README, and full manual verification

**Files:**
- Modify: `src/background/service-worker.js`, `src/panel/library.js`
- Create: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a `redownloadMissing` method on the controller, and a documented, verified extension.

- [ ] **Step 1: Add `redownloadMissing` to `src/panel/run-controller.js`**

Insert as another method on the object `createController` returns:

```js
    async redownloadMissing({ jobId, folder }) {
      const status = await reconcileJob(jobId);
      if (status.missing.length === 0) return { refetched: 0 };
      const tab = await workingTab();
      await focusJob(tab.id, jobId);
      const wanted = new Set(status.missing);
      const record = await ledger.get(jobId);
      const dest = folder ?? 'wellfound-resumes';
      let after = null;
      let refetched = 0;

      while (wanted.size > 0) {
        const page = await askTab(tab.id, {
          type: CX.FETCH_PAGE,
          payload: { jobId, first: 10, after },
        });
        for (const node of page.edges) {
          const c = node.recruitCandidate?.candidate ?? {};
          const userId = c.userId != null ? String(c.userId) : null;
          if (!userId || !wanted.has(userId) || !c.resumeUrl) continue;
          await downloadResume({ url: c.resumeUrl, name: c.name, userId, jobId, folder: dest });
          // Record immediately, for the same reason a normal run does: a file on
          // disk the ledger does not know about gets fetched again next run.
          await ledger.markDownloaded(jobId, [{ applicantId: node.id, userId }], {
            jobTitle: record.jobTitle,
          });
          wanted.delete(userId);
          refetched += 1;
          emit({ type: 'candidate', jobId, name: c.name, outcome: 'downloaded' });
          await sleep(sample(PACING.downloadMs[0], PACING.downloadMs[1]));
        }
        if (!page.hasNextPage) break;
        after = page.endCursor;
        await sleep(sample(PACING.pageMs[0], PACING.pageMs[1]));
      }

      // Deliberately no 'done' event: the panel treats that as a finished run
      // and re-renders, which would throw the user off the Library screen
      // mid-action. The button reports its own result.
      return { refetched, stillMissing: wanted.size, jobTitle: record.jobTitle };
    },
```

Extend the imports at the top of the file:

```js
import { sleep, sample, PACING } from '../lib/jitter.js';
```

replacing the existing jitter import.

- [ ] **Step 2: Add the button to `src/panel/library.js`**

In `row()`, insert before the Import CSV button:

```js
        ${job.missing ? '<button type="button" data-act="refetch">Re-download missing</button>' : ''}
```

And in the per-row wiring, after the import listener:

```js
    element.querySelector('[data-act="refetch"]')?.addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = 'Re-downloading\u2026';
      const { refetched } = await controller.redownloadMissing({
        jobId,
        folder: "wellfound-resumes",
      });
      event.currentTarget.textContent = `Re-downloaded ${refetched}`;
    });
```

- [ ] **Step 3: Write `README.md`**

```markdown
# Wellfound Applicant Exporter

A Chrome MV3 extension that downloads applicant resumes and a CSV from your own
Wellfound recruiter job listings, and remembers who it already fetched.

## Install

1. `npm install`
2. Open `brave://extensions`, enable Developer mode, click **Load unpacked**,
   and select this folder.

## Use

1. Open a job's applicant list on Wellfound
   (`wellfound.com/recruit/applicants/jobs/...`).
2. Click the extension icon to open the side panel.
3. Select one or more jobs, set the download subfolder, click **Download N new**.

Files land in `Downloads/<subfolder>/` named `Name-userId-jobId.pdf`. A CSV of
the run is written alongside them.

## How it works

Wellfound's GraphQL endpoint is signature-gated: a replayed request without the
page's `x-apollo-signature` header returns 404. Rather than forging requests, a
MAIN-world content script drives the page's own Apollo client, copying the live
query's variables and overriding only the cursor and page size. Every request is
genuinely the site's own client, with its own session and signature.

Runs are strictly serial and paced with log-normal jitter, plus periodic longer
breaks. A 281-applicant job takes roughly 12 minutes. That is deliberate.

## Dedup

Three sources: an internal ledger, reconciliation against Chrome's own download
history (which catches files you deleted), and CSV import for a new machine. See
`docs/superpowers/specs/` for the full design.

## Test

`npm test`

## Limits

- The export follows whichever applicant tab your Wellfound page is showing.
  That is normally **Needs Review**. The panel names the bucket as soon as the
  first page arrives, before any file is downloaded.
- Files can only be written under your browser's Downloads directory — an
  extension cannot write elsewhere.
- Each run writes its own dated CSV; the extension cannot read files back to
  append to an earlier one.
```

- [ ] **Step 4: Run the full test suite**

```powershell
npm test
```

Expected: all suites pass.

- [ ] **Step 5: Work the manual verification checklist**

Record the result of each item. Do not mark this step complete until all nine pass.

1. **Dry run, Sales Engineer (15).** CSV row count is 15, matching the sidebar.
2. **Real run limited to 3.** Three files in `Downloads/wellfound-resumes/`, named `Name-userId-jobId.pdf`, each opens as a valid document.
3. **Immediate re-run.** Early stop fires within three page fetches; nothing re-downloads.
4. **Delete one file, open Library.** Reports "1 missing from disk"; **Re-download missing** fetches exactly that one.
5. **Clear extension storage** (`chrome.storage.local.clear()` in the service worker console), **open Library.** Reconciliation reports orphans rather than the extension re-fetching everything.
6. **Full run, Solutions Engineer (33).** Completes without a 403, 429, or Cloudflare challenge.
7. **Abort mid-run.** Files already downloaded remain; a CSV of the partial run is written; a re-run resumes without duplicating.
8. **Reduced motion.** The breath lane stops animating but still reports state as text.
9. **Keyboard only.** Tab reaches every control in visual order with a visible sand focus ring; the panel is usable at 320 px and 500 px width.

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "feat: add re-download missing, README and verification checklist"
```

---

## Self-review notes

Checked against the spec:

- **Recon findings** → Task 9 (Apollo client, live variables, cursor), Task 11 (resume redirect, extension from `finalUrl`).
- **Four components** → Tasks 9, 10, 13, 14–16.
- **Run flow** → Task 12 (loop), Task 13 (tab navigation per job).
- **Downloads and naming** → Tasks 2, 11.
- **Three-source dedup** → Task 7 (ledger), Task 8 (reconciliation), Task 13 (`IMPORT_CSV`), Task 16 (UI).
- **Early stop and force full walk** → Task 6, exposed in Task 14.
- **CSV** → Task 3, written in Task 13.
- **Pacing and abort** → Task 4, Task 12; abort-not-retry is inherent in `runJob` letting `fetchPage` errors propagate.
- **Interface: tokens, type, layout, motion, copy** → Tasks 1, 14, 15, 16.
- **Testing: dry run, limit-to-N, manual checklist** → Tasks 12, 14, 17.
- **Permissions** → Task 1.

One spec item is deliberately deferred rather than dropped, and it is named in the README's Limits section: appending to an earlier CSV, which is impossible because the extension cannot read files back.

One risk carried into implementation: **Task 14 Step 1 may not produce woff2 files** from the sources given. The fallback stack in `tokens.css` keeps the panel fully usable with system faces, so this cannot block the build — but it must be resolved before the extension is considered finished, and the step says to stop and ask rather than ship a broken font reference.
