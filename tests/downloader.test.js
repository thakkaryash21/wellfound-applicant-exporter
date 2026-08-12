import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';

const CRLF = String.fromCharCode(13, 10);
const RESUME_URL = 'https://wellfound.com/link/1/tok/resume_url';

// Imported fresh per test: the pending-name map is module state, and a test that
// inherited another test's map would prove nothing about the race it exists for.
async function loadDownloader() {
  vi.resetModules();
  return import('../src/panel/downloader.js');
}

let fake;

beforeEach(() => {
  fake = installFakeChrome();
});

afterEach(() => {
  fake.restore();
  vi.useRealTimers();
});

// I6: the handler used to be registered as an import side effect of
// run-controller.js, so panel.js's own downloadTextFile was named correctly only
// because panel.js imports run-controller on the line above downloader. These
// two pin the property that replaced that arrangement.
describe('who registers the filename handler', () => {
  it('is not registered by merely importing the downloader', async () => {
    const { downloadTextFile } = await loadDownloader();
    expect(fake.chrome.downloads.onDeterminingFilename.size()).toBe(0);
    const id = await downloadTextFile({
      dataUrl: 'blob:wfx/1',
      filename: 'run-report.md',
      folder: 'resumes',
    });
    // Nobody registered, so nobody suggests, and Chrome's own guess stands -
    // which for a blob URL is the blob's UUID, in the downloads root. This is
    // the failure mode, stated so the test below is measured against it.
    const [item] = await fake.chrome.downloads.search({ id });
    expect(item.filename).not.toBe('resumes/run-report.md');
  });

  it('is registered by constructing a controller, whatever the import order', async () => {
    vi.resetModules();
    // Deliberately the order that used to break it: downloader first.
    const { downloadTextFile } = await import('../src/panel/downloader.js');
    const { createController } = await import('../src/panel/run-controller.js');
    createController({ onEvent: () => {} });
    expect(fake.chrome.downloads.onDeterminingFilename.size()).toBe(1);

    const id = await downloadTextFile({
      dataUrl: 'blob:wfx/1',
      filename: 'run-report.md',
      folder: 'resumes',
    });
    const [item] = await fake.chrome.downloads.search({ id });
    expect(item.filename).toBe('resumes/run-report.md');
  });

  it('installs one listener however many times it is called', async () => {
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    registerFilenameHandler();
    registerFilenameHandler();
    expect(fake.chrome.downloads.onDeterminingFilename.size()).toBe(1);
    // A second listener over one pending-name map would find the entry already
    // deleted and hand the name back to Chrome.
    const result = await downloadResume({
      url: RESUME_URL,
      name: 'Jane Doe',
      userId: '7700001',
      jobId: '9100001',
      folder: 'resumes',
    });
    expect(fake.items.at(-1).filename).toBe('resumes/Jane Doe-7700001-9100001.pdf');
    expect(result.filename).toBe('Jane Doe-7700001-9100001.pdf');
  });
});

