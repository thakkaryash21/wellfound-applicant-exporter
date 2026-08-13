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

It also, opt-in per run, **accepts** the applicants it has captured. On
Wellfound accepting is not a status toggle: it sends the candidate a message
under the operator's name and it cannot be undone. That one fact reshapes more
of this design than anything else in it, and the section on accepting explains
what follows from it.

## Non-goals

- Choosing which applicant bucket to export. The collector copies the variables
  from whatever query the page currently has live, so the export follows the tab
  the recruiter is on — normally **Needs Review**. Forcing a bucket would mean
  sending a variable the UI did not, which is the one deviation from "look
  exactly like the app" this design avoids. The panel names the bucket as soon as
  the first page arrives, before anything downloads.
- **Rejecting, and messaging anybody the run is not accepting.** This line used
  to read "any write action against Wellfound — no accepting, rejecting, or
  messaging", and accepting has since become a goal. The rest of it is still
  true and is worth stating rather than deleting, because the two writes sit one
  keystroke apart: the reviewer binds `A` to Accept and `R` and `X` to Reject,
  adjacent in the DOM and both enabled. The driver never sends a key at all and
  refuses to click any control whose text matches `/reject/i`. There is no
  free-text messaging either — one wording, supplied by the operator, shown in
  full before a run starts, sent to the accepted and to nobody else.
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
    "jobId": "9100001",
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

Six parts. Three of them run on Wellfound's page, one is a three-line service
worker, one is the panel that owns the run; `src/lib/` is pure and runs wherever
it is imported.

The two page-side scripts that touch Wellfound do different kinds of work and
are deliberately not one file. `collector.js` reads through the app's own
GraphQL client and changes nothing. `reviewer.js` clicks the app's own UI and
sends messages that cannot be recalled. Keeping them apart means the file that
can do harm is small enough to read in one sitting, and every guard in it sits
at the point of action rather than at a call site.

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
  `__typename === 'JobListing'`. The cache is the source for **titles** only.
- Run `RecruitApplicantCounts` through the same client for the applicant
  counts, and join it onto those titles by `jobId`. See "The counts are asked
  for, not waited for" below, which is the most transferable thing in this
  document.

It holds no state, does no pacing, and knows nothing about downloads or dedup.
It is a classic script with no imports and no exports — MV3 will not run a module
in the MAIN world — so the message-type literals are duplicated inline from
`src/lib/messages.js` rather than imported, and the only test seam is a
`__WFX_COLLECTOR__` container that nothing in the extension ever defines.

#### The counts are asked for, not waited for

The Home screen shows "281 applicants" per role. That number is not in the
applicant list response — there is no `totalCount` — and it is not reliably in
the Apollo cache either. The cache holds a `JobListing` entity per role, and
`actionableApplicantsCount` on it is populated only for roles whose applicant
list the recruiter has actually opened in that session. On a fresh tab the cache
answers with sixteen titles and one count.

Four attempts were made to solve this by waiting, and all four failed:

1. Wait for the counts query to be registered on the client.
2. Wait for the counts to appear in the cache.
3. Wait for the cache to go quiet — hash the counts each read and stop once four
   consecutive reads agree, capped at twenty-four reads.
4. Wait for the document itself, anchoring on the tab's `loading` to `complete`
   transition before reading at all.

Each was a better heuristic than the last and each still produced the same
defect: the panel told the operator to reopen the panel for a number that was
never coming, because for a role nobody had opened there was nothing to wait
for. No amount of patience makes absent data arrive.

**Waiting was the wrong shape of answer.** A wait infers a fact from timing. It
can only ever establish "it has not appeared yet", and it cannot distinguish
that from "it is not going to". The counts were not slow, they were unasked
for — and the page registers a query, `RecruitApplicantCounts`, whose entire
job is to answer the question. So `collector.js` takes that live query's own
document and variables, runs it `network-only` through the page's own client,
and joins the result onto the titles by `jobId`. One request, a definite answer,
no polling anywhere on the path.

The generalisation is worth more than the fix: **when you find yourself tuning
how long to wait for a value, check first whether anything is going to produce
it.** A timing heuristic is what you reach for when you have decided the data is
in flight, and that decision is the part that was never checked. The Turnstile
section at the end of this document records the same error in the opposite
direction, and between them they are the two most expensive days on this
project.

The query is registered only in the applicant area, so it is not always
available. Failure is silent by design: the role list is still worth showing
without a count, the row says the count is not loaded yet, and Home offers the
one thing that does fix it — open that role's applicant list on Wellfound. A
run does not need the number; it is an estimate on a screen.

### 2. `reviewer.js` — MAIN-world content script

Injected at the same match pattern and world as the collector, and the only file
in this extension that clicks anything on Wellfound's page. It drives the
applicant reviewer — the modal the recruiter reviews candidates in — one
candidate per call. Accepting through it sends a real message to a real person.

Its whole shape comes from that. It receives an already-composed message string
and an **expected userId**, and it refuses to act on anybody it cannot identify
exactly:

- The candidate's identity is read out of the open modal's own links, which
  carry the form `/link/{userId}/{token}/resume_url`. That `userId` is the same
  identifier the ledger, the filenames and the CSV key on, so identity is exact
  rather than name-based. There is no fallback to the displayed name anywhere in
  the file; a modal whose id cannot be read, or that carries more than one,
  stops the run.
- The id and exact message are re-read from the DOM immediately before Send is clicked and after
  every pause, because the reviewer is positional — it shows whoever sits at the
  current index, and a blind accept messages whoever is on screen.
- Selectors are anchored and counted. Wellfound's page carries two elements
  whose text is exactly `Accept` (the button and a keyboard-shortcut legend row)
  and unanchored `/accept/i` also matches a candidate's own name and an
  "Ideal next opportunity" block. So the pattern is `/^accept$/i`, filtered to
  visible and enabled, and it must resolve to exactly one control. Finding two,
  or zero, aborts. The opener on the applicant list is the opposite case — one
  per card, fifteen on a full page — so plurality there is normal and the first
  is clicked. Two different intents, deliberately not one helper.
- Reject is never clicked and `R`/`X` are never sent, guarded at the point of
  action rather than by convention.
