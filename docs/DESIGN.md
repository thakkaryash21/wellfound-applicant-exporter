# Design notes

How this extension works and why it is built this way. The recon section records
what was actually observed against Wellfound's recruiter UI; everything after it
follows from those constraints.

## Problem

Exporting applicants from a Wellfound recruiter job listing is manual: open each
candidate, open the resume tab, save the file, retype the name. For a job with
281 applicants this is hours of clicking. Re-checking the job a week later means
redoing the work or manually tracking where you stopped.

## Goal

A Chrome extension (Manifest V3) that, for one or more selected job listings,
downloads every applicant's resume named after the candidate, writes a CSV of
the applicant list, and remembers who it has already downloaded so later runs
fetch only the new ones.

## Non-goals

- Choosing which applicant bucket to export. The collector copies the variables
  from whatever query the page currently has live, so the export follows the tab
  the recruiter is on — normally **Needs Review**. Forcing a bucket would mean
  sending a variable the UI did not, which is the one deviation from "look
  exactly like the app" this design avoids. The panel names the bucket as soon as
  the first page arrives, before anything downloads.
- Any write action against Wellfound — no accepting, rejecting, or messaging.
- Running unattended or in the background. A run requires an open, focused
  extension page.

## Recon findings

Everything in this section was observed live against
`https://wellfound.com/recruit/applicants/jobs/9100001` on 2026-08-11 using the
Claude-in-Chrome extension. It is the evidence the design rests on.

### The API

Wellfound's recruiter UI is a Next.js app under `/talent/_next/` talking to a
single endpoint, `POST https://wellfound.com/graphql`, via Apollo Client with
**persisted queries**. Requests send an operation hash, not query text:

```json
{
  "operationName": "RecruitJobListingApplicants",
  "variables": {
    "after": null,
    "filters": { "status": "NEEDS_REVIEW" },
    "first": 10,
    "jobId": "9100004",
    "orderBy": "NEWEST",
    "preferences": { "searchTerms": [], "skillIds": ["10001"], "yearsExperienceMin": 2 },
    "talentCandidateId": ""
  },
  "extensions": { "operationId": "tfe/<64-hex operation hash, redacted>" }
}
```

Response path:
`data.talent.viewer.currentStartup.recruit.jobListing.applicants` — a Relay-style
connection with `edges[].node` and `pageInfo { endCursor, hasNextPage }`. There
is **no `totalCount`**; the sidebar's "281 applicants to review" comes from a
separate `RecruitApplicantCounts` query.

### Requests are signature-gated

Replaying that exact POST body from page context without the app's headers
returns **404**. Real requests carry:

| Header | Note |
|---|---|
| `x-apollo-signature` | `<unix-ts>-<base64 hmac>`, e.g. `1786440368-QIJboOP…` |
| `x-wf-cfp` | opaque 32-hex token |
| `x-apollo-operation-name` | operation name |
| `apollographql-client-name` | `talent-web` |
| `x-angellist-dd-client-referrer-resource` | route template |

The **same** `x-apollo-signature` value appeared on three different operations
with different bodies in the same tick, so the signature is a function of
timestamp and a client secret, not of the request body. It presumably expires.

**Consequence:** the extension cannot mint its own GraphQL calls from a service
worker. It must issue requests through the page's own client. This is also the
lowest-detection option — requests are indistinguishable from the real app's
because they *are* the real app's.

### The Apollo client is reachable

`window.__APOLLO_CLIENT__` is exposed on the page. `client.getObservableQueries()`
returns ~34 live queries including `RecruitJobListingApplicants` with its
`DocumentNode` and current variables.

Verified working: taking that document, spreading its variables, overriding
`first`/`after`, and calling `client.query({ fetchPolicy: 'network-only' })`
returned page 2 (5 records, correct `endCursor`, resume URLs present). The link
chain attached valid signature headers automatically.

### Page size is capped at 20

`first: 50` → 20 records. `first: 100` → 20 records. Both with
`hasNextPage: true`. **20 is a server-side ceiling**, so a single-request
full-list export is impossible. The UI itself always sends 10.

### Resume URLs are in the list response

Every node carries
`recruitCandidate.candidate.resumeUrl` =
`https://wellfound.com/link/{userId}/{token}/resume_url`.

All 10 in the sampled page had one. This confirms the original hypothesis: there
is no need to open each candidate's profile or render the resume viewer. The URL
is a stable server-side redirect to the presigned storage object.

A `fetch()` of that URL **from page context fails** (CORS on the redirect target).

Following the link in a browser tab resolved it completely:

