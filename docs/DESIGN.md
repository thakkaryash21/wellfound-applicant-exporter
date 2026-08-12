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

Everything above this line is recon: what was observed against Wellfound. What
follows describes the extension as it is built, and is written against the code
rather than against the plan.

Five parts. Two of them run on Wellfound's page and two of them run in the
panel; `src/lib/` is pure and runs wherever it is imported.

### 1. `collector.js` — MAIN-world content script

Injected at `https://wellfound.com/recruit/*` with `world: "MAIN"` at
`document_idle`. The **only** component that touches Wellfound.

Responsibilities:
- Locate `window.__APOLLO_CLIENT__` and the live `RecruitJobListingApplicants`
  observable query.
- Copy that query's own variables verbatim, overriding only `jobId`, `first` and
  `after`. Never construct a query shape from scratch — `filters`, `orderBy` and
  everything else come from whatever the UI currently has live. `first` is the
  wire's name for the page size; inside this extension the same number is called
  `pageSize`, and `mergeVariables` is the one place that translates.
- Unwrap one GraphQL response into `{ jobTitle, edges, endCursor, hasNextPage }`.
  The connection arrives as `edges: [{ __typename, node }]` with `pageInfo`
  nested under `applicants`; the unwrap happens here and nowhere else.
- Answer `QUERY_READY` with **which** job the live query is serving, never a
  bare boolean. A document the browser is about to discard can truthfully answer
  "yes" and take a run down with it.
- Read the job list out of the Apollo cache (`cache.extract()`), filtered to
  `__typename === 'JobListing'`.

It holds no state, does no pacing, and knows nothing about downloads or dedup.
It is a classic script with no imports and no exports — MV3 will not run a module
in the MAIN world — so the message-type literals are duplicated inline from
`src/lib/messages.js` rather than imported, and the only test seam is a
`__WFX_COLLECTOR__` container that nothing in the extension ever defines.

### 2. `bridge.js` — ISOLATED-world content script

Injected at the same match pattern. A `window.postMessage` / `chrome.runtime`
relay with an explicit allowlist of three message types — `LIST_JOBS`,
`FETCH_PAGE`, `QUERY_READY` — and a 30 s timeout per pending request. Exists
solely because MAIN world cannot reach extension APIs. No logic, no state beyond
the pending map.

### 3. `service-worker.js` — service worker

Three lines. On install it sets the side panel to open when the toolbar icon is
clicked. That is the whole file.

**It deliberately does not own the run loop, and never has.** Chrome terminates
an MV3 service worker after 30 seconds of inactivity, and neither `setTimeout`
nor an open message port resets that timer — only receiving an event or calling
an extension API does. This extension sleeps on purpose: reading breaks are drawn
from 15–40 s and about a third exceed 30 s, and one fires every 8–12 candidates.
A worker-hosted loop would be killed mid-run, silently, on essentially every run.

### 4. `panel/` — the side panel, and the run

A `chrome.sidePanel` page, **not** a browser-action popup. A popup is destroyed
the moment focus moves, which would kill a 12-minute run mid-flight. The panel
persists and stays visible beside the applicant list as the run works through it.

The run loop lives here, in `panel/run-controller.js`: an ordinary page document
has no idle timeout. It owns the run lock, pacing, the working tab, downloads,
CSV assembly and the abort path, and never talks to Wellfound's GraphQL API
directly — every request goes out through `tab-driver.js` to the bridge. Hosting
it here makes "closing the panel ends the run" physics rather than a feature, and
removes worker-to-panel event broadcasting entirely: the loop updates its own UI.

Three modules sit beside it, each with a boundary worth naming:

- `tab-driver.js` — find or open a recruiter tab, navigate it to a job's
  applicant list, poll `QUERY_READY` until the page can answer (500 ms poll,
  1500 ms settle after a navigation, 15 s timeout), and relay messages. It
  touches the tab; nothing else does.
- `ledger-service.js` — everything the extension knows about who has been
  fetched and whether their file is still on disk. It owns the ledger outright,
  takes no lock, drives no tab and paces nothing, so the Library screen can call
  all of it while no run is in flight.
- `downloader.js` — the `onDeterminingFilename` listener and the download
  promise. Registration is idempotent, because two listeners over one pending
  map would hand filenames back to Chrome.