- It can be closed. `CLOSE_REVIEWER` cancels an open composer and closes the
  modal, and the pass calls it on every way out, including the throwing one: a
  run that ends leaving a half-filled composer on the recruiter's screen is a
  state the operator did not choose. Teardown never throws, because a failure to
  tidy up must not become the reported outcome of a run that otherwise worked,
  and it refuses to act while an accept is in flight. Cancelling the composer
  and closing the modal are reported separately, so a teardown that half worked
  says so.

Navigation, opening the composer and submission are clicks. The driver visibly
types with a yield between characters, rechecks the exact candidate id and
completed message, then clicks the one unique, usable `Accept application & send
message` control. It emits no Tab or Enter events and never retries an uncertain
submission click.

Filling the composer uses `HTMLTextAreaElement.prototype`'s own `value` setter
one character at a time, with `beforeinput` and `input`, because assigning `element.value`
directly leaves React's state empty. That was the dangerous unknown on this
path: had React ignored the synthetic input, the box would have *displayed* the
message while state stayed empty, and a run would have sent hundreds of empty
messages while reporting success. It was checked against `__reactProps$*.value`,
not against `element.value`, because only the former is the authority.

Like `collector.js` it is a classic script with no imports — MV3 will not run a
module in the MAIN world — so the message-type literals are duplicated inline
from `src/lib/messages.js`, and so is the one phrase the panel matches on to
tell a refusal from an ambiguous send.

### 3. `bridge.js` — ISOLATED-world content script

Injected at the same match pattern. A `window.postMessage` / `chrome.runtime`
relay with an explicit allowlist: three types for the collector (`LIST_JOBS`,
`FETCH_PAGE`, `QUERY_READY`) and the reviewer's own set (`OPEN_REVIEWER`,
`READ_CANDIDATE`, `ACCEPT_CANDIDATE`, `SKIP_CANDIDATE`, `CLOSE_REVIEWER`,
`STOP`). Exists solely because MAIN world cannot reach extension APIs. No logic,
no state beyond the pending map: it has no opinion about the fact that one of
those messages is irreversible, it only refuses to forward anything not named.

The one number in it is a claim about another file. `ACCEPT_CANDIDATE` is by far
the longest round trip the relay carries, and a budget that expires around one is
not a timeout — it is the panel being told the page went quiet while the message
is on its way out, after which the candidate is booked as failed and never
written to the ledger. So the timeout is not a round figure: the driver states
its own worst case and clamps its pauses to hold to it, the relay allows that
plus a margin, and a test reads both constants and fails if they stop agreeing.

### 4. `service-worker.js` — service worker

Three lines. On install it sets the side panel to open when the toolbar icon is
clicked. That is the whole file.

**It deliberately does not own the run loop, and never has.** Chrome terminates
an MV3 service worker after 30 seconds of inactivity, and neither `setTimeout`
nor an open message port resets that timer — only receiving an event or calling
an extension API does. This extension sleeps on purpose: reading breaks are drawn
from 15–40 s and about a third exceed 30 s, and one fires every 8–12 candidates.
A worker-hosted loop would be killed mid-run, silently, on essentially every run.

### 5. `panel/` — the side panel, and the run

A `chrome.sidePanel` page, **not** a browser-action popup. A popup is destroyed
the moment focus moves, which would kill a 12-minute run mid-flight. The panel
persists and stays visible beside the applicant list as the run works through it.

The run loop lives here, in `panel/run-controller.js`: an ordinary page document
has no idle timeout. It owns the run lock, pacing, the working tab, downloads,
CSV assembly and the abort path, and never talks to Wellfound's GraphQL API
directly — every request goes out through `tab-driver.js` to the bridge. Hosting
it here makes "closing the panel ends the run" physics rather than a feature, and
removes worker-to-panel event broadcasting entirely: the loop updates its own UI.

Four modules sit beside it, each with a boundary worth naming:

- `tab-driver.js` — find or open a recruiter tab, navigate it to a job's
  applicant list, poll `QUERY_READY` until the page can answer (500 ms poll,
  1500 ms settle after a navigation, 15 s timeout), watch for tab changes, and
  relay messages. Everything that knows what a tab is lives here; the run
  controller composes these and never reaches for `chrome.tabs` on its own.
  Two of them are about proving a page arrived rather than assuming it:
  - `watchTabs` registers a `chrome.tabs.onUpdated` listener that reads nothing
    off the event and only says "something changed, look again". It is what
    turns "Open Wellfound to get started" from a dead end into a screen that
    notices when you do.
  - `watchNavigation` is the same listener used as evidence. `chrome.tabs.
    reload` resolves when the reload is *initiated*, not when the new document
    commits, so the pre-reload document can still answer a readiness query and
    prove nothing. The watcher is installed **before** the reload is asked for
    and requires the `loading` then `complete` pair, with a 60 s deadline. Any
    probe here has to state what it actually establishes; this one establishes
    that a different document is answering.
- `ledger-service.js` — everything the extension knows about who has been
  fetched and whether their file is still on disk. It owns the ledger outright,
  takes no lock, drives no tab and paces nothing, so the Library screen can call
  all of it while no run is in flight.
- `downloader.js` — the `onDeterminingFilename` listener and the download
  promise. Registration is idempotent, because two listeners over one pending
  map would hand filenames back to Chrome.
- `accept-pass.js` — the second pass over a job: who may be accepted, in what
  order, what is believed about each send, and what the CSV row says about them.
  It decides and books; the DOM belongs to `reviewer.js` and the wording to
  `accept-message.js`. It never composes a selector, never retries a send, and
  never accepts anybody whose resume this extension does not already hold. It
  owns *when* a reload happens; the run controller owns *how*.

The view modules (`home-view.js`, `accept-confirm.js`, `running-view.js`,
`post-run-view.js`, `library.js`, `summary.js`, `trace-view.js`) are markup and
plain-data models, so every string and every judgement they make can be asserted
without a DOM.

### 6. `src/lib/` — the pure core