```
https://wellfound.com/link/{userId}/{token}/resume_url
  → 302 → https://s3.amazonaws.com/attachments.angel.co/{id}-{hash}.pdf
           ?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=…
           &X-Amz-Expires=3545&X-Amz-Security-Token=…&X-Amz-Signature=…
```

`Content-Type: application/pdf`. The presigned URL is valid for ~1 hour, which is
irrelevant here since it is minted fresh on each request. **The true file
extension is present in the final URL's path**, so the file type never has to be
guessed.

### Fields available per applicant

From the same list response, at zero extra request cost:

- `recruitCandidate.candidate`: `name`, `headline`, `currentLocation`,
  `currentRole`, `yearsExperienceInRole`, `linkedinUrl`, `githubUrl`, `website`,
  `angellistUrl`, `desiredSalary`, `usAuthorized`, `requiresSponsorship`,
  `remoteWorkPreference`, `roles`, `canonicalSkills`, `otherSkills`, `degrees`,
  `jobs`, `userId`, `resumeUrl`
- `recruitCandidate`: `id`, `masked`, `concealed`, `notes`
- `node`: `id`, `bucket`, `shortlisted`, `needsRelocation`
- `node.currentApplication`: `submittedAt`, `note`, `userAnswers`, `questions`

`masked` / `concealed` flags exist; masked candidates may lack a name or resume
and must be handled, not assumed away.

## Architecture

Four components, each with one responsibility.

### 1. `collector.js` — MAIN-world content script

Injected at `https://wellfound.com/recruit/applicants/*` with `world: "MAIN"`.
The **only** component that touches Wellfound.

Responsibilities:
- Locate `window.__APOLLO_CLIENT__` and the live `RecruitJobListingApplicants`
  observable query.
- Copy that query's own variables verbatim, overriding only `first` and `after`.
  Never construct a query shape from scratch — `filters`, `orderBy`,
  `preferences` and `talentCandidateId` come from whatever the UI currently has.
- Fetch one page on request and return a normalized
  `{ applicants: [...], endCursor, hasNextPage }`.

It holds no state, does no pacing, and knows nothing about downloads or dedup.

### 2. `bridge.js` — ISOLATED-world content script

A `window.postMessage` ↔ `chrome.runtime` relay with an explicit message
allowlist. Exists solely because MAIN world cannot reach extension APIs. No logic.

### 3. `service-worker.js` — service worker

Almost nothing: it sets the side panel to open on toolbar click, and that is all.

**It deliberately does not own the run loop.** Chrome terminates an MV3 service
worker after 30 seconds of inactivity, and neither `setTimeout` nor an open
message port resets that timer — only receiving an event or calling an extension
API does. This extension sleeps on purpose: reading breaks are drawn from
15-40 s and about a third exceed 30 s, and one fires every 8-12 candidates. A
worker-hosted loop would be killed mid-run, silently, on essentially every run.

### 3b. `panel/run-controller.js` — the orchestrator

The run loop lives in the side panel, an ordinary page document with no such
timeout. It owns pacing, the working tab, downloads, CSV assembly and the abort path,
and never talks to Wellfound's GraphQL API directly. The ledger and everything
that reconciles it against Chrome's download history sit beside it in
`panel/ledger-service.js`, which takes no lock and touches no tab. Hosting it here makes
"closing the panel aborts the run" physics rather than a feature, and removes
worker-to-panel event broadcasting entirely: the loop updates its own UI.

### 4. `panel/` — side panel UI

A `chrome.sidePanel` page, **not** a browser-action popup. A popup is destroyed
the moment focus moves, which would kill a 12-minute run mid-flight. The panel
persists and stays visible beside the applicant list as the run works through it.

Two screens, described in **Interface** below: **Run** (job selection, settings,
live progress) and **Library** (per-job state and maintenance).

## Run flow

For each selected job, sequentially:

1. Service worker navigates the working tab to
   `/recruit/applicants/jobs/{jobId}`.
2. Waits for `collector.js` to report the app's query is registered.
3. Requests one page (`after` = last cursor, `first` = configured size).
4. Diffs returned applicant IDs against the job's seen set.
5. Queues unseen resumes; downloads them one at a time, interleaved with paging.
6. Sleeps a jittered interval, then loops to step 3.
7. Stops when `hasNextPage` is false, the early-stop rule fires, or a cap/abort
   triggers.

Downloads interleave with paging rather than batching at the end, so an aborted
run still leaves completed files and a partial CSV on disk.

## Destination folder and file writing

Files are transferred with `chrome.downloads.download`, into a subfolder of the
browser's Downloads directory. The subfolder name is set in the side panel per
run and defaults to `wellfound-resumes`.

