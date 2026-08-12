# Applicant Exporter for Wellfound

A Chrome extension (Manifest V3) that downloads applicant resumes and a CSV from
your own Wellfound recruiter job listings, and remembers who it already fetched
so later runs get only the new people.

> **Not affiliated with, endorsed by, or connected to Wellfound or AngelList.**
> "Wellfound" is a trademark of its respective owner and is used here only to
> describe what this tool works with.

## What it does

For each job listing you select, it walks your applicant list, downloads each
candidate's resume named after them, and writes a CSV of the whole list. It
keeps a per-job ledger so the next run fetches only people it has not seen.

Files land in `Downloads/<subfolder>/` named `Name-userId-jobId.pdf`. A CSV of
the run is written alongside them, with a `Resume` column saying, for every
person, whether their file was actually fetched.

## Install

The extension has no runtime dependencies. `npm install` is only needed to run
the tests.

1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder — the one containing
   `manifest.json`.

Requires Chrome 116 or newer, for the side panel API.

## Use

1. Open your hiring pages on Wellfound (anywhere under `wellfound.com/recruit`).
2. Click the extension icon to open the side panel.
3. Tick the roles you want and click **Download N resumes**.

Every role defaults to all its new applicants, so the ordinary run needs no
settings at all. The chevron beside a role opens that role's own options: get
all of them or just the first N, and whether to re-read pages already
downloaded. **Save to** sets the download subfolder; **Advanced** holds a
preview-only mode and a larger fetch size.

The panel names the applicant bucket it is about to export as soon as the first
page arrives, before anything downloads, so you can stop if it is not the one
you meant.

## How it works

Wellfound's GraphQL endpoint is signature-gated: a replayed request without the
page's `x-apollo-signature` header returns 404. Rather than forging requests, a
MAIN-world content script drives the page's own Apollo client, copying the live
query's variables and overriding only the cursor and page size. Every request is
genuinely the site's own client, with its own session and signature.

The run loop lives in the side panel rather than the service worker, because
Chrome terminates an MV3 service worker after 30 seconds of inactivity and this
loop sleeps on purpose.

Runs are strictly serial and paced with log-normal jitter, plus a longer reading
break every 8 to 12 candidates. A 280-applicant job takes roughly 12 minutes.
That is deliberate: it is one person's browser doing one thing at a time.

## Keeping track across runs

Three sources, in order of authority:

- **A per-job ledger** in extension storage, keyed on user ID — the identifier
  that survives a CSV round-trip, a filename, and a move to another machine.
- **Reconciliation against Chrome's own download history**, which catches files
  you deleted or moved. The Library screen shows what is verified present, what
  is missing, what it cannot verify, and what it found on disk but does not know
  about.
- **CSV import**, for a new machine or a fresh profile. Only rows whose resume
  actually landed are adopted.

## Privacy

Everything stays on your machine.

The extension makes **no network requests of its own** — there is no `fetch`,
no XHR, no WebSocket, no telemetry and no analytics anywhere in the source. The
GraphQL calls are made by Wellfound's own page code; the file transfers are made
by Chrome's download manager. Nothing is sent to any third party, and there is
no server component.

It requests one host permission, `https://wellfound.com/*`, and three API
permissions: `storage` for the ledger, `downloads` to save files and check which
still exist, and `sidePanel` for the UI. It does **not** request the `tabs`
permission, so it cannot see the title or URL of any tab other than the
Wellfound one it works with.

Applicant data is written to two places, both of which you choose and control:
the resume files and the CSV, in your Downloads folder. The ledger stores only
user IDs and job IDs — no names, no contact details, no resume contents.

You are handling other people's personal data. Treat the output folder
accordingly.

## Fair use

This automates something you can already do by hand, on your own job listings,
at roughly the speed a person would do it. The pacing exists so that stays true.

You are responsible for your own use of it, including whether it fits Wellfound's
terms of service. Read them.

## Development

```
npm install
npm test
```

The pure modules under `src/lib/` are unit tested, as is the panel side against a
fake `chrome`. [docs/DESIGN.md](docs/DESIGN.md) explains how the extension works
and why — including the recon that established how the applicant API behaves,
which is where most of the design constraints come from.

## Limits

- The export follows whichever applicant tab your Wellfound page is showing.
  That is normally **Needs Review**.
- Files can only be written under your browser's Downloads directory. An
  extension cannot write anywhere else.
- Each run writes its own dated CSV. The extension cannot read files back, so it
  cannot append to an earlier one.
- Applicant lists are capped at 20 records per request by Wellfound's server, so
  a large job takes many requests. That bound is theirs, not ours.

## Licence

MIT — see [LICENSE](LICENSE).

The bundled fonts are licensed separately under the SIL Open Font License,
Version 1.1. See [src/assets/fonts/OFL.txt](src/assets/fonts/OFL.txt).