`normalize.js`, `csv.js`, `filename.js`, `reconcile.js`, `dedup.js`, `jitter.js`,
`trace.js`, `local-time.js`, `messages.js`, `accept-message.js` and the run loop
itself (`runner.js`)
are pure: no `chrome`, no `document`, no network. `ledger.js` is the single
exception, and takes its storage as an argument rather than reaching for
`chrome.storage` — which is what lets the whole dedup story be tested against a
plain object.

## Run flow

A run carries one `actions` value, `{ download, accept }`. A job is worked in
**two passes**, never interleaved: pass 1 is the API walk below, pass 2 is the
reviewer walk that accepts what pass 1 captured. Pass 2 runs only when `accept`
is on, and the section after this one explains why the order is not negotiable.

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
8. The ledger's run is closed out with the folder it wrote to.
9. **Pass 2**, if the run is accepting: `accept-pass.js` resolves any questions
   an earlier run left behind, then opens the reviewer and accepts the people
   pass 1 captured, **at most `limit` of them**, recording each in the ledger
   before the modal settles on the next person.
10. The CSV for that job is written, and the loop moves to the next job.

Downloads interleave with paging rather than batching at the end, so an aborted
run still leaves completed files and a partial CSV on disk.

The CSV is written after pass 2 rather than before it, which is the one ordering
that looks backwards and is not. An accepted candidate can never be fetched
again, so that file is the only surviving copy of what happened to them, and its
Accept column has to say. The pass never throws — an abort, a refusal or an
unclear send all come back as a result — so the CSV is written either way.

Pass 2 is held back entirely when pass 1 stopped because five downloads failed in
a row. That stop exists because continuing would issue hundreds of failing
requests at human pacing. Pass 2 does not merely continue: it drives Wellfound's
own UI to send irreversible messages under the operator's name, which is the
worst thing to start doing in the minute after the account showed the strongest
signal available that it is being throttled. The run says it held them back
rather than leaving a zero to be interpreted.

## Accepting

Everything in this section was established live against a real recruiter account
by driving the UI, not by reading the app's bundles, and one real accept was
completed end to end to establish it. Where a number appears it was counted.

### Accepting is not a status toggle

Pressing `A` in the applicant reviewer opens a Response composer, and the only
way forward from there is a button reading `Accept application & send message`.
There is no accept-without-message control anywhere in the flow.

So a run that accepts 200 people sends 200 messages under the operator's name.
That is outward-facing in a way downloading a resume never was, and it is why
this feature is opt-in at every layer, gated behind a confirmation screen, and
paced the same way the download walk is.

Wellfound's own `Saved Templates` and bulk selection are behind a higher plan, so
the extension puts the message into the composer itself, per candidate. There is
no template to select.

### The review queue drains as you accept

The single most important measured fact here, and it was not guessable. On
completing one accept:

- Before: position `1 of 116`.
- After: position `1 of 115`, showing a different candidate.

The index did not advance. The **denominator dropped**. Accepting removes that
person from the review queue and the next candidate slides into position 1. Two
consequences:

- **The confirm click auto-advances; `A` does not.** After the send the modal is
  already on the next person, so sending `Next` after an accept skips somebody.
- **Accepting everyone needs no navigation at all.** Stay at position 1, accept,
  repeat until the queue empties. There is no index arithmetic and therefore no
  drift between the API's ordering and the reviewer's — the entire class of
  off-by-one bugs simply does not arise.

Accept and skip are therefore confirmed by *different* signals, and neither may
stand in for the other:

| | Index | Total |
|---|---|---|
| Accept | holds | decrements |
| Skip | advances | holds |

A send is confirmed by watching for that change, never by assuming the click
worked or sleeping a fixed interval. It is the **first** of two kinds of
evidence, and for a long time it was believed to be the only one; the section
on unconfirmed sends below describes the second, which is absence from the
review queue, and why the two are not interchangeable.

What an accept *failure* looks like, and what the reviewer does when the queue
empties on the last candidate, could not be produced without accepting a hundred
more real people — so both are unverified, and the driver treats "the id did not
change within the timeout" as a question rather than as an answer: never as
success, never as failure, and never as a reason to retry. A retried accept is a
second message to someone who already got one.

Because the queue drains, progress is reported as **accepted so far out of
intended**, never as a share of a total that is shrinking underneath it.

### Accepting destroys this extension's own data source

The applicant query is filtered on `status`. The status enum, obtained by sending
an invalid value and reading the error back, is exactly `NEEDS_REVIEW`,
`REJECTED` and `SHORTLISTED`. There is **no `ACCEPTED`**, and the filter may be
neither null nor empty. After accepting a candidate they appear in none of the
three.

**An accepted candidate is permanently unreachable through the only data source
this extension has.** Accepting is not merely irreversible on Wellfound; it
destroys the ability to ever fetch that person's resume or fields again.
Everything below follows from that one fact.

**Two passes, never interleaved.** The download walk paginates with a cursor into
the `NEEDS_REVIEW` collection. Accepting removes people from that collection, so
accepting mid-walk mutates the very collection the cursor points into: the walk
then returns fewer people and reports success, with candidates skipped and no
error anywhere. Pass 1 runs to completion, then pass 2 drains the queue with
nothing reading a cursor. "Accept as you go" is the obvious implementation and it
is wrong.

**Accept last, and only somebody already captured.** Per candidate the order is
extract, download, write the row, then accept. A failed download is normally
repairable by re-running; accepting first converts a retryable failure into
permanent loss. So a candidate whose resume this extension does not hold is
refused, and the CSV cell says exactly that rather than sitting blank. The
corollary for accept-only runs is the same rule read backwards: somebody in the
review queue who is not in the download ledger is somebody whose resume we do not
have, and accepting them forfeits it forever. Accept-only refuses them and
reports the count plainly rather than accepting everyone in the queue.

**A person with two applications has two rows**, and the two must move together.
The row whose download the walk did not spend says only that the outcome is on
the other row — read as a capture it would launder a failed download into an
accept, read as a refusal it would block somebody whose download plainly worked.
It is a pointer, so it is neither.

**Existing features this changes:**

