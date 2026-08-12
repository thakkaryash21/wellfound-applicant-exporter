import { describe, it, expect } from 'vitest';
import {
  sanitizeName,
  extensionFromUrl,
  buildFilename,
  basename,
  parseFilename,
  filenameRegexForJob,
} from '../src/lib/filename.js';

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
});

describe('basename', () => {
  it('drops a Windows directory, which is what chrome.downloads.search returns', () => {
    expect(basename('D:\\Downloads\\wellfound-resumes\\Jane Doe-7700001-9100001.pdf')).toBe(
      'Jane Doe-7700001-9100001.pdf',
    );
  });

  it('drops a POSIX directory', () => {
    expect(basename('/home/y/wf/Jane Doe-7700001-9100001.pdf')).toBe(
      'Jane Doe-7700001-9100001.pdf',
    );
  });

  it('is empty for nothing', () => {
    expect(basename(null)).toBe('');
    expect(basename(undefined)).toBe('');
  });
});

// Moved here from reconcile.test.js with the code they cover. reconcile.js used
// to hand-write this grammar a second time, and each module was tested against
// its own literals, so the two could disagree with nothing failing.
describe('filenameRegexForJob', () => {
  // The positive case is asserted by the round-trip suite below, against a
  // filename buildFilename actually produced rather than a hand-typed one.
  it('does not match another job\u2019s files', () => {
    const re = new RegExp(filenameRegexForJob('9100001'));
    expect(re.test('C:\\Users\\y\\Downloads\\wf\\Jane Doe-7700001-9100004.pdf')).toBe(false);
  });

  it('does not match the CSV', () => {
    const re = new RegExp(filenameRegexForJob('9100001'));
    expect(re.test('C:\\Users\\y\\Downloads\\wf\\applicants-9100001-2026-08-11.csv')).toBe(false);
  });
});

describe('parseFilename', () => {
  it('reads the user id from a Windows path', () => {
    expect(parseFilename('C:\\d\\wf\\Jane Doe-7700001-9100001.pdf', '9100001')?.userId).toBe(
      '7700001',
    );
  });

  it('returns null for an unrelated file', () => {
    expect(parseFilename('/d/notes.pdf', '9100001')).toBe(null);
  });

  it('gives back every part of the name', () => {
    expect(parseFilename('Jane Doe-7700001-9100001.docx', '9100001')).toEqual({
      name: 'Jane Doe',
      userId: '7700001',
      jobId: '9100001',
      ext: 'docx',
    });
  });
});

// The assertion that was missing entirely, and the reason building and parsing
// now live in one module: change the separator or the field order and this
// fails, rather than reconciliation silently matching nothing.
describe('the filename round trip', () => {
  const cases = [
    { name: 'Jane Doe', userId: '7700001', jobId: '9100001' },
    // A person whose own name carries the separator, which is what makes a
    // hand-written parser tempting to get wrong.
    { name: 'Jane Doe-Smith', userId: '7700002', jobId: '9100001' },
    { name: 'A/B', userId: '7700003', jobId: '9100001' },
    { name: '', userId: '7700004', jobId: '9100001' },
  ];

  for (const c of cases) {
    it(`survives ${c.name || '(no name)'}`, () => {
      const built = buildFilename({ ...c, url: 'https://x/y.pdf' });
      const parsed = parseFilename(built, c.jobId);
      expect(parsed).not.toBe(null);
      expect(parsed.userId).toBe(c.userId);
      expect(parsed.jobId).toBe(c.jobId);
      expect(parsed.name).toBe(sanitizeName(c.name));
      expect(parsed.ext).toBe('pdf');
      // And the search pattern the Library uses finds the very same file.
      expect(new RegExp(filenameRegexForJob(c.jobId)).test(built)).toBe(true);
    });
  }

  it('rejects a file built for another job', () => {
    const built = buildFilename({ name: 'Jane Doe', userId: '1', jobId: '9100002', url: '' });
    expect(parseFilename(built, '9100001')).toBe(null);
  });
});
