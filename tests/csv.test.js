import { describe, it, expect } from 'vitest';
import { escapeField, toCsv, userIdsFromCsv, CSV_COLUMNS, formatDate } from '../src/lib/csv.js';
import { RESUME_STATUS, ACCEPT_STATUS, acceptFailure, formatDateTime } from '../src/lib/csv.js';
import { normalizeNode } from '../src/lib/normalize.js';

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

  it('uses CRLF line endings', () => {
    expect(toCsv([record]).split('\r\n')).toHaveLength(3); // header, row, trailing
  });

  it('emits a header-only file for no records', () => {
    expect(toCsv([]).slice(1).trim().split('\r\n')).toHaveLength(1);
  });

  it('writes the resume status alongside the filename', () => {
    const row = toCsv([{ ...record, resumeStatus: 'already downloaded' }])
      .split('\r\n')[1];
    expect(row).toContain('already downloaded');
  });
});

describe('userIdsFromCsv', () => {
  const D = RESUME_STATUS.DOWNLOADED;

  it('reads the User ID column regardless of its position', () => {
    const text =
      `Name,User ID,Job ID,Resume\r\nJane Doe,111,9100001,${D}\r\nJohn Doe,222,9100001,${D}\r\n`;
    expect(userIdsFromCsv(text)).toEqual(['111', '222']);
  });

  it('imports only rows scoped to the selected job', () => {
    const text =
      `User ID,Job ID,Resume\r\n111,9100001,${D}\r\n` +
      `222,9100002,${D}\r\n`;
    expect(userIdsFromCsv(text, { jobId: '9100001' })).toEqual(['111']);
  });

  it('adopts nothing for a job-scoped import when Job ID is missing', () => {
    const text = `User ID,Resume\r\n111,${D}\r\n`;
    expect(userIdsFromCsv(text, { jobId: '9100001' })).toEqual([]);
  });

  it('tolerates a BOM and quoted fields', () => {
    const text = `\ufeff"Name","User ID","Resume"\r\n"Doe, Jane","333","${D}"\r\n`;
    expect(userIdsFromCsv(text)).toEqual(['333']);
  });

  it('returns an empty array when the User ID column is absent', () => {
    expect(userIdsFromCsv('Name,Email,Resume\r\nJane Doe,j@x.com,downloaded\r\n')).toEqual([]);
  });

  it('skips blank lines and blank ids', () => {
    const text = `User ID,Resume\r\n111,${D}\r\n\r\n\r\n222,${D}\r\n`;
    expect(userIdsFromCsv(text)).toEqual(['111', '222']);
  });

  it('adopts rows fetched on an earlier run', () => {
    const text = `User ID,Resume\r\n111,${RESUME_STATUS.ALREADY}\r\n`;
    expect(userIdsFromCsv(text)).toEqual(['111']);
  });

  // The bug this filter exists for: a run that hit its limit writes hundreds of
  // rows the run never reached. Adopting them marks people seen who have no
  // file, and nothing ever revisits that.
  it('refuses rows the run never reached', () => {
    const text =
      `User ID,Resume\r\n111,${D}\r\n222,"${RESUME_STATUS.NOT_REACHED}"\r\n` +
      `333,"${RESUME_STATUS.NOT_REACHED}"\r\n`;
    expect(userIdsFromCsv(text)).toEqual(['111']);
  });

  it('refuses rows with no resume, no id, locked, dry run or failed', () => {
    const text =
      `User ID,Resume\r\n111,${RESUME_STATUS.NO_RESUME}\r\n222,${RESUME_STATUS.NO_ID}\r\n` +
      `333,${RESUME_STATUS.LOCKED}\r\n444,${RESUME_STATUS.DRY_RUN}\r\n` +
      '555,failed: network error\r\n';
    expect(userIdsFromCsv(text)).toEqual([]);
  });

  it('refuses rows with an empty Resume cell', () => {
    expect(userIdsFromCsv(`User ID,Resume\r\n111,\r\n222,${D}\r\n`)).toEqual(['222']);
  });

  // T3: a truncated row is not an empty cell - `row[statusIndex]` is undefined
  // rather than '', so the `?.` guards are what stand between a short row and a
  // TypeError that would abort the whole import. The consequence of getting the
  // filter wrong here is permanent: adopt someone with no file and nothing ever
  // fetches them again.
  describe('rows shorter than the header', () => {
    it('adopts nobody from a row that stops before the Resume column', () => {
      const text = `User ID,Resume Filename,Resume\r\n111,${D}\r\n222,file.pdf,${D}\r\n`;
      // Row 1 has no Resume cell at all. It must not be adopted, and it must not
      // fall through to the filename column either - the Resume column exists.
      expect(userIdsFromCsv(text)).toEqual(['222']);
    });

    it('adopts nobody from a row that stops before the Resume Filename column', () => {
      // No Resume column at all, so the filename fallback decides - and a row
      // that never reaches that cell offers no proof a file landed.
      const text = 'Name,User ID,Resume Filename\r\nJane Doe,111\r\nJohn Doe,222,file.pdf\r\n';
      expect(userIdsFromCsv(text)).toEqual(['222']);
    });

    it('survives a row that stops before the User ID column', () => {
      const text = `Name,User ID,Resume\r\nJane Doe\r\nJohn Doe,222,${D}\r\n`;
      expect(() => userIdsFromCsv(text)).not.toThrow();
      expect(userIdsFromCsv(text)).toEqual(['222']);
    });
  });

  it('round-trips a CSV this extension wrote', () => {
    const base = { jobId: '9100001', jobTitle: 'Platform Engineer' };
    const text = toCsv([
      { ...base, name: 'Jane Doe', userId: '111', resumeFilename: 'Jane Doe-111-9100001.pdf',
        resumeStatus: RESUME_STATUS.DOWNLOADED },
      { ...base, name: 'John Doe', userId: '222', resumeStatus: RESUME_STATUS.NOT_REACHED },
      { ...base, name: 'Jo Doe', userId: '333', resumeStatus: RESUME_STATUS.ALREADY },
    ]);
    expect(userIdsFromCsv(text)).toEqual(['111', '333']);
  });

  describe('a CSV written before the Resume column existed', () => {
    it('adopts rows that name a file on disk', () => {
      const text =
        'Name,User ID,Resume Filename\r\nJane Doe,111,Jane Doe-111-9100001.pdf\r\n' +
        'John Doe,222,\r\n';
      expect(userIdsFromCsv(text)).toEqual(['111']);
    });

    it('adopts nobody when neither column is present', () => {
      expect(userIdsFromCsv('Name,User ID\r\nJane Doe,111\r\n')).toEqual([]);
    });
  });
});