- **Re-download of an accepted candidate is impossible.** The Library's targeted
  walk searches `NEEDS_REVIEW` with a guest list and a page cap; an accepted
  person is not there, so the walk would page to its cap and report them missing
  after a long, pointless crawl. Instead the accept ledger is read before the
  Library screen renders, and such a person is counted as **accepted and can no
  longer be fetched** rather than as missing from disk — with no Re-download
  button behind them. Offering a remedy for a state that has no remedy, or
  walking forty pages to arrive at a wrong answer, are both the pretending-to-work
  this extension does not do.
- **Somebody with a provisional entry is a third state**, and the Library says
  so in its own words. They are not accepted, because nothing established that,
  and rendering them with the accepted wording would put an irreversible claim on
  screen that no run ever made. They are not plainly missing either, because a
  walk may find nobody. So they get their own count and their own line, and no
  button: the thing that resolves them is the next accept run over that role, and
  it is the only thing that can.
- **The CSV and the downloaded file are the only surviving copy** of an accepted
  candidate's data, which is why the row is written before the accept and why an
  aborted run still flushes what it has.
- **Home screen counts drop as accepting proceeds**, because the queue is what
  they count.

**What it buys:** a candidate who would otherwise expire in a few days, and be
emailed that the company never responded, gets a reply instead. That is the point
of the feature.

### A send nobody can vouch for

The reviewer does not always confirm. The click lands, the composer sits there,
and the counter does not move within any budget worth waiting for. This is the
single most common way a large accept run ends, and the Turnstile section
explains why.

It is not a failure. `error` in this codebase means **nothing was sent**, and
reaching for it after a click has already happened is a lie the operator will
act on. A timeout is not evidence of anything except that time passed.

So an unconfirmed send is settled by asking, in three widening circles, none of
which involves clicking anything again:

1. **Watch the DOM.** Six waits totalling about two minutes, reading the
   reviewer's own position and total. This costs nothing on the wire and it
   catches the ordinary case: the page was slow, the accept landed, the counter
   moved a minute after the click. That has been measured happening.
2. **Ask the review queue.** A cursor-paged walk of `NEEDS_REVIEW` looking for
   that one userId. Gone means the message landed. Still queued means it did
   not, yet.
3. **Sweep at the end of the role**, after the reviewer is closed, in three
   waves out to about two and a half minutes. Time is the cheapest evidence
   available and the end of the role is when spending it costs nothing.

The queue answer is **one-directional**, and this is the part to understand
before touching any of it. There is no `ACCEPTED` status to query. Nothing can
positively confirm an accept; the only question the API can answer is whether
the person has left the collection. Absence is exactly what a landed accept
produces and it does not expire, so `gone` is strong. Presence is weaker: it
means the message has not landed *yet*, and this page has been seen delivering
one minutes after the click.

**The ledger therefore holds a question as well as answers.** `accepted` means
"a message reached this person and must never be sent again" — a claim, and one
that may only be made when something vouched for it. `provisional` means "Send
was armed and nobody knows whether the operator used it". They are separate
maps and four separate verbs,
not one map with a flag, because collapsing them was a real bug with a real
cost: of two sends the page never confirmed, one had landed and one had not, and
the pass wrote both into `accepted`. The person who was never messaged was
permanently written off, and nothing would ever try them again.

Recording a deferral as an accept is the worse of the two errors available, so
it is the one the design refuses. The trade is stated plainly:

- A wrong `accepted` costs somebody the reply they applied for, silently and
  forever. Nothing revisits the accepted map.
- A wrong `provisional` costs a later run one query. The question does not
  expire, and asking it again is free.

`confirmProvisional` is the only route from the question to a permanent accept,
and it moves the entry in a single write so the person is never briefly in both
maps or briefly in neither: the whole value of the entry is that it exists
continuously from arming until the answer. It carries the original arming
timestamp across rather than restamping, because the question the CSV column
asks is when the message went out, not when we found out.

`releaseProvisional` is the opposite, and it is the one place in this extension
where a record that stops somebody being messaged is deliberately removed. It is
safe because it removes only the provisional entry and can never reach
`accepted`: it does not read that map, spread it or name it. A send anything ever
vouched for stays final. Releasing is the owner's decision and it carries a real
risk — if the queue was wrong, that person gets a second message — taken because
the alternative is a candidate who applied, was messaged by nobody, and is
recorded as handled.

A pass that is cut short by the operator releases nobody. Stopping is not
evidence.

**Questions outlive the run that asked them.** A crash, a closed panel or a fatal
error leaves provisional entries with nothing to resolve them. The next accept
pass over that role reads them back and settles them **before** planning
anything, so the plan is built on answers. Anything still unresolved keeps its
entry and its `unresolved` CSV cell, and waits for the run after that. This is
self-healing rather than permanent because the question does not go stale: the
person is either in the queue or they are not, however long you leave it.

**When the page stops answering at all, the pass stops.** Three deferrals in a
row, or a queue check that cannot reach a verdict, and the pass ends `unclear` —
and an `unclear` pass ends the whole run rather than moving on to the next role
in the same degraded session. Two in a row is reachable by ordinary bad luck;
three is a page that has stopped confirming anything, and a confirmed accept
resets the count. What is worth stopping on is not how many sends were slow, it
is whether anything is still vouching.

**A message that went out and could not be recorded is its own outcome.** If the
ledger write fails after a confirmed send — the extension reloaded mid-run,
storage rejected the write — that is neither `error` (nothing was sent) nor
`unclear` (the click is in doubt). It is `unrecorded`: the run stops there, the
person is named on screen, and the operator is told to check that role before
running it again, because nothing durable remembers the message. The CSV row is
written anyway and is the only surviving record of it.

### Run modes

`dryRun` used to be a boolean meaning "do not download". It is now an explicit
pair, `{ download, accept }`, so all four combinations are expressible and the
run states which it is doing:

| Mode | CSV | Resume | Accept |
|---|---|---|---|
| Preview only | yes | | |
| Download | yes | yes | |
| Accept only | yes | | yes |
| Download and accept | yes | yes | yes |

Accept-only is the retroactive case: the resumes are already on disk, and the
operator wants those same people accepted.

### The message