The view modules (`home-view.js`, `running-view.js`, `post-run-view.js`,
`library.js`, `summary.js`, `trace-view.js`) are markup and plain-data models, so
every string and every judgement they make can be asserted without a DOM.

### 5. `src/lib/` — the pure core

`normalize.js`, `csv.js`, `filename.js`, `reconcile.js`, `dedup.js`, `jitter.js`,
`trace.js`, `local-time.js`, `messages.js` and the run loop itself (`runner.js`)
are pure: no `chrome`, no `document`, no network. `ledger.js` is the single
exception, and takes its storage as an argument rather than reaching for
`chrome.storage` — which is what lets the whole dedup story be tested against a
plain object.

## Run flow

For each selected job, sequentially, driven from the panel:

1. `tab-driver` finds a recruiter tab (or opens one) and navigates it to
   `/recruit/applicants/jobs/{jobId}`.
2. It polls `QUERY_READY` until the page answers with **that** jobId, or gives
   up after 15 s.
3. `ledger-service` reconciles the ledger against Chrome's download history, and
   subtracts from the seen set anyone whose file has since gone missing, so the
   run quietly fetches them again.
4. `runner.js` requests one page (`after` = last cursor, `pageSize` = 10, or 20
   under the "faster" toggle).
5. It diffs the page's userIds against the seen set, and marks every record's
   Resume status before the download loop touches it, so a truncated run says
   which rows it never reached.
6. It downloads fresh resumes one at a time, recording each in the ledger
   *before* anything else can interrupt, and sleeping a jittered interval between
   each.
7. It stops when `hasNextPage` is false, the per-role `limit` is reached, the
   early-stop rule fires, five downloads fail in a row, or the run is aborted.
8. The CSV for that job is written, the ledger's run is closed out with the
   folder it wrote to, and the loop moves to the next job.

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
than accumulating ` (1)` suffixes. Pending downloads are keyed by URL rather than
by download id, because the listener can fire before `download()` resolves with
an id.

## File naming

`{Name}-{userId}-{jobId}.{ext}` in the chosen subfolder, flat (no per-job
subfolders). `{ext}` comes from the final S3 URL's path, falling back to the
response `Content-Type`, then to `pdf`.

Name sanitizing: strip `\ / : * ? " < > |` and control characters, collapse
whitespace, cap the base name at 100 characters, then trim trailing dots and
spaces (Windows rejects both, and truncating can expose a new one). A missing
name (masked candidate) becomes `unknown`. Because `userId` and `jobId` are in
every filename, collisions cannot occur and no dedup suffix logic is needed.

`src/lib/filename.js` owns this grammar outright: it both builds the name and
parses it back, and `reconcile.js` asks it rather than matching a regex of its
own. A separator changed in one place and not the other would have left every
file reported missing with no test failing.

## Dedup and resume-where-I-left-off

Three sources, in order of authority. The ledger is fast, the download history is
true, the CSV is portable. All three agree on one identifier: **`userId`**. It is
the only one that survives a CSV round-trip, a filename and a move to another
machine. Wellfound sends it as a string; `normalize.js` coerces it with `String()`
anyway, which is what keeps the dedup Set and the filename parser talking about
the same people whichever type the schema returns next.

### 1. Ledger (`chrome.storage.local`)

Per-job record:

```
job:{jobId} = {
  jobId, jobTitle, seenUserIds: string[], lastRunAt, totalDownloaded, folder
}
```

`seenUserIds` is the seen set, and that is its name everywhere: the stored field,
the reader inside `ledger.js`, and the accessor callers use. The one place the
codebase says something else is `known` on a described record — deliberately
broader, because it counts everyone the ledger will not re-fetch including people
it learned about from a CSV import or an orphan adoption, while `totalDownloaded`
counts only files this extension actually fetched. After importing 400 people,
`downloaded` is still 0 and only `known` shows the import did anything.

`folder` is remembered so a later re-download lands beside the originals rather
than in whatever default the Library would have guessed.

The applicant list is sorted NEWEST-first, so new applicants appear at the *top*
and a saved cursor goes stale immediately. Cursors are therefore never persisted
across runs. Each run walks from the top, skipping userIds already seen.