This was a deliberate trade. A `showDirectoryPicker()` flow would allow any
directory on disk, but it requires fetching bytes in extension context, which
means host permissions covering the S3 redirect target, an IndexedDB-persisted
directory handle, and re-prompting for permission each session. `chrome.downloads`
is exempt from CORS and host permissions entirely, sends session cookies, resumes
and retries on its own, and streams large files without buffering them in memory.
Reliability beat folder freedom. **Files can only land under Downloads**, and the
panel states the resolved path plainly.

Naming is handled by a `chrome.downloads.onDeterminingFilename` listener, which
receives both `downloadItem.finalUrl` (the resolved S3 URL, whose path carries the
real extension) and Chrome's own suggested filename. The listener rewrites the
name and returns `conflictAction: 'overwrite'` so a re-download replaces rather
than accumulating ` (1)` suffixes.

## File naming

`{Name}-{userId}-{jobId}.{ext}` in the chosen subfolder, flat (no per-job
subfolders). `{ext}` comes from the final S3 URL's path, falling back to the
response `Content-Type`, then to `pdf`.

Name sanitizing: strip `\ / : * ? " < > |` and control characters, collapse
whitespace, trim trailing dots and spaces (Windows rejects both), cap the base
name at 100 characters. A missing name (masked candidate) becomes `unknown`.
Because `userId` and `jobId` are in every filename, collisions cannot occur and
no dedup suffix logic is needed.

## Dedup and resume-where-I-left-off

Three sources, in order of authority. The ledger is fast, the download history is
true, the CSV is portable.

### 1. Ledger (`chrome.storage.local`)

Per-job record in `chrome.storage.local`:

```
job:{jobId} = {
  jobTitle, seenIds: string[], lastRunAt, lastRunCount, totalDownloaded
}
```

The list is sorted NEWEST-first, so new applicants appear at the *top* and a
saved cursor goes stale immediately. Cursors are therefore never persisted
across runs. Each run walks from the top, skipping IDs already in `seenIds`.

**Early stop:** halt after 3 consecutive pages that are entirely already-seen.
This gives full-walk correctness under reordering for the cost of ~3 requests
when nothing has changed. A **Force full walk** checkbox disables it for the
case where applicants were inserted mid-list.

Downloading 100 and returning at 300 reads roughly 20 pages and fetches 200 files.

An ID is added to `seenIds` only after its file is written. A failed download is
retried on the next run.

`seenIds` is capped at 5000 entries per job with oldest-first eviction, a
practical bound on `chrome.storage.local`'s 10 MB quota.

### 2. Reconciliation against Chrome's download history

The ledger records what the extension *believes* it downloaded. Chrome's download
history records what actually landed on disk. Before each run, and on opening the
Library screen, the two are reconciled.

`chrome.downloads.search({ filenameRegex: '-\\d+-{jobId}\\.' })` returns every
file this extension wrote for that job. Filenames embed `userId` and `jobId`
precisely so this lookup is exact. Each `DownloadItem` carries `state` and
`exists`, so three drifts become visible:

| Drift | Meaning | Action |
|---|---|---|
| In ledger, `exists: false` | file deleted or moved off disk | offer to re-download |
| In ledger, no download record | history cleared, or never really wrote | trust the ledger, flag as unverifiable |
| Download record, not in ledger | extension storage was cleared | adopt into the ledger |

This turns "the extension thinks it has this" into "the file is on your disk",
which is the claim you actually care about. No extra permission is needed —
`downloads` already covers `search()`.

Reconciliation never deletes ledger entries on its own. It reports, and the
Library screen offers the actions.

### 3. CSV import

The Library screen accepts a previously exported CSV, reads its User ID column,
and adopts those IDs into the job's ledger. This covers the cases the first two
sources cannot: a new machine, a fresh Chrome profile, or hand-correcting the
ledger in a spreadsheet.

Deliberately rejected: a `submittedAt` **watermark** that stops paging at the
last-seen timestamp. It is by far the cheapest option and reduces a re-run to two
or three requests, but any applicant surfacing out of strict submit order — a
bucket move, a reactivation, a back-dated record — is skipped permanently and
silently. Losing candidates without saying so is the one failure this tool must
not have.

## CSV

Written to the same subfolder as `applicants-{jobId}-{YYYY-MM-DD}.csv`.

The CSV is assembled in the side panel (a page context, so `Blob` and
`URL.createObjectURL` are available — MV3 service workers have neither) and
handed to `chrome.downloads.download`. It is written once at the end of each
job's run, plus on abort, so an interrupted run still yields a CSV of whatever
completed.