Supplied by the operator, stored as configuration rather than hardcoded, and
shown in full on the confirm screen before any run. `src/lib/accept-message.js`
owns both the wording and the guards, because composing a message and refusing to
send a bad one are two halves of one contract.

It carries two bracket tokens, `[first_name]` and `[role_name]`. The role name is
never missing — it is what the run walks. A missing first name makes the greeting
`Hey,`: the name is dropped, the comma stays, nobody is skipped for want of a
name, and it must never render with a stranded space. First names come from
Wellfound's own `firstName` field, falling back to splitting the display name
only when it is absent.

Substitution is verified per candidate before sending, and if any bracket token
survives the message is not sent. The check runs on an intermediate form where
token slots have been replaced by markers but candidate values have not yet been
dropped in, so a candidate whose own name happens to read like a token cannot be
re-substituted into. Two guards, one at compose time and one in the driver
at the Send-click boundary, because the second is the last point at which a
literal bracket can be stopped from reaching a stranger's inbox.

### Ledger

The download ledger records who was fetched. Accepts need their own dimension per
job, keyed by `userId`, or an accept-only rerun walks the same people again.

Accepting twice is probably a no-op in the UI — the buttons disable once a
response is sent — but the ledger must not rest on a remote system's behaviour.
Each accept is written **before the pass may advance**, one storage call per
person and never batched, for a sharper version of the reason downloads are
recorded early: an accept the ledger does not know about gets sent twice. The
write is idempotent on its timestamp, so a repeat keeps the original moment.

That ordering is structural, not a convention about where a call site sits. The
pass writes the provisional question before Send can receive focus and clears
its unresolved interlock only once the outcome is durably recorded. A reload requested inside that window
throws. Moving the ledger write below the in-memory advance is the same defect by
another road.

The accept dimension is **two maps**, `accepted` and `provisional`, for the
reason the section on unconfirmed sends gives: one holds answers and the other
holds questions, and a question written into the answers map is unrecoverable.
Both are maps rather than lists like `seenUserIds`, because these events are
unrepeatable and the moment each happened matters.

The queue also dedups on its own, since an accepted person never reappears in it.
That is a convenience, not the mechanism.

### Confirmation

The last point at which nothing has happened. Every other screen in the panel
reports something that already did. It states, plainly: how many people broken
down by role, that each of them receives a message, the exact wording as it will
be sent, and that accepting cannot be undone.

Its number must never read higher than what will happen, which is why an
accept-only run counts the people already on disk minus the ones already
accepted — the download ledger keeps holding somebody after they are accepted,
the review queue does not, and using the ledger's count alone double-counts that
difference on the second run over a role. The role's own limit is applied to that
figure too, since it bounds how many people are messaged and not only how many
are downloaded; a screen reading "Accept 100 people" above a run that will
message 25 is the one thing this screen must not do. Where the exact figure is
not knowable the screen says "up to" rather than guessing.