describe('formatDate', () => {
  it('reads the Unix seconds Wellfound sends as a date', () => {
    expect(formatDate(1786465883)).toBe('2026-08-11');
  });

  it('keeps a bare date, which carries no timezone to convert from', () => {
    expect(formatDate('2026-08-01')).toBe('2026-08-01');
  });

  it('reads an ISO instant on the reader\u2019s clock, not on UTC\u2019s', () => {
    expect(formatDate('2026-08-01T10:00:00Z')).toBe('2026-08-01');
    // The case that produced the bug: 19:23 local on the 11th is the 12th in
    // UTC, and the Applied At column must say the day the reader would name.
    expect(formatDate('2026-08-12T02:23:55.586Z')).toBe('2026-08-11');
  });

  it('reads a Unix stamp late in the local evening as the local day', () => {
    // 19:23 local on the 11th, which is the 12th in UTC. Both the millisecond
    // stamp and the Unix-seconds one must read as the reader's own day.
    const evening = Date.parse('2026-08-12T02:23:55.586Z');
    expect(formatDate(evening)).toBe('2026-08-11');
    expect(formatDate(Math.floor(evening / 1000))).toBe('2026-08-11');
  });

  it('is empty for null, undefined, blank and nonsense', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate('not a date')).toBe('');
  });
});

