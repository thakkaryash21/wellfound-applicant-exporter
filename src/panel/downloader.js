import { buildFilename, basename } from '../lib/filename.js';

// Keyed by URL, not by downloadId, because onDeterminingFilename can fire
// before chrome.downloads.download() resolves with an id. Registering after the
// download starts loses that race, Chrome names the file from the server, and
// reconciliation can never match that person again.
// url -> { folder, conflictAction, name?, userId?, jobId?, filename? }. A resume
// entry carries the parts its name is built from; the CSV carries the finished
// name, because the caller already knows it.
const pendingByUrl = new Map();

const DOWNLOAD_TIMEOUT_MS = 120000;

// Registering twice would install two listeners over one `pendingByUrl`: the
// first to fire deletes the entry, the second finds no meta and returns false,
// and returning false from any listener hands the name back to Chrome. So the
// call is made idempotent rather than merely called once, which is what lets
// callers register defensively without having to know who else already has.
let registered = false;

export function registerFilenameHandler() {
  if (registered) return;
  registered = true;
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const url = item.url;
    const meta = pendingByUrl.get(url) ?? pendingByUrl.get(item.finalUrl);
    if (!meta) return false; // not ours - leave Chrome's default alone
    // A download this extension started always gets its name suggested here,
    // never left to the `filename` option alone: once a listener is registered,
    // declining to suggest hands the name back to Chrome's own guess - which for
    // a blob URL is the blob's UUID, and that is how the CSV came out as
    // `7be87504-....csv`.
    const filename =
      meta.filename ??
      buildFilename({
        name: meta.name,
        userId: meta.userId,
        jobId: meta.jobId,
        url: item.finalUrl || item.url,
        mimeType: item.mime,
      });
    suggest({ filename: `${meta.folder}/${filename}`, conflictAction: meta.conflictAction });
    pendingByUrl.delete(url);
    pendingByUrl.delete(item.finalUrl);
    return true;
  });
}

// A download stalled in `in_progress` fires neither 'complete' nor
// 'interrupted', so without a timeout the run parks forever and the abort
// button goes inert - abort is only read between iterations.
function waitForCompletion(downloadId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(() => reject(new Error('Download did not complete in time')));
    }, DOWNLOAD_TIMEOUT_MS);

    function settle(finish) {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      finish();
    }

    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        settle(resolve);
      } else if (delta.state?.current === 'interrupted') {
        settle(() => reject(new Error(delta.error?.current ?? 'Download interrupted')));
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

// chrome.downloads.download rejects anything that is not absolute, with an
// opaque message. Wellfound's link fields arrive relative, so getting this wrong
// fails every candidate in a run: say what is wrong on the first one.
function requireAbsolute(url) {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return;
  throw new Error(`Resume link is not a full URL: ${String(url)}`);
}

export async function downloadResume({ url, name, userId, jobId, folder }) {
  requireAbsolute(url);
  // Registered before the download starts, so the naming listener cannot lose
  // the race against it.
  pendingByUrl.set(url, { name, userId, jobId, folder, conflictAction: 'overwrite' });
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({ url, conflictAction: 'overwrite' });
    await waitForCompletion(downloadId);
  } finally {
    // A download that fails before Chrome ever asks for a filename never reaches
    // the listener, so clean up here too or the map grows for the whole run.
    pendingByUrl.delete(url);
  }
  const [item] = await chrome.downloads.search({ id: downloadId });
  // The basename only. Chrome answers with the absolute path, and this value
  // goes straight into the CSV's Resume Filename column.
  return { downloadId, filename: item?.filename ? basename(item.filename) : null };
}

// The name is registered for the listener, not merely passed as an option: with
// a listener installed, a download it declines to name falls back to Chrome's
// own guess and the caller's `folder/filename` is discarded whole - which is how
// this file landed in the downloads root under the blob's UUID.
export async function downloadTextFile({ dataUrl, filename, folder }) {
  pendingByUrl.set(dataUrl, { filename, folder, conflictAction: 'uniquify' });
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: `${folder}/${filename}`,
      conflictAction: 'uniquify',
    });
    await waitForCompletion(downloadId);
  } finally {
    pendingByUrl.delete(dataUrl);
  }
  return downloadId;
}

// The CSV and the run report are the same download: a blob this extension made,
// named by this extension, landing in the run's own folder. One path, so the
// report cannot quietly acquire a blob-UUID name the way the CSV once did - and
// one place that revokes the object URL. The two call sites each did `new Blob`
// -> createObjectURL -> download -> `finally revokeObjectURL` by hand, one of
// them a screen orchestrator minting object URLs, where a missed revoke leaks a
// blob for the whole lifetime of the panel.
export async function downloadBlobText({ text, mime, filename, folder }) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  try {
    return await downloadTextFile({ dataUrl: url, filename, folder });
  } finally {
    URL.revokeObjectURL(url);
  }
}