describe('registerFilenameHandler', () => {
  it('names the file after the candidate, under the chosen folder', async () => {
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    const result = await downloadResume({
      url: RESUME_URL,
      name: 'Jane Doe',
      userId: '7700001',
      jobId: '9100001',
      folder: 'wellfound-resumes',
    });
    expect(fake.items.at(-1).filename).toBe('wellfound-resumes/Jane Doe-7700001-9100001.pdf');
    // What it reports back is the basename alone. That value goes into the
    // CSV's Resume Filename column, and a CSV is a thing people forward: the
    // column is called Filename, not Path, and the user's directory layout is
    // nobody else's business.
    expect(result.filename).toBe('Jane Doe-7700001-9100001.pdf');
  });

  it('reports a bare basename even when Chrome answers with an absolute path', async () => {
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    const search = fake.chrome.downloads.search;
    fake.chrome.downloads.search = async (query) => {
      const items = await search(query);
      // What Chrome actually returns on Windows.
      return items.map((i) => ({ ...i, filename: `D:\\Downloads\\${i.filename}` }));
    };
    const result = await downloadResume({
      url: RESUME_URL,
      name: 'Jane Doe',
      userId: '7700001',
      jobId: '9100001',
      folder: 'wellfound-resumes',
    });
    expect(result.filename).toBe('Jane Doe-7700001-9100001.pdf');
  });

  // The whole reason the map is keyed by url and written before download() is
  // called: Chrome can ask for the filename before it hands back the id. The
  // test supplies that timing itself rather than relying on the fake's, so what
  // it pins is our ordering - register, then start - and not the fake's.
  it('has already registered the name by the time download() is entered', async () => {
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    let suggested = null;
    const download = fake.chrome.downloads.download;
    fake.chrome.downloads.download = async (opts) => {
      // The worst case Chrome allows: the filename is wanted before this call
      // has produced an id, let alone returned one. A downloader that
      // registered after `await download(...)` would have nothing to say here
      // and the file would land under Wellfound's server-side name, where
      // reconciliation can never match that person again.
      fake.chrome.downloads.onDeterminingFilename.emit(
        { url: opts.url, finalUrl: opts.url, mime: 'application/pdf' },
        (s) => {
          suggested = s;
        },
      );
      return download(opts);
    };
    await downloadResume({
      url: RESUME_URL,
      name: 'Jane Doe',
      userId: '7700001',
      jobId: '9100001',
      folder: 'f',
    });
    expect(suggested).toEqual({
      filename: 'f/Jane Doe-7700001-9100001.pdf',
      conflictAction: 'overwrite',
    });
  });

  // Wellfound's resume link is `/link/{userId}/{token}/resume_url` - no
  // extension anywhere in it - so extensionFromUrl always returns null and the
  // MIME table is the production path, not the fallback its position suggests.
  it('takes the extension from what Chrome says the file is', async () => {
    const cases = [
      ['application/pdf', 'pdf'],
      ['application/msword', 'doc'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
      ['text/plain', 'txt'],
      // Something nobody has a table entry for. A resume with no name at all is
      // worse than one with an optimistic extension.
      ['application/x-iwork-pages-sffpages', 'pdf'],
    ];
    for (const [mime, ext] of cases) {
      fake.restore();
      fake = installFakeChrome({ mime });
      const { registerFilenameHandler, downloadResume } = await loadDownloader();
      registerFilenameHandler();
      await downloadResume({
        url: RESUME_URL,
        name: 'Jane Doe',
        userId: '7700001',
        jobId: '9100001',
        folder: 'f',
      });
      expect(fake.items.at(-1).filename, mime).toBe(`f/Jane Doe-7700001-9100001.${ext}`);
    }
  });

  // Wellfound's /link/ endpoint redirects to a signed S3 url, so the item
  // Chrome hands the listener need not carry the url the download was started
  // with under `url`. The map is consulted under both, and the fallback branch
  // is what stands between a redirected resume and a file named after an S3
  // object key that identifies nobody.
  it('still knows the file when the url it registered arrives as finalUrl', async () => {
    const signed = 'https://wellfound-resumes.s3.amazonaws.com/abc?X-Amz-Signature=deadbeef';
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    let suggested = null;
    const download = fake.chrome.downloads.download;
    fake.chrome.downloads.download = async (opts) => {
      fake.chrome.downloads.onDeterminingFilename.emit(
        { url: signed, finalUrl: opts.url, mime: 'application/pdf' },
        (s) => {
          suggested = s;
        },
      );
      return download(opts);
    };
    await downloadResume({
      url: RESUME_URL,
      name: 'Jane Doe',
      userId: '7700001',
      jobId: '9100001',
      folder: 'f',
    });
    expect(suggested.filename).toBe('f/Jane Doe-7700001-9100001.pdf');
  });

  it('leaves downloads it did not start alone', async () => {
    const { registerFilenameHandler } = await loadDownloader();
    registerFilenameHandler();
    const id = await fake.chrome.downloads.download({ url: 'https://example.com/other.pdf' });
    const [item] = await fake.chrome.downloads.search({ id });
    expect(item.filename).toBe(`wellfound-server-name-${id}.pdf`);
  });

  it('overwrites rather than uniquifies, so a retry does not make a second file', async () => {
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    await downloadResume({ url: RESUME_URL, name: 'Jane Doe', userId: '1', jobId: '2', folder: 'f' });
    const [item] = await fake.chrome.downloads.search({ id: 1 });
    expect(item.conflictAction).toBe('overwrite');
  });

  it('forgets a url once it has been named, so the map does not grow', async () => {
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    await downloadResume({ url: RESUME_URL, name: 'Jane Doe', userId: '1', jobId: '2', folder: 'f' });
    // A second download of the same url with nobody registered gets Chrome's
    // own name, which is only possible if the first attempt cleared the entry.
    const id = await fake.chrome.downloads.download({ url: RESUME_URL });
    const [item] = await fake.chrome.downloads.search({ id });
    expect(item.filename).toBe(`wellfound-server-name-${id}.pdf`);
  });
});

describe('downloadResume', () => {
  it('rejects when the download is interrupted', async () => {
    fake.restore();
    fake = installFakeChrome({ autoComplete: false });
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    const pending = downloadResume({
      url: RESUME_URL, name: 'Jane Doe', userId: '1', jobId: '2', folder: 'f',
    });
    await Promise.resolve();
    fake.fail(1, 'SERVER_FORBIDDEN');
    await expect(pending).rejects.toThrow('SERVER_FORBIDDEN');
  });

  // A stalled download fires neither 'complete' nor 'interrupted'. Without the
  // timeout the run parks for ever and the Stop button goes inert, because abort
  // is only read between candidates.
  it('gives up on a download that never settles', async () => {
    fake.restore();
    fake = installFakeChrome({ autoComplete: false });
    vi.useFakeTimers();
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    const pending = downloadResume({
      url: RESUME_URL, name: 'Jane Doe', userId: '1', jobId: '2', folder: 'f',
    });
    const assertion = expect(pending).rejects.toThrow('did not complete in time');
    await vi.advanceTimersByTimeAsync(120000);
    await assertion;
  });

  it('removes its onChanged listener once the download settles', async () => {
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    await downloadResume({ url: RESUME_URL, name: 'Jane Doe', userId: '1', jobId: '2', folder: 'f' });
    expect(fake.chrome.downloads.onChanged.size()).toBe(0);
  });
});

describe('downloadTextFile', () => {
  it('uniquifies rather than overwrites, so yesterday\u2019s export survives', async () => {
    const { downloadTextFile } = await loadDownloader();
    await downloadTextFile({ dataUrl: 'blob:x', filename: 'applicants.csv', folder: 'f' });
    expect(fake.calls.downloads[0]).toMatchObject({
      filename: 'f/applicants.csv',
      conflictAction: 'uniquify',
    });
  });

  // The field bug: the CSV landed in the downloads root as
  // 7be87504-....csv. With a naming listener installed, a download it declines
  // to name falls back to the browser's own guess - the blob's UUID - and the
  // caller's folder goes with it.
  it('names the blob after the job and the date, under the chosen folder', async () => {
    const { registerFilenameHandler, downloadTextFile } = await loadDownloader();
    registerFilenameHandler();
    await downloadTextFile({
      dataUrl: 'blob:chrome-extension://x/7be87504-4c69-4c15-9115-f812e2c07f26',
      filename: 'applicants-9100001-2026-08-11.csv',
      folder: 'wellfound-resumes',
    });
    const [item] = await fake.chrome.downloads.search({ id: 1 });
    expect(item.filename).toBe('wellfound-resumes/applicants-9100001-2026-08-11.csv');
    expect(item.conflictAction).toBe('uniquify');
  });

  it('forgets the blob url afterwards, so nothing else inherits that name', async () => {
    const { registerFilenameHandler, downloadTextFile } = await loadDownloader();
    registerFilenameHandler();
    await downloadTextFile({ dataUrl: 'blob:x', filename: 'applicants.csv', folder: 'f' });
    const id = await fake.chrome.downloads.download({ url: 'blob:x' });
    const [item] = await fake.chrome.downloads.search({ id });
    expect(item.filename).toBe(`wellfound-server-name-${id}.pdf`);
  });
});

// The CSV and the run report both used to do `new Blob` -> createObjectURL ->
// download -> `finally revokeObjectURL` by hand, one of them in the panel's own
// screen code. A missed revoke there leaks a blob for the panel's lifetime.
describe('downloadBlobText', () => {
  let created;
  let revoked;

  beforeEach(() => {
    created = [];
    revoked = [];
    globalThis.URL.createObjectURL = (blob) => {
      created.push(blob);
      return `blob:wfx/${created.length}`;
    };
    globalThis.URL.revokeObjectURL = (url) => revoked.push(url);
  });

  afterEach(() => {
    delete globalThis.URL.createObjectURL;
    delete globalThis.URL.revokeObjectURL;
  });

  it('writes the text under the name and folder it was given', async () => {
    const { registerFilenameHandler, downloadBlobText } = await loadDownloader();
    registerFilenameHandler();
    await downloadBlobText({
      text: `a,b${CRLF}`,
      mime: 'text/csv;charset=utf-8',
      filename: 'applicants-9100001-2026-08-11.csv',
      folder: 'wellfound-resumes',
    });
    const [item] = await fake.chrome.downloads.search({ id: 1 });
    expect(item.filename).toBe('wellfound-resumes/applicants-9100001-2026-08-11.csv');
    expect(await created[0].text()).toBe(`a,b${CRLF}`);
    expect(created[0].type).toBe('text/csv;charset=utf-8');
  });

  it('revokes the object url it made', async () => {
    const { registerFilenameHandler, downloadBlobText } = await loadDownloader();
    registerFilenameHandler();
    await downloadBlobText({ text: 'x', mime: 'text/plain', filename: 'run.txt', folder: 'f' });
    expect(revoked).toEqual(['blob:wfx/1']);
  });

  it('revokes it even when the download fails', async () => {
    const { downloadBlobText } = await loadDownloader();
    fake.chrome.downloads.download = async () => {
      throw new Error('no');
    };
    await expect(
      downloadBlobText({ text: 'x', mime: 'text/plain', filename: 'run.txt', folder: 'f' }),
    ).rejects.toThrow('no');
    expect(revoked).toEqual(['blob:wfx/1']);
  });
});

// Wellfound sends resume links as paths. chrome.downloads.download rejects a
// relative url with an opaque message, and it would do so for every candidate in
// the run, so the first one has to say what is actually wrong.
describe('the absolute-url guard', () => {
  it('refuses a relative resume link by name', async () => {
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    await expect(
      downloadResume({
        url: '/link/1/tok/resume_url', name: 'Jane Doe', userId: '1', jobId: '2', folder: 'f',
      }),
    ).rejects.toThrow('not a full URL');
    expect(fake.calls.downloads).toHaveLength(0);
  });

  it('refuses a null resume link rather than starting a download', async () => {
    const { registerFilenameHandler, downloadResume } = await loadDownloader();
    registerFilenameHandler();
    await expect(
      downloadResume({ url: null, name: 'Jane Doe', userId: '1', jobId: '2', folder: 'f' }),
    ).rejects.toThrow('not a full URL');
  });
});