It is not a scare screen. The operator asked for this feature and knows what
accepting is. It is a place to read the number back before it becomes real.

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
  jobId, jobTitle, seenUserIds: string[], lastRunAt, totalDownloaded, folder,
  accepted:    { [userId]: localDateTimeText },
  provisional: { [userId]: localDateTimeText }
}
```

`accepted` and `provisional` are maps rather than lists like `seenUserIds`,
because an accept is unrepeatable and the moment it happened matters. Both are
stamped with local date and time text through `local-time.js`; a raw Unix
timestamp in a cell a human reads has already been a reported defect on this
project. The download dimension and the accept dimension are cleared by two
separate operations — `forget` and `forgetAccepted` — so no caller can wire one
button to both.

Every field name in the record stops inside `ledger.js`, behind a named reader.
That is not tidiness. A rename that silently defaulted the seen set to empty
would re-fetch hundreds of resumes at human pacing with no error anywhere; the
same rename against the accepted map would re-send hundreds of messages; against
the provisional map it would lose every question a crashed run left behind, and
each of those people would be messaged again with nothing recording that they
may already have been. Failing loudly in one place is worth the indirection.

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

Seventeen columns, in order:

Name, User ID, Job ID, Job Title, Location, Years Experience, LinkedIn, GitHub,
Website, Wellfound URL, US Authorized, Applied At, Resume Link, Resume Filename,
Resume, Accept, Accepted At.

The last two were appended rather than interleaved, so a spreadsheet built
against an older export still finds every prior column exactly where it was.

- **User ID, Job ID and Resume Filename** are there because filenames are
  `Name-userId-jobId`; without them a row cannot be mapped back to its file.
- **Resume** is the status of that row — `downloaded`, `already downloaded`,
  `no resume on file`, `not identifiable`, `locked on Wellfound`, `preview`,
  `not fetched: the run stopped first`, or `failed: {reason}`. It exists because
  without it "fetched on an earlier run" and "never fetched" are the same empty
  Resume Filename cell, and it is the column the import-safety rule above reads.
- **Accept** is the same idea for the other action, and it carries more weight
  than any status word above it: for an accepted candidate this file is the only
  surviving record. So it never collapses distinct causes into one "skipped"
  cell. Its vocabulary is `accepted`, `already accepted` (the ledger had them
  before this run began), `not attempted: this run was not accepting` (a mode the
  operator chose), `not attempted: the run stopped first` (a limit the run hit,
  worded to mirror the Resume column's equivalent), `refused: no resume on file,
  accepting would lose them for good`, `unresolved: the message may have been
  sent; never retried` for a send still waiting on an answer, and
  `failed: {reason}` for an accept that was attempted and could not be
  completed — the identity interlock aborting, the composer never opening, a send
  the queue later said had not landed. `unresolved` and `failed` are the two
  halves of what used to be one cell, split for the reason the ledger's two maps
  are split: one of them is a question and the other is an answer.
- **Accepted At** is written from the ledger's own stamp, so the CSV and the
  ledger cannot disagree about when a message went out.
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

Five, not two. One column, no top tabs: a 400 px column fragmented by tabs reads
as a dashboard, and this is a single task.

- **Home** — the roles, their per-role settings, the destination folder, an
  Advanced disclosure, and the start button. Accepting sits on this main screen
  rather than under Advanced: it is the one choice on the panel that reaches a
  stranger, so it is not something to be found by disclosure. Ticking it opens
  the message for editing underneath, with a worked example, and states what
  accepting costs beside the box rather than only on the confirm screen.
- **Confirm** — shown only for an accepting run, between Start and the first
  message. It gates the one irreversible action in this extension, so it is a
  screen rather than a dialog: the count by role, the exact wording, the
  refusals, and that it cannot be undone. An accepting run's start button reads
  **Review who will be accepted** rather than carrying a number, because the
  number Home knows is how many people would be downloaded, and that is not how
  many would be accepted.
- **Running** — the breath lane, the progress bar, the running breakdown and a
  stop button.
- **Post-run** — the account the run gives of itself, with the trace available
  to download. It is a separate screen because Home answers "what do you want to
  do now" and a summary answers "what happened last time", and one screen cannot
  honestly do both.

  It opens with **what the run was asked to do**, above what it did: the mode,
  each role and its limit, the page size, the folder, and for an accepting run
  the exact message that went out, reproduced in full. That is captured before
  the first request rather than reconstructed afterwards, so it is the intent and
  not a summary of the outcome, and the two can be read against each other. The
  message is there because the one thing a reader wants to know about an
  irreversible message is what it said. The trace carries the ids and the numbers
  and deliberately not the message text.
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
date, the three reconciliation drifts, and two groups whose files have left the
disk and cannot simply be fetched again. Anybody accepted is reported as
**accepted and can no longer be fetched**, not as missing. Anybody whose send was
never confirmed is reported as having an accept nobody could confirm, which the
next run settles. Neither draws a Re-download button. Both distinctions are made
where the counts are read rather than inside the action, so the screen never
offers a remedy it would refuse a moment later. One phrasing per fact: the
accepted wording is the same sentence the re-download result uses, because it is
the same fact told at a different moment, and the unconfirmed wording is
deliberately not that sentence because it is not that fact. Actions per job,
and only these:
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
it the absence of an action: `actions.download` off. A run carries one
`actions` value, `{ download, accept }`, so the four modes a run can be in - the
CSV alone, download, accept, or both - are each expressible; `download` defaults
on because that is what a run has always done, and `accept` is only ever
opt-in. The seen set is `seenUserIds`. The GraphQL page size is
`pageSize` and the number of candidates to take from a role is `limit`; they used
to share the name `first`, which is why the constant that means "25 candidates"
was once called `DEFAULT_FIRST`.

Errors state cause and recovery rather than naming a mechanism: "Open your hiring
pages on Wellfound (wellfound.com/recruit) to see your jobs", not "no matching
tab". The pause is the moment a user decides the panel has hung, so it is the one
line that explains itself rather than naming itself.

The two errors that name a place to go are **links to that place**, opening in a
new tab, with the remedy words themselves as the anchor rather than a bare URL or
a trailing "click here". A sentence that tells somebody to open a page and then
makes them find it is a dead end wearing an instruction. The panel matches on an
error's code to decide this, never on its prose, so rewording a message can never
silently remove its link. A page that has lost its content script gets a reload
button on the same principle, and Home keeps watching for the tab either way, so
the screen fixes itself when the operator does the thing it asked for.

## Rate limiting and detection avoidance

- **Strictly serial.** Never more than one in-flight request, ever.
- **Jittered sleeps** drawn from a log-normal distribution, not a fixed value:
  2.5–7 s between page queries, 1.5–4 s between resume downloads. Overshooting
  draws are resampled rather than clamped — clamping piles ~12% of draws onto the
  exact upper bound, and a spike at one value is the most fingerprintable shape
  there is.
- **Reading breaks:** a 15–40 s pause every 8–12 candidates. The accept pass
  reuses this model and deliberately the same constants: reading a profile
  before deciding is what a person does at that screen anyway, so the rhythm
  needs no new numbers.
- **Two pauses around the message**, one while the composer opens and one to
  read the completed text before dispatch. The driver enters text incrementally
  through input events without emitting character key events, so A, R and X in
  the message can never become reviewer shortcuts.
- **Submission is an exact guarded click.** Immediately after revalidating the
  candidate id and completed message, the driver clicks the one unique, usable
  Send control. It emits no keyboard events and never retries an uncertain click.
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
- **The limit bounds accepts as well as downloads**, and that is one number
  rather than two on purpose. It used to bound pass 1 alone, and pass 1 counts
  *new* downloads: on a role already fully downloaded its counter never moves, so
  a limit of 3 sent 115 messages. It now also means "at most N people are
  messaged", applied last, after every row has its cell, so queue order is
  preserved and a refusal or an already-accepted person does not spend the
  number. If the two ever have to differ they should be two named settings on
  screen, not one number read two ways.
- **The reload cadence** — see below. It is the one pacing constant argued from
  what the page needs rather than from what a person does, and it is named here
  so that asymmetry is not mistaken for an oversight.

At default pacing a 281-applicant job takes roughly 12 minutes. That is the point.

### What an accept pass costs on top of that

Three things the download walk does not do, all of them added between live runs
because the page degrades. They are the loudest traffic this extension produces
and none of them is free:

- **Reloading the applicant list every five to seven accepts**, plus once
  whenever an accept took longer than ninety seconds or a send did not confirm.
  On a hundred-person role that is roughly eighteen full navigations inside one
  session. This is the honest weak point of the pacing story: every other number
  here is argued from what a person does at that screen, and nobody reloads their
  applicant list every sixth accept for an hour. It is jittered only within its
  own range, so the shape (N accepts, reload, N accepts, reload) is more regular
  than the behaviour it imitates. It is kept because without it a long pass
  stalls outright, and the alternative on the table was a run that stops halfway.
  It is a distinctive session fingerprint; it is not a known detection.
- **The queue check**, up to forty pages of ten at download pacing per look, run
  once or twice per unconfirmed send and up to three times more in the
  end-of-role sweep. A cursor hint remembers which page answered last time and
  goes straight back to it, which usually reduces a look to a handful of
  requests, but the hint is dropped whenever a page cannot be read and the next
  look then walks again. On a large role with a cold hint this is minutes, not
  seconds. It asks for ten records a page, the same as an ordinary run, so its
  requests are indistinguishable from one.
- **The reload the pass asks for is never allowed to land inside an accept.**
  The pass names the person it is sending to before the click, and a reload
  requested while that name is set throws rather than proceeding. A reload that
  committed mid-send would destroy the only witness to a message that may already
  be in a stranger's inbox.

The running screen shows all of this. A settle window that says nothing is
several minutes in which the applicant counter is frozen, the tab reloads itself,
and the panel is indistinguishable from ordinary pacing — while the most alarming
state this software has is being investigated. The reloads, the slow accepts, the
unconfirmed send and the queue checks each have words on screen.

**Not built:** aborting when the user navigates the working tab away. A run does
stop when the tab leaves the applicant list, but only because the next message to
the content script fails and the run reports that failure — which is a
consequence, not a designed abort. The `chrome.tabs.onUpdated` listeners that do
exist are for the opposite purpose: noticing that a page has *arrived*, either so
Home can retry after the operator opens Wellfound, or so a reload can be proved
to have committed. Closing the panel does end the run, because the loop lives in
the panel document.

## Observed operational limit: accepts are gated by Turnstile

This is the reason the accept feature is reliable at small volume and unreliable
at large. That boundary is a design fact rather than an item on a backlog, and
the section is long because the finding was cheap and the six wrong fixes before
it were not. **Read this before moving any bound on the accept path.**

Nothing here is about circumventing the gate. It is a diagnosis and a boundary.

### The symptom, over nine live runs

Two roles on a real recruiter account. One with about twenty applicants in its
review queue, one with about a hundred and eleven.

```
20-applicant role:   2 accepted then stalled
                     9 accepted then stalled
                    20 of 20, clean