describe('the columns the field run found wrong', () => {
  const row = {
    name: 'Jane Doe',
    userId: '7700001',
    location: 'San Francisco',
    submittedAt: 1786465883,
  };

  it('prints a date in Applied At, never the raw timestamp', () => {
    const line = toCsv([row]).split(String.fromCharCode(13, 10))[1];
    expect(line).toContain('2026-08-11');
    expect(line).not.toContain('1786465883');
  });

  // This used to hand toCsv a `location` that was already a string and then
  // assert the output was not '[object Object]' - an assertion no change to
  // normalize.js could ever have made fail, because normalize.js was not in the
  // picture. The flattening is what is on trial, so the raw node Wellfound sends
  // is what goes in.
  it('prints the location as a city, never as [object Object]', () => {
    const csv = toCsv([
      normalizeNode(
        {
          id: 'JP7700001',
          currentApplication: { submittedAt: 1786465883 },
          recruitCandidate: {
            candidate: {
              userId: 7700001,
              name: 'Jane Doe',
              currentLocation: {
                __typename: 'Location',
                id: '1',
                name: 'San Francisco',
                country: 'United States',
                state: 'California',
              },
            },
          },
        },
        { jobId: '9100001', jobTitle: 'Backend Engineer' },
      ),
    ]);
    // The data row, not the header - 'Location' is a column name up there.
    const line = csv.split('\r\n')[1];
    expect(line).not.toContain('[object Object]');
    expect(line).toContain('San Francisco');
    // The rest of the object must not leak into the cell alongside the city.
    expect(line).not.toContain('__typename');
    expect(line).not.toContain('California');
  });

  it('has no Headline column, which Wellfound never populates', () => {
    expect(CSV_COLUMNS.map((c) => c.header)).not.toContain('Headline');
  });
});

describe('the accept columns', () => {
  it('appends Accept and Accepted At after every existing column', () => {
    const headers = CSV_COLUMNS.map((c) => c.header);
    expect(headers.slice(-2)).toEqual(['Accept', 'Accepted At']);
    // Nothing already there moved.
    expect(headers.indexOf('Resume')).toBe(headers.length - 3);
  });

  it('is a distinct word for every outcome the accept pass can reach', () => {
    const values = Object.values(ACCEPT_STATUS);
    expect(new Set(values).size).toBe(values.length);
  });

  // The refusal this file exists to make loud. Accepting someone with no
  // captured resume forfeits that resume forever - see
  // .superpowers/sdd/2026-08-11-wellfound-applicant-exporter/accept-plan.md,
  // "Accepting is destructive to this extension's data source". The cell must
  // read as an instruction, not sit blank.
  describe('the no-resume refusal', () => {
    it('names the refusal in words a reader can act on, not a blank cell', () => {
      expect(ACCEPT_STATUS.NO_RESUME).not.toBe('');
      expect(ACCEPT_STATUS.NO_RESUME.toLowerCase()).toContain('refused');
      expect(ACCEPT_STATUS.NO_RESUME.toLowerCase()).toContain('resume');
    });

    it('writes the refusal into the Accept cell of the CSV, never a blank', () => {
      const row = toCsv([
        { userId: '999', name: 'No Resume Guy', acceptStatus: ACCEPT_STATUS.NO_RESUME },
      ]).split('\r\n')[1];
      expect(row).toContain('refused');
      // Guards against a blank Accept cell being followed only by an empty
      // Accepted At cell with no refusal word anywhere on the row.
      expect(row).not.toMatch(/,,\r?$/);
    });
  });

  it('distinguishes accepted this run from accepted on an earlier run', () => {
    expect(ACCEPT_STATUS.ACCEPTED).not.toBe(ACCEPT_STATUS.ALREADY);
  });

  it('distinguishes a run that never intended to accept from one that stopped short', () => {
    expect(ACCEPT_STATUS.NOT_ACCEPTING).not.toBe(ACCEPT_STATUS.NOT_REACHED);
  });

  it('reports a failed accept with its reason, like the Resume column does', () => {
    expect(acceptFailure('send never confirmed')).toBe('failed: send never confirmed');
  });

  it('round-trips accept status and timestamp through the CSV', () => {
    const csv = toCsv([
      {
        userId: '111',
        name: 'Jane Doe',
        acceptStatus: ACCEPT_STATUS.ACCEPTED,
        acceptedAt: '2026-08-12 14:23:55',
      },
    ]);
    const row = csv.split('\r\n')[1];
    expect(row).toContain('accepted');
    expect(row).toContain('2026-08-12 14:23:55');
  });
});

describe('formatDateTime', () => {
  it('keeps local prose from the ledger as it stands', () => {
    expect(formatDateTime('2026-08-12 14:23:55')).toBe('2026-08-12 14:23:55');
  });

  it('is empty for null, undefined and blank', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDateTime('')).toBe('');
  });

  it('never renders a raw Unix timestamp - the defect this project already shipped once', () => {
    const text = formatDateTime(1786465883);
    expect(text).not.toBe('1786465883');
    expect(text).toContain('2026-08-11');
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('reads an ISO instant on the reader’s clock, with a time attached', () => {
    const text = formatDateTime('2026-08-12T02:23:55.586Z');
    expect(text).toContain('2026-08-11');
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
