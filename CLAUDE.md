# Working on this repo

A Chrome MV3 extension that exports applicant resumes and a CSV from your own
Wellfound recruiter jobs, and optionally accepts the people it captured.

Read `README.md` for what it does and `docs/DESIGN.md` for why it is shaped this
way. This file carries only what is surprising, invariant, or expensive to learn.
`git log --oneline` is worth twenty minutes: the commit subjects are written as
statements of intent and say what each change was for.

`npm test` is 29 files and 896 tests, green. Keep it that way.

## The one fact everything else follows from

Accepting a candidate on Wellfound is not a status toggle. It sends that person a
message under the operator's name, it cannot be undone, and it removes them from
`NEEDS_REVIEW`, which is the only collection this extension can read.

So accepting somebody whose resume was never captured forfeits that resume
permanently. A retryable download failure becomes permanent loss. A run that
accepts 200 people sends 200 messages to 200 strangers.

Nothing in this codebase is worth a shortcut on that path. If a change makes the
accept path simpler but slightly less certain about who it messaged, it is a
regression.

## Load-bearing lines

These are the code's reason for existing. Know which is which before you refactor
near them.

- **Identity interlock.** `reviewer.js` reads the candidate's userId out of the
  DOM (`/link/{userId}/{token}/resume_url`), then synchronously re-reads that id
  and the exact textarea value at the Send-click boundary. It blocks submission
  if either changed. There is no name-based fallback anywhere and there must
  never be one. The reviewer is positional: a blind Accept messages whoever
  happens to be on screen.
- **Ledger before dispatch.** `accept-pass.js` writes a provisional entry before
  `reviewer.js` is allowed to dispatch the Send click, and clears it only once the person is
  durably confirmed or a certain pre-send refusal releases it. Inside that
  window a real message may exist and nothing may reload the page.
  `guardReload` throws if a reload is requested there. Moving the ledger write
  after `remaining.delete` / `mark` / `totals.accepted` is the same defect by
  another road: a rerun messages that person a second time.
- **Four ledger verbs, not one with a flag.** `recordAccepted` (a message
  reached them, permanent), `recordProvisional` (armed, nobody knows, a
  question), `confirmAccepted`, `releaseAccepted`. Collapsing these was a real
  bug.
- **Never send twice within a pass**, and never retry a send. A retried accept is
  a second message to someone who already got one. A send whose outcome is
  unknown is settled by asking the queue, never by clicking again.
- **Two passes, never interleaved.** Pass 1 is the API walk (paginate, download,
  write rows). Pass 2 is the reviewer walk (accept what pass 1 captured).
  Accepting mid-walk mutates the collection the cursor points into and candidates
  are skipped with no error at all: the walk just returns fewer people and
  reports success. "Accept as you go" is the obvious implementation and it is
  wrong.
- **Refuse the uncaptured.** `planAccepts` decides per person, not per row, using
  `some` + `every` over that person's rows. A person can hold two rows with
  disagreeing statuses, and the earlier version accepted them on the strength of
  the good one.
- **Never reject.** The reviewer binds `A` to Accept and `R`/`X` to Reject,
  adjacent in the DOM, both enabled. The driver refuses to click any control
  matching `/reject/i`, at the point of action.

## Architecture shapes that are not accidents

- **The run loop lives in the side panel**, not the service worker. MV3 kills a
  worker after 30 s of inactivity and this loop sleeps on purpose.
- **Content scripts are classic scripts with no imports.** MV3 will not run a
  module in the MAIN world. That is why `bridge.js` duplicates the message names
  and the relay budget, and why `tests/bridge.test.js` reads both constants and
  fails when they diverge. Do not "fix" the duplication; keep the test that pins
  it.
- **`collector.js` is the only Apollo caller.** The GraphQL endpoint is
  signature-gated: a replayed request without the page's `x-apollo-signature`
  returns 404. The panel drives the page's own Apollo client, copying the live
  query's variables and overriding only cursor and page size, rather than forging
  requests. Every request is genuinely the site's own client.
- **The reviewer submits by exact click.** It clicks to open the reviewer and
  composer, visibly types through the textarea setter with a yield between
  characters, re-reads the exact userId and message, then clicks the one unique,
  usable `Accept application & send message` control. It never uses keyboard
  events for submission and never retries an uncertain click.
- **The pass owns when a reload happens; the run controller owns how.** The tab
  is the controller's business. A pre-send control that exists but has no
  usable layout box is a measured broken-page state: the pass may reload twice
  and resume by userId, but never while a send is unresolved.

## Measured facts about Wellfound

Established live against a real recruiter account, not read off the bundles.
Treat them as measurements, and re-measure rather than infer if you doubt them.

- **The review bucket is a queue, not a list.** Accept at position 1 and the
  observation was `1 of 116` becoming `1 of 115` with a different person at
  position 1. The index does not advance; the denominator drops. So confirm
  auto-advances and `A` does not, sending Next after an accept skips somebody,
  and accepting everyone needs no navigation at all.
- **The two signals differ.** Accept: index holds, total decrements. Skip: index
  advances, total holds. Do not use one as the completion check for the other.
- **The status enum is exactly `NEEDS_REVIEW`, `REJECTED`, `SHORTLISTED`** (found
  by sending an invalid value and reading the error), and `filters` may not be
  null or empty. There is no `ACCEPTED`. An accepted candidate appears in none of
  the three, so they are unreachable forever. The Library must say so up front
  rather than walking forty pages to report them missing.
- **Applicant counts come from a separate query**, not from the Apollo cache.
  Waiting on the cache for them was a bug that told users to reopen the panel for
  a number that was never coming.