**Early stop:** halt after 3 consecutive pages that are entirely already-seen.
This gives full-walk correctness under reordering for the cost of ~3 requests
when nothing has changed. A per-role **Re-read pages I have already downloaded**
checkbox disables it for the case where applicants were inserted mid-list.

"Entirely already-seen" is judged only over records that *have* a userId. Wellfound
conceals candidates until the recruiter unlocks them, so a queue can genuinely
open with a full page of masked applicants; reading that as "fully seen" would
have stopped a run before it reached anybody real.

A userId is added to `seenUserIds` only after its file is written. A failed
download is retried on the next run.

`seenUserIds` is capped at 5000 entries per job with oldest-first eviction, a
practical bound on `chrome.storage.local`'s 10 MB quota.

### 2. Reconciliation against Chrome's download history

The ledger records what the extension *believes* it downloaded. Chrome's download
history records what actually landed on disk. Before each run, and on opening the
Library screen, the two are reconciled.

`chrome.downloads.search({ filenameRegex })` — the regex built by `filename.js`
for that job — returns every file this extension wrote for it. Filenames embed
`userId` and `jobId` precisely so this lookup is exact. Each `DownloadItem`
carries `state` and `exists`, so three drifts become visible:

| Drift | Meaning | Action |
|---|---|---|
| In ledger, `exists: false` or interrupted | file deleted, moved, or never finished | offer to re-download |
| In ledger, no download record | history cleared, or never really wrote | trust the ledger, flag as unverifiable |
| Download record, not in ledger | extension storage was cleared | adopt into the ledger |

The judgement is made per person, not per download record: Chrome keeps a
separate entry for every attempt, so one candidate can have both a completed
download and an interrupted retry, and any completed attempt counts. A download
still in flight is neither present nor missing and is left for the next pass.

This turns "the extension thinks it has this" into "the file is on your disk",
which is the claim you actually care about. No extra permission is needed —
`downloads` already covers `search()`.

Reconciliation never deletes ledger entries on its own. It reports, and the
Library screen offers the actions.

### 3. CSV import

The Library screen accepts a previously exported CSV, reads its User ID column,
and adopts those userIds into the job's ledger. This covers the cases the first
two sources cannot: a new machine, a fresh Chrome profile, or hand-correcting the
ledger in a spreadsheet.

**Only rows whose Resume cell says the file actually landed** are adopted —
`downloaded` and `already downloaded`, nothing else. A CSV from a run that hit
its limit carries hundreds of "not fetched: the run stopped first" rows, and
adopting those would mark people seen who were never fetched, permanently, since
nothing revisits the ledger afterwards. Older CSVs written before the Resume
column existed fall back to a non-empty Resume Filename cell; a CSV with neither
column adopts nobody rather than everybody.

Deliberately rejected: a `submittedAt` **watermark** that stops paging at the
last-seen timestamp. It is by far the cheapest option and reduces a re-run to two
or three requests, but any applicant surfacing out of strict submit order — a
bucket move, a reactivation, a back-dated record — is skipped permanently and
silently. Losing candidates without saying so is the one failure this tool must
not have.

## CSV

Written to the same subfolder as `applicants-{jobId}-{YYYY-MM-DD}.csv`, dated on
the user's own clock rather than UTC's.

The CSV is assembled in the side panel (a page context, so `Blob` and
`URL.createObjectURL` are available — MV3 service workers have neither) and
handed to `chrome.downloads.download`. It is written once at the end of each
job's run, plus on abort, so an interrupted run still yields a CSV of whatever
completed.

Fifteen columns, in order:

Name, User ID, Job ID, Job Title, Location, Years Experience, LinkedIn, GitHub,
Website, Wellfound URL, US Authorized, Applied At, Resume Link, Resume Filename,
Resume.

- **User ID, Job ID and Resume Filename** are there because filenames are
  `Name-userId-jobId`; without them a row cannot be mapped back to its file.
- **Resume** is the status of that row — `downloaded`, `already downloaded`,
  `no resume on file`, `not identifiable`, `locked on Wellfound`, `preview`,
  `not fetched: the run stopped first`, or `failed: {reason}`. It exists because
  without it "fetched on an earlier run" and "never fetched" are the same empty
  Resume Filename cell, and it is the column the import-safety rule above reads.