Columns: Name, User ID, Job ID, Job Title, Location, Years Experience, LinkedIn,
GitHub, Website, Wellfound URL, US Authorized, Resume Link, Resume Filename.

User ID, Job ID and Resume Filename are included beyond the requested set because
filenames are `Name-userId-jobId`; without them a row cannot be mapped back to
its file.

RFC 4180 quoting: fields containing comma, quote or newline are wrapped in double
quotes with internal quotes doubled. A UTF-8 BOM is prepended so Excel on Windows
renders non-ASCII names correctly.

The extension cannot read files back from Downloads, so it cannot append to
yesterday's CSV. Each run writes its own dated file containing **that run's**
rows. Merging across runs is a spreadsheet operation, and the panel says so.

## Interface

### Direction

The panel is ~400 px wide, sits beside the applicant list, and has one job: start
a run and let you trust it for the twelve minutes it takes. The tool is
deliberately slow — jitter, reading breaks, one request at a time. Most software
hides waiting behind a spinner. Here the pacing *is* the product, and concealing
it would misrepresent what the extension is doing on the account's behalf. The
design makes the waiting legible and calm instead.

**Signature — the breath lane.** A hairline running the width of the run view.
Each candidate lands as a tick. The gap between ticks fills at true scale, so the
live jitter interval is visible as it elapses. On a reading break the lane dims
and holds. At a glance you can tell whether the run is working, resting, or stuck,
without reading a word — and what it draws is the pacing that keeps the account
safe, not decoration. This is the only ambient motion in the panel.

### Tokens

Dark only. Atmospheric blue-slate rather than terminal black.

| Token | Hex | Use |
|---|---|---|
| `ground` | `#0E1219` | panel floor |
| `surface` | `#161B24` | cards, raised rows |
| `surface-hi` | `#1D2430` | hover, selected |
| `hairline` | `#232A36` | dividers, lane at rest |
| `paper` | `#EDE7DC` | primary text — warm, never pure white |
| `muted` | `#8A93A3` | secondary text, labels |
| `sand` | `#D9B382` | accent: selection, primary action, in progress |
| `sage` | `#9BB89A` | complete |
| `rust` | `#C77B62` | failed, aborted |

`sand` carries every active meaning — selected job, primary button, running state
— so activity reads as one colour throughout. `sage` and `rust` are reserved for
terminal states and appear only at the end of a run.

Contrast on `ground`: `paper` 14.8:1, `muted` 6.1:1, `sand` 10.2:1. Ink text
(`#0E1219`) on a `sand` fill is 10.2:1. All clear AA for body text.

### Type

Bundled as woff2 in the extension. A page under extension CSP cannot fetch Google
Fonts at runtime, so nothing is loaded from the network.

- **Instrument Sans** — UI and headings, tight tracking at display sizes.
- **JetBrains Mono** — every number: counts, timers, IDs. Tabular figures, so a
  climbing count never shifts the layout.

Scale: 11 / 12 / 13 / 15 / 22 / 32. Body 13 px at 1.5 line-height. Labels 11 px
uppercase with wide tracking, in `muted`.

### Layout

One column, no top tabs. A 400 px column fragmented by tabs reads as a dashboard;
this is a single task. Library pushes in as a second view with a back affordance.

```
┌──────────────────────────────┐
│ Wellfound            Library │
├──────────────────────────────┤
│ ▌Platform Engineer         │  ← sand left rule + surface-hi = selected
│  281 · 100 new               │
│                              │
│  Backend Engineer         │
│  114 · all downloaded        │
│                              │
│  Data Scientist               │
│  155 · 155 new               │
├──────────────────────────────┤
│ FOLDER    wellfound-resumes  │
│ PACE      ●───────  natural  │
│ STOP AT   250                │
├──────────────────────────────┤
│      Download 255 new        │  ← sand fill, ink text
└──────────────────────────────┘

running ───────────────────────
│ ││ │   ││ │ ▏                │  ← breath lane, live
│                              │
│ 47 / 255                     │  ← mono, tabular
│ Jane Doe                     │
│ resting · 22s                │
```

The **Library** screen lists each known job with: total applicants seen,
downloaded, new since last run, files missing from disk, and last run date.
Actions per job: **Download new**, **Re-download missing**, **Import CSV**,
**Export ledger**, **Forget this job** (confirmed, and visually separated from
the rest).

### Motion

`cubic-bezier(0.23, 1, 0.32, 1)` at 150–220 ms for everything interactive. List
entries stagger 40 ms on first paint. Pressable elements take `transform:
scale(0.97)` on `:active`. Only `transform` and `opacity` animate.