- **Synthetic keyboard events do not perform page actions.** `keydown` +
  `keyup` with `key: 'ArrowRight'` left the position unchanged. The accept path
  therefore uses no synthetic Tab or Enter events; submission is an exact,
  guarded click on the unique Send control.
- **Text alone is not a safe selector.** `/^accept$/i` matched 2 elements with 1
  usable; unanchored `/accept/i` matched 4 with 3 usable, picking up a
  candidate's own name and an "Ideal next opportunity" block. The opener
  `/^view application$/i` legitimately matches 15, one per card, and the loop
  clicks the first. Exactly-one is right for Accept and wrong for the opener; do
  not express both with one helper.
- **Page size is capped at 20 records per request** by their server.
- **The React value-setter trick works**, verified at `__reactProps$*.value`, not
  merely `element.value`. The message is built one character at a time through
  that setter with `beforeinput`/`input`, then read back exactly before Send is
  focused. If this ever needs revisiting, check the React props.

### Operational limit: accepts are gated by Turnstile

Accept sends pass through Cloudflare Turnstile. Directly observed: the challenge
script loads at the moment of a send, `window.turnstile` is present afterwards,
and no visible challenge or iframe appears - it runs invisibly. A send performed
by hand completes immediately. Automated sends slow sharply as a session
accumulates volume, and some never complete at all, leaving that person in the
review queue indefinitely.

The current path visibly types before clicking the exact Send control. Do not
claim that visible incremental entry changes the Turnstile boundary until a live
run measures it. The old nine runs remain evidence about the former paste-like
automatic-click path.

That boundary is a design fact, not a backlog item: the feature is reliable at
small volume and unreliable at large.

**Read the full investigation in `docs/DESIGN.md` before touching any timeout in
the accept path.** It records nine live runs, the measurements that ruled out
every other cause, and the six bounds that were moved before anyone looked at
the network. Do not repeat that path.

The one thing to carry even if you read nothing else: **an operation that is
bimodal - fast, or never - and whose failure rate rises with how many times you
have performed it in a session is a gate, not a slow call.** No timeout fixes a
decision about you. Check the network for challenge scripts first.

Note the reload cadence and settle window predate this finding; they were built
in response to the slowdowns, before anyone knew what caused them. Treat their
constants as historical rather than as tuned against Turnstile.

Do not write anything about circumventing it and do not treat it as a problem
awaiting a solution.

## Traps this repo has actually hit

- **Escape sequences written as raw bytes.** Writing an escape as an actual
  control character has turned source files binary here more than once. After any
  bulk edit, run `git diff --stat` and confirm nothing shows as `Bin`. Never use
  `perl -0pi` on this tree.
- **Tests that pass while the thing they are named for is broken.** Unanchoring
  the Accept pattern once passed all 660 tests. Deleting the reload interlock
  once passed all 791. A test named after a risk proves nothing until it has been
  watched to fail. Mutation-test any guard that matters: break the code, run the
  suite, see red, put it back.
- **Fakes built from the spec rather than from the page.** The first reviewer
  driver passed the whole suite while two of its measured facts were wrong,
  because the fake DOM was built from the same draft the code was. A fake that
  agrees with its code cannot contradict it. Where the harness has to guess, guess
  pessimistically.
- **The captured-shape fixture.** `tests/helpers/captured-shape.js` is the one
  fixture from a live capture and must be carried across every seam by at least
  one test (`tests/captured-shape-e2e.test.js`). It once flattened a level that
  `normalize.js` actually reads, and the suite stayed green.
- **Readiness probes that prove less than the caller needs.** `chrome.tabs.reload`
  resolves when the reload is initiated, not when the new document commits, so
  the pre-reload document can answer a readiness query and prove nothing. Any
  probe here must state what it actually establishes.
- **Timeouts deciding outcomes.** A relay timeout is not evidence that a message
  did not go out. `error` in this codebase means nothing was sent; do not reach
  for it when a click already happened.

## Working rules

- **One term per concept**, across code, tests, UI copy, CSV headers and docs.
  `bucket` has meant three different things here and the drift is still being
  paid down; the user-facing word is **review queue**.
- **Measure against the live page** rather than inferring from bundles or from
  what the code expects.
- **Plain ASCII source.** The operator's accept message is the one place with
  typographic apostrophes and it is reproduced byte for byte on purpose: do not
  normalise it.
- **No em dashes in anything the operator reads** - panel copy, CSV headers,
  report text, error messages. That rule was set for the product's own voice and
  applies there. `docs/DESIGN.md` is prose written for engineers and uses them
  throughout; leave it alone rather than half-converting a document.
- **No `console.*`** outside the sanctioned sites (`verbose-console.js` and the
  one render-failure log in `run-controller.js`).
- **The extension makes no network requests of its own.** No fetch, no XHR, no
  telemetry. Keep it that way; the privacy claim in the README depends on it.
- **The UI reports what happened, not what was attempted.** A screen that says
  success while something is unknown is a defect, not a rough edge.
- Keep `docs/DESIGN.md` true when behaviour changes. It has gone stale twice, and
  both times it stated the opposite of what the code does about an irreversible
  action.

## This is a public repository

No company names, no real candidate names, no real user ids, no real job ids or
titles, anywhere in the repo. Placeholders in use: `9100001` for a job id,
`Jane Doe`, `Platform Engineer`, `70000001`-style user ids.

The `.superpowers/` planning documents are git-ignored and DO contain real
values. Be careful what you carry across from them.

Sweep before every push, not once at some milestone. Real values have been
reintroduced by later work more than once.