- **Applied At** is rendered `YYYY-MM-DD`. Wellfound sends Unix seconds, which
  are meaningless in a spreadsheet, and a locale string is neither sortable nor
  unambiguous.
- `headline` is deliberately absent: Wellfound returned null for it on every
  applicant sampled, and a column empty in every row is noise.

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

### Screens

Four, not two. One column, no top tabs: a 400 px column fragmented by tabs reads
as a dashboard, and this is a single task.

- **Home** — the roles, their per-role settings, the destination folder, an
  Advanced disclosure, and the start button.
- **Running** — the breath lane, the progress bar, the running breakdown and a
  stop button.
- **Post-run** — the account the run gives of itself, with the trace available
  to download. It is a separate screen because Home answers "what do you want to
  do now" and a summary answers "what happened last time", and one screen cannot
  honestly do both.
- **Library** — per-job state and maintenance. It pushes in as a second view
  with a back affordance rather than as a tab.

### Layout

```
┌──────────────────────────────┐
│ Wellfound            Library │
├──────────────────────────────┤
│ ☑ Platform Engineer        ⌄ │  ← sand left rule + surface-hi = selected
│   281 applicants · 100 new   │
│   ┌ GET ────────────────────┐│
│   │ ◉ all 100 new           ││
│   │ ○ first [ 25 ]          ││
│   │ ☐ Re-read pages I have  ││
│   │   already downloaded    ││
│   └─────────────────────────┘│
│                              │
│ ☐ Backend Engineer         ⌄ │
│   114 applicants · all       │
│   downloaded                 │
├──────────────────────────────┤
│ SAVE TO   wellfound-resumes  │
│ ▸ Advanced                   │
├──────────────────────────────┤
│     Download 100 resumes     │  ← sand fill, ink text
└──────────────────────────────┘

running ───────────────────────
│ ││ │   ││ │ ▏                │  ← breath lane, live
│                              │
│ 47 of ~255 applicants        │  ← mono, tabular
│ ███████░░░░░░░░░░░░░░░░░░░░░ │
│ Platform Engineer · job 1of 2│
│ 44 downloaded · 3 skipped    │
│ resting 22s · pacing so this │
│ looks like a person          │
└──────────────────────────────┘
```

**Advanced** holds exactly three things: **Preview only** (write the CSV,
download nothing), **Fetch 20 at a time instead of 10**, and a verbose console
toggle. There is no per-run item cap and no pace control; the number of people to
take is a per-role choice on the row itself.

The **Library** screen lists each known job with: downloaded, known, last run
date, and the three reconciliation drifts. Actions per job, and only these:
**Re-download missing**, **Adopt N found files** (shown only when reconciliation
found orphans), **Import CSV**, and **Forget this job** (confirmed, and visually
separated from the rest). There is no ledger export — the CSV *is* the portable
form, and the import path reads it back.

### Motion

`cubic-bezier(0.23, 1, 0.32, 1)` at 150–220 ms for everything interactive. List
entries stagger 40 ms on first paint. Pressable elements take `transform:
scale(0.97)` on `:active`. Only `transform` and `opacity` animate.

Under `prefers-reduced-motion` the breath lane stops moving and reports the same
state as text ("resting 22s · pacing so this looks like a person"). Reduced, not
removed — the information survives.

### Copy

Plain and specific. Buttons name what happens: **Download 100 resumes**, not
"Start"; where the count cannot be known, no number is shown at all rather than a
guess. A run that has fetched everyone offers **Check for new applicants**.

One word per concept, all the way to the CSV. The mode that writes the CSV and
downloads nothing is **preview** everywhere a reader can see it — the checkbox,
the running breakdown, the summary and the Resume column — while the code calls
the flag `dryRun`. The seen set is `seenUserIds`. The GraphQL page size is
`pageSize` and the number of candidates to take from a role is `limit`; they used
to share the name `first`, which is why the constant that means "25 candidates"
was once called `DEFAULT_FIRST`.

Errors state cause and recovery rather than naming a mechanism: "Open your hiring
pages on Wellfound (wellfound.com/recruit) to see your jobs", not "no matching
tab". The pause is the moment a user decides the panel has hung, so it is the one
line that explains itself rather than naming itself.

## Rate limiting and detection avoidance