Under `prefers-reduced-motion` the breath lane stops moving and reports the same
state as text ("resting · 22s"). Reduced, not removed — the information survives.

### Copy

Plain and specific. Buttons name what happens: **Download 255 new**, not "Start".
An action keeps its name through the flow — **Download new** produces "Downloaded
255". Errors state cause and recovery: "Wellfound rate-limited the request. The
run stopped at 47 of 255 and nothing was lost — try again in a few minutes."
Empty state is an invitation: "No jobs yet. Open a job's applicant list to add
it."

## Rate limiting and detection avoidance

- **Strictly serial.** Never more than one in-flight request, ever.
- **Jittered sleeps** drawn from a log-normal distribution, not a fixed value:
  2.5–7 s between page queries, 1.5–4 s between resume downloads.
- **Reading breaks:** a 15–40 s pause every 8–12 candidates.
- **Default page size 10**, matching what the UI actually sends. The 20 ceiling
  is exposed as an opt-in "faster" toggle, with the panel stating that 20 is a
  value the real UI never sends.
- **Abort, do not retry**, on any GraphQL error, 403, 429, or Cloudflare
  challenge response. The panel reports what happened and the run is resumable.
- **Abort if the user navigates the working tab away** or closes the panel.
- **Per-run item cap**, user-settable, defaulting to 250.

At default pacing a 281-applicant job takes roughly 12 minutes. That is the point.

## Error handling

| Failure | Behavior |
|---|---|
| Apollo client not found | Panel says the page is not loaded or the app changed; run refuses to start. |
| `RecruitJobListingApplicants` query not registered | Wait up to 15 s, then fail with that message. |
| Candidate has no `resumeUrl` | Skip the file, still emit the CSV row, count as seen, report in the summary. |
| Download interrupted or fails | `chrome.downloads` reports `state: 'interrupted'`; do **not** mark seen, log for the next run. |
| User cancels a download in Chrome's UI | Treated as a failure, same handling. |
| GraphQL error / rate limit | Abort the whole run, preserve state. |
| Extension reloaded mid-run | State is already persisted per page; restarting resumes from the seen set. |

## Testing

Pure functions get real unit tests under `vitest`: CSV field escaping, filename
sanitizing (including Windows reserved characters and trailing dots), the jitter
sampler's bounds, the dedup diff, and the early-stop rule.

The Apollo and download layers are verified by hand against the live account
— there is no honest way to fake a signature-gated API. Two safety valves make
manual verification cheap:

- **Dry run**: walks pages and produces the CSV, downloads nothing.
- **Limit to N**: stop after N candidates.

Manual verification checklist:

1. Dry run on Sales Engineer (15 applicants) — CSV row count matches the sidebar.
2. Real run limited to 3 — files land in `Downloads/<subfolder>/`, named
   `Name-userId-jobId.pdf`, and open as valid documents.
3. Immediate re-run — early stop fires, nothing re-downloads.
4. Delete one downloaded file, open Library — it reports one file missing and
   re-downloads only that one.
5. Clear extension storage, open Library — reconciliation adopts the existing
   downloads instead of re-fetching everything.
6. Full run on Solutions Engineer (33) — complete, no rate limiting.
7. Panel at 320 px and 500 px width; `prefers-reduced-motion` enabled; keyboard-
   only traversal with visible focus.

## Permissions

```
"permissions":      ["storage", "downloads", "sidePanel", "tabs"]
"host_permissions": ["https://wellfound.com/*"]
```

No `<all_urls>`. No permission for the S3 host is needed — `chrome.downloads`
does not perform an extension-origin fetch, so the redirect is never subject to
host-permission checks.

A `downloads` listener that renames files (`onDeterminingFilename`) requires only
the `downloads` permission; `downloads.shellIntegration` is **not** needed and is
deliberately not requested.

## Risks

- **Wellfound changes the query shape or operation hash.** Reading variables from
  the live query instead of hardcoding them absorbs variable changes; a renamed
  operation breaks the extension and surfaces as a clear error, not silent
  corruption. Accepted.
- **The signature scheme tightens** (e.g. body-bound signatures). Would not break
  this design, since requests go through the app's own client.
- **Terms of service.** This automates actions the account is already entitled to
  perform, on the account holder's own job listings, at human pace. Still, it is
  automation, and the pacing defaults exist to keep it defensible.
- **`window.__APOLLO_CLIENT__` is removed** in a future build. Fallback would be
  intercepting responses while driving the UI's own infinite scroll — slower, and
  not designed here.