111-applicant role:  3 accepted then stalled
                     0 accepted - the FIRST accept hung
                    16 accepted then stopped
                     5 accepted then stopped
                    10 of 74 then stopped
                     4 of 63, six sends unconfirmed, five never landed
```

The small role completed. The large role never did, in five attempts.

### What was tried, and why every attempt failed

Every stall looked like a timing problem, and every one was met by moving a
bound:

- DOM confirmation window: 15 s, then 40 s, then 125 s
- relay budget: 30 s, then 45 s, then 90 s
- slow-accept trigger: 20 s, then 90 s
- the settle window after an unconfirmed send: lengthened, then shortened with
  an end-of-role sweep instead
- deferral bound: two per pass, then three in a row
- a ceiling on unconfirmed sends per pass, added and later deleted

Each was tolerance for a symptom. Each new number was calibrated on the last
worst case observed, and each was beaten by the next run. **The treadmill is the
thing to recognise, not the individual numbers.** If a bound has been raised
three times and the failure has moved rather than gone, the bound is not the
problem.

Some of those constants are still in the file. They are worth keeping — a slow
page is a real thing and the pass has to survive one — but they were chosen
before anybody knew what they were tolerating, so read them as historical rather
than as tuned against a known cause.

### What was measured, ruling out the obvious causes

These measurements predate visible incremental typing. They establish the
behavior of the former paste-like automatic submit path; whether incremental
entry changes the outcome must be measured live rather than inferred.

On the 111-applicant role, live:

- advancing the reviewer to the next candidate: **44-135 ms**
- opening the response composer: **13-996 ms**
- running the extension's own pass-1 walk first, which takes the page's Apollo
  cache from **368 to 1382 entries**, then repeating both measurements: **no
  measurable difference**

So the reviewer is fast, the composer is fast, and this extension's own cache
pressure — the leading hypothesis at the time, and the one that would have been
our fault — has no effect at all. The only slow step is the send itself, and it
is server-bound.

### The decisive observation

One accept was performed **by hand** with the network captured, on the same page,
the same session and the same role.

- It completed immediately. The queue counter went from `4 of 63` to `4 of 62`,
  the composer closed, the reviewer advanced.
- At the moment of the send, the capture showed:

```
challenges.cloudflare.com/turnstile/v0/api.js?onload=turnstileLoad   200
challenges.cloudflare.com/turnstile/v0/g/<id>/api.js                 pending
```

- Afterwards `window.turnstile` was present on the page, with **no visible
  challenge and no iframe** — an invisible or managed challenge, not a puzzle.

### The conclusion, and its confidence

The accept mutation is gated by Cloudflare Turnstile. The challenge runs on every
send, a human one included, and the mutation needs what it issues.

For the human send it resolved instantly. For automated sends it evidently
resolves slowly or not at all, and that one explanation covers every symptom at
once:

- early accepts in a session succeed quickly
- the same accepts take 45 to 90 seconds later in the same session
- some never land at all, and those people stay in the review queue indefinitely
- a fresh page reload does not help, so it is not page state
- the small role finishes because it never performs enough accepts in one
  session to matter

Confidence, stated honestly: the Turnstile load is directly observed, the human
send completing instantly is directly observed, and the causal link to the
automated failures is a strong inference consistent with all nine runs rather
than something proven by isolating a token.

### What follows for the design

- **Budget small runs.** The feature works. It works at twenty. It does not work
  at a hundred in one session, and no constant in this repository changes that.
- **Read a timeout on the accept path as "the page slowed down", not as a bug.**
  That is why an unconfirmed send is a question resolved by asking the queue,
  why `error` is reserved for sends that certainly did not happen, and why the
  ledger holds a provisional map at all. Those mechanisms are the design
  accommodating this limit rather than fighting it.
- **The reload cadence and the settle window predate the finding.** They were
  built in response to the slowdowns, before anyone knew the cause. They are kept
  because they demonstrably keep a long pass alive, not because they were
  measured against Turnstile.

### The transferable lesson

Worth stating plainly, because it generalises well past this feature:

**When an operation is bimodal — fast, or never — and its failure rate rises
with how many times you have performed it in a session, suspect a challenge or a
rate limit before you touch a timeout.** Check the network for challenge scripts.
A latency you can tune is a distribution. A gate is a decision about you, and no
amount of waiting changes a decision.

Read this alongside the counts finding earlier in this document, where four
waiting heuristics failed because the data came from a query nobody was asking.
They are the same error in different clothes: inferring from timing what could
have been established by looking.

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
| Candidate has no resume this extension holds, on an accepting run | Refuse the accept, mark the row `refused: no resume on file, accepting would lose them for good`, carry on. Accepting them would forfeit that resume forever. |
| The composed message still holds a bracket token | Do not send. Mark the row failed with the reason, skip that candidate, carry on: the fault is in the wording, not in the page. |
| The reviewer is showing somebody other than the expected candidate, or their id cannot be read | Stop the pass. No name-based fallback and no guess. Nothing was sent. |
| The composer does not open, or a control does not resolve to exactly one match | Stop the pass and say so. This is a **certain** failure: nothing was clicked and nothing went out, and the panel says exactly that. |
| A send that never confirmed | Watch the DOM, then ask the review queue, then sweep again at the end of the role. Gone from the queue books the accept and the pass carries on; still queued releases them only after teardown proves no composed message remains, so they stay eligible; otherwise the provisional entry remains. No verdict also leaves a provisional entry for the next run and raises the one alert in this panel that asks the operator to go and check Wellfound. Never retried, because a retry is a second message to a real person. |
| Three deferrals in a row, or a queue check with no verdict | End the pass `unclear`, and end the whole run rather than starting the next role in the same degraded session. The page has stopped vouching for anything, and the next role is the one that sends messages. |
| The ledger write fails after a confirmed send | Its own outcome, `unrecorded`. Stop the run, name the person, write the CSV row anyway, and tell the operator to check that role before running it again. Neither "nothing was sent" nor "the click is in doubt". |
| The reviewer will not close at the end of a pass | Reported, never thrown. A failure to tidy up must not become the reported outcome of a run that otherwise worked, and cancelling the composer and closing the modal are reported separately. |
| A reload that cannot be observed committing | Fail rather than proceed. `chrome.tabs.reload` resolving proves only that the reload was asked for, and the old document can answer a readiness query. |
| `RecruitApplicantCounts` is not registered on the page | Show the roles without their counts, say the count is not loaded yet, and tell the operator which page produces one. Never a wait, and never a message promising a number that is not coming. |
| Five downloads fail in a row on an accepting run | Hold pass 2 back entirely for that role, and say so. Nobody was accepted and nothing is lost. |
| Stop pressed during an accept pass | An `AbortSignal` does not cross into a content script, so the stop is forwarded as its own message and is felt inside the pause rather than after it. The pause ends there and no send follows. |
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

`npm test` runs the whole suite under `vitest`: 29 files, upwards of nine
hundred tests, green. The count is given as a floor rather than a figure on
purpose. This document carried an exact one for long enough that it drifted by
two hundred, and a reader who catches a document out on a number they can check
in five seconds has no reason to believe the parts they cannot.

Everything pure gets real unit tests: CSV field escaping and the import-safety
filter, filename sanitizing and its round trip through the parser, the jitter
sampler's bounds and distribution, the dedup diff, the early-stop rule, the
ledger's arithmetic against a plain-object storage, reconciliation, and the trace
scrubber. The panel's views are tested through a fake DOM, and the run controller
through a fake `chrome` and a fake page.

`collector.js` is tested by evaluating the file's own text with the
`__WFX_COLLECTOR__` container pre-defined — not a copy of it, and not a rewrite —
because MV3 will not run a module in the MAIN world and `export` is not available
there. `reviewer.js` is tested the same way, against a fake DOM built to the
counts that were measured on the live page rather than to what the driver
expects — a page carrying two elements whose text is exactly `Accept` with only
one of them usable, and other elements whose text merely contains the word. A
fake built from the same belief as the code cannot contradict it, and the first
version of that driver passed the whole suite while two of its measured facts
were wrong.

Accepting is the one path where a green test is not enough on its own, because
the failure it guards against is a message to a real stranger. The rule on this path is
that a guard which matters is mutation-tested rather than trusted: point the Accept selector at
Reject and the guard must fire; loosen the anchor on the Accept pattern and the
uniqueness check must catch it; take the accept knowledge out of the Library's
counts and a test must fail on what the operator sees, not merely on an internal
number; render a provisional person with the accepted wording and a test must
fail on the sentence, because that sentence is the claim. A test named after a
risk proves nothing until it has been watched to fail.

This has caught real things twice. Unanchoring the Accept pattern once passed all
660 tests. Deleting the reload interlock outright once passed all 791, because
every test watching it observed the reviewer's message log, in which the ledger
write's position is invisible — so they asserted exactly the convention they
claimed not to be asserting. A guard defended only by a comment is a comment.

**The fixture rule.** `tests/helpers/captured-shape.js` is the one fixture built
from a live capture, and it must be carried across every seam by at least one
test. It once flattened `recruitCandidate.candidate` away — the level
`normalize.js` actually reads — and the whole suite stayed green, because every test
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
8. An accepting run limited to one person, with authorisation, on a role that can
   spare it — the confirm screen's count matches, the reviewer's total drops by
   one, the ledger and the CSV both record the accept, and the summary reports
   what was sent rather than what was attempted. There is no safe valve for this
   step and there cannot be one: a preview of an accept is a message that was not
   sent, so the only honest verification is a real one, small.

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
- **Wellfound renames or restyles a reviewer control.** The accept path is the
  one place this extension depends on the shape of the page rather than on the
  API, and its selectors are anchored and counted precisely so that a rename
  fails loudly at the first candidate instead of clicking whatever moved into
  place. The cost of that strictness is that a harmless rename stops accepting
  runs outright. Accepted deliberately: the alternative is a looser selector, and
  the control one position away from Accept is Reject.
- **Terms of service.** This automates actions the account is already entitled to
  perform, on the account holder's own job listings, at human pace. Accepting
  raises the stakes rather than the exposure — it is still an action the operator
  performs by hand today, at the same pacing, with the same wording — but it is
  outward-facing, so it is opt-in, confirmed, and never applied to anybody whose
  data the run did not already capture.
- **`window.__APOLLO_CLIENT__` is removed** in a future build. Fallback would be
  intercepting responses while driving the UI's own infinite scroll — slower, and
  not designed here.