- **Strictly serial.** Never more than one in-flight request, ever.
- **Jittered sleeps** drawn from a log-normal distribution, not a fixed value:
  2.5–7 s between page queries, 1.5–4 s between resume downloads. Overshooting
  draws are resampled rather than clamped — clamping piles ~12% of draws onto the
  exact upper bound, and a spike at one value is the most fingerprintable shape
  there is.
- **Reading breaks:** a 15–40 s pause every 8–12 candidates.
- **Default page size 10**, matching what the UI actually sends. The 20 ceiling
  is exposed as an opt-in "faster" toggle, with the panel stating that 20 is a
  value the real UI never sends.
- **Stop a role after 5 consecutive download failures.** If Wellfound starts
  refusing signed URLs, continuing means issuing hundreds of failing requests at
  human pacing — the most suspicious pattern this extension could produce — and
  then reporting success. A GraphQL error on a page request ends the run outright.
- **Per-role limit, not a per-run cap.** Each selected role is either "all new"
  (the default, and unbounded) or "first N", where N defaults to 25 once the user
  picks it. There is no global cap, and no run-wide default of 250: an earlier
  draft of this document described one that was never built.

At default pacing a 281-applicant job takes roughly 12 minutes. That is the point.

**Not built:** aborting when the user navigates the working tab away. There is no
`tabs.onUpdated`, `tabs.onRemoved` or `visibilitychange` listener anywhere in the
source. A run does stop when the tab leaves the applicant list, but only because
the next message to the content script fails and the run reports that failure —
which is a consequence, not a designed abort. Closing the panel does end the run,
because the loop lives in the panel document.

## Error handling

| Failure | Behavior |
|---|---|
| No Wellfound tab open | Panel says "Open Wellfound to get started"; the run refuses to start. |
| A Wellfound tab, but not in the recruiter area | Panel names the recruiter URL; the run refuses to start. |
| Apollo client not found | The content script throws "Wellfound app not loaded on this page"; the panel reports it. |
| `RecruitJobListingApplicants` query not registered | Poll every 500 ms for up to 15 s, then fail with that message. |
| The live query is serving a different job | Treated as not ready, and polled again. A bare "ready" would let the run fetch against a document seconds from being discarded. |
| Candidate has no `userId` | Refuse the download — the file could never be reconciled or repaired — still emit the CSV row, mark it `not identifiable`, and report it. |
| Candidate is masked | Same, but marked `locked on Wellfound`, because the recruiter can unlock them and run again. |
| Candidate has no `resumeUrl` | Skip the file, emit the CSV row marked `no resume on file`, count as seen, report in the summary. |
| Download interrupted or fails | Record `failed: {reason}` in the CSV row, do **not** mark seen, count towards the consecutive-failure limit. |
| 5 downloads fail in a row | Stop that role, keep its CSV, and continue to the next role. Deliberately not a fatal run error. |
| GraphQL error / rate limit | End the run, preserve everything already written. |
| A render throws mid-run | Logged to the console and swallowed. A broken UI must never abort a run that is fetching files correctly. |
| Panel closed or extension reloaded mid-run | The run ends with it. A marker in `chrome.storage.local` lets the next panel open say the last run was interrupted; the ledger already holds everyone fetched before the interruption, so the next run resumes from there. |

## Working out what Wellfound actually sends

Every field shape in the recon section above was observed against a live account,
not inferred from this code. That distinction is load-bearing, because getting it
wrong is the most expensive mistake available here and it has already happened
three times during this project.

**The failure mode.** A probe that fetches and formats in the same step hides its
own gaps, and the gap then looks exactly like a property of the server:

- A probe printed `resumeUrl` through `new URL(value, location.origin)`, which
  silently resolved a relative path. The absolute form went into this document
  and into every fixture. `chrome.downloads` requires an absolute URL, so real
  downloads would have failed on every candidate, with the whole suite green.
- `submittedAt` and `currentLocation` were assumed rather than inspected.
  Fixtures used an ISO string and a bare string; the wire sends Unix seconds and
  an object. Every end-to-end test drove branches production never takes.
- A structural capture printed `recruitCandidate: object` because the inspection
  stopped at depth 2. The fixture built from it omitted the `candidate` level
  that holds every field, so feeding it through `normalizeNode` returned null for
  everything — and the tests asserting that fixture passed.

