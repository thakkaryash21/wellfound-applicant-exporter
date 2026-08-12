import { escapeHtml } from './escape-html.js';

function describeRefetch({
  refetched,
  stillMissing,
  stoppedBecause,
  failed = 0,
  noResume = 0,
  pages = 0,
  pageCap = 0,
}) {
  let tail = stillMissing ? `, ${stillMissing} still missing` : '';
  // A rejection used to propagate out of the walk and take the successes with
  // it. Now they are counted, so both numbers have to be shown.
  if (failed) tail += `, ${failed} failed`;
  if (noResume) tail += `, ${noResume} have no resume on Wellfound`;
  if (stoppedBecause === 'aborted') return `Stopped after ${refetched}${tail}`;
  // "Gave up after 3" invites the reading that it barely looked. It read the
  // whole cap; say so.
  if (stoppedBecause === 'capped') {
    return `Searched ${pages || pageCap} pages, found ${refetched}${tail}`;
  }
  return `Re-downloaded ${refetched}${tail}`;
}

// One message under a row's actions, replacing whatever was there rather than
// stacking another one: a user who taps a failing action three times should see
// one message, not three. Three sites used to write this by hand and only one
// of them replaced.
function say(element, message, { marker, extra = '' }) {
  if (!element) return;
  const existing = element.querySelector(`.${marker}`);
  if (existing) {
    existing.textContent = message;
    return;
  }
  element.querySelector('.lib-actions')?.insertAdjacentHTML(
    'afterend',
    `<div class="job-meta ${extra} ${marker}" role="status">${escapeHtml(message)}</div>`,
  );
}

function showError(element, message) {
  say(element, message, { marker: 'lib-error', extra: 'warn' });
}

// The other half: what an action did when it worked.
function showNote(element, message) {
  say(element, message, { marker: 'lib-note' });
}

// All three states, not just `missing`. Chrome's download history is what
// reconciliation reads, so a user who cleared it would otherwise be told "all
// files present" while the disk may hold nothing at all.
function states(job) {
  const parts = [];
  if (job.missing) {
    parts.push(`<span class="warn num">${job.missing}</span>
      <span class="job-meta"> missing from disk</span>`);
  }
  if (job.unverifiable) {
    parts.push(`<span class="num">${job.unverifiable}</span>
      <span class="job-meta"> not in your download history, so can\u2019t verify</span>`);
  }
  if (job.orphans) {
    parts.push(`<span class="num">${job.orphans}</span>
      <span class="job-meta"> found on disk but not in the ledger</span>`);
  }
  if (parts.length === 0) return '<span class="job-meta">all files present</span>';
  return parts.map((p) => `<div>${p}</div>`).join('');
}

function row(job) {
  const missing = states(job);
  const last = job.lastRunAt ? new Date(job.lastRunAt).toLocaleDateString() : 'never';
  return `
    <div class="lib-row" data-id="${escapeHtml(job.jobId)}">
      <div class="job-title">${escapeHtml(job.jobTitle ?? job.jobId)}</div>
      <div class="job-meta">
        <span class="num">${job.downloaded}</span> downloaded \u00b7
        <span class="num">${job.known}</span> known \u00b7 last run ${last}
      </div>
      <div>${missing}</div>
      <div class="lib-actions">
        ${job.missing ? '<button type="button" data-act="refetch">Re-download missing</button>' : ''}
        ${
          job.orphans
            ? `<button type="button" data-act="adopt">Adopt ${job.orphans} found files</button>`
            : ''
        }
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
    screen.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
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

    element.querySelector('[data-act="refetch"]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (button.dataset.running === 'yes') {
        // The same button is the stop control while the walk is in flight: a
        // re-download can walk many pages, so it must always be interruptible.
        controller.abort();
        button.disabled = true;
        button.textContent = 'Stopping\u2026';
        return;
      }
      button.dataset.running = 'yes';
      button.textContent = 'Re-downloading\u2026 tap to stop';
      try {
        // No folder: the controller uses the one this job was last run with,
        // so re-downloads land beside the originals.
        const result = await controller.redownloadMissing({ jobId });
        button.textContent = describeRefetch(result);
      } catch (error) {
        button.textContent = 'Re-download missing';
        showError(element, error.message);
      } finally {
        button.dataset.running = '';
        button.disabled = false;
      }
    });

    element.querySelector('[data-act="adopt"]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const { adopted } = await controller.adoptOrphans(jobId);
        // Re-render for the same reason the import path does: this screen
        // exists to show where the ledger and the disk disagree, so its own
        // counts must never outlive a change to the ledger.
        await renderLibrary(screen, { controller, onBack });
        // The re-render replaced the row, so the note goes on the new one.
        showNote(screen.querySelector(`.lib-row[data-id="${jobId}"]`), `Adopted ${adopted} files.`);
      } catch (error) {
        button.disabled = false;
        showError(element, error.message);
      }
    });

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
        showNote(
          screen.querySelector(`.lib-row[data-id="${jobId}"]`),
          `Imported ${imported} people.`,
        );
      });
      input.click();
    });

    element.querySelector('[data-act="forget"]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (button.dataset.confirm !== 'yes') {
        button.dataset.confirm = 'yes';
        // Announced, not only shown: the button's own label is what changes, so
        // without this a screen reader user gets no signal that the next tap is
        // the destructive one.
        button.setAttribute('aria-live', 'polite');
        button.textContent = 'Tap again to forget';
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