**If you need to re-establish a shape**, capture the raw value first and inspect
it as a separate step. Print `typeof`, the key list, or `JSON.stringify` of the
raw object; never a value that has been through a formatter on the way out. State
how deep the inspection went and treat anything below that as unknown rather than
as absent.

**Then pin it.** `tests/captured-shape-e2e.test.js` runs a captured response
through the real pipeline — unwrap, normalize, CSV — and asserts a real user ID
and name reach the output. Break the nesting in `tests/helpers/captured-shape.js`
and it fails with `expected [ null, null ]`, which is the exact production
symptom. That test exists because a fixture cannot be trusted to stay honest on
its own.

The general rule, which outlives this API: **a test built on the same assumption
as the code cannot detect that assumption being wrong.** When verification sits
downstream of a belief, it launders the belief into evidence.

## Testing

`npm test` runs the whole suite under `vitest`; it is 480 tests and green.

Everything pure gets real unit tests: CSV field escaping and the import-safety
filter, filename sanitizing and its round trip through the parser, the jitter
sampler's bounds and distribution, the dedup diff, the early-stop rule, the
ledger's arithmetic against a plain-object storage, reconciliation, and the trace
scrubber. The panel's views are tested through a fake DOM, and the run controller
through a fake `chrome` and a fake page.

`collector.js` is tested by evaluating the file's own text with the
`__WFX_COLLECTOR__` container pre-defined — not a copy of it, and not a rewrite —
because MV3 will not run a module in the MAIN world and `export` is not available
there.

**The fixture rule.** `tests/helpers/captured-shape.js` is the one fixture built
from a live capture, and it must be carried across every seam by at least one
test. It once flattened `recruitCandidate.candidate` away — the level
`normalize.js` actually reads — and 480 tests stayed green, because every test
met it at one seam and stopped. `tests/captured-shape-e2e.test.js` now walks it
from `capturedResponse()` through `unwrapPage`, `normalizeNode` and `toCsv`, and
asserts a real userId and a real name in the CSV a recruiter opens. A fixture that
claims to be the live shape and is never fed to the code that reads it proves
nothing.

The Apollo and download layers are also verified by hand against a live account —
there is no honest way to fake a signature-gated API. Two safety valves make
manual verification cheap: **Preview only** walks pages and produces the CSV while
downloading nothing, and a per-role **first N** stops after N candidates.

Manual verification checklist:

1. Preview a small role — CSV row count matches the sidebar.
2. Real run limited to 3 — files land in `Downloads/<subfolder>/`, named
   `Name-userId-jobId.pdf`, and open as valid documents.
3. Immediate re-run — early stop fires, nothing re-downloads.
4. Delete one downloaded file, open Library — it reports one file missing and
   re-downloads only that one.
5. Clear extension storage, open Library — it offers to adopt the existing
   downloads instead of re-fetching everything.
6. A full run on a role of ~30 — completes, no rate limiting.
7. Panel at 320 px and 500 px width; `prefers-reduced-motion` enabled; keyboard-
   only traversal with visible focus.

## Permissions

```
"permissions":      ["storage", "downloads", "sidePanel"]
"host_permissions": ["https://wellfound.com/*"]
```

Three API permissions and one host. **`tabs` is not requested.** The host
permission on `https://wellfound.com/*` is what lets `chrome.tabs.query` match
and read the Wellfound tab this extension works with; without `tabs`, the title
and URL of every other tab stay invisible to it. README.md states the same thing,
and the two must not drift apart again.

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
- **Wellfound changes the response nesting.** This is the failure that has
  actually happened once, in a fixture. `normalizeNode` reading a level that has
  moved returns null for every field, and the run then downloads nothing, marks
  everyone "not identifiable", writes a CSV of empty rows and reports success.
  The end-to-end fixture test exists to make that loud.
- **The signature scheme tightens** (e.g. body-bound signatures). Would not break
  this design, since requests go through the app's own client.
- **Terms of service.** This automates actions the account is already entitled to
  perform, on the account holder's own job listings, at human pace. Still, it is
  automation, and the pacing defaults exist to keep it defensible.
- **`window.__APOLLO_CLIENT__` is removed** in a future build. Fallback would be
  intercepting responses while driving the UI's own infinite scroll — slower, and
  not designed here.
