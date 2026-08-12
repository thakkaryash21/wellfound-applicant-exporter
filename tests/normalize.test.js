import { describe, it, expect } from 'vitest';
import { normalizeNode, absoluteUrl, locationName } from '../src/lib/normalize.js';

const ctx = { jobId: '9100001', jobTitle: 'Backend Engineer' };

// The shapes below are Wellfound's, not ours. Two of them were confirmed
// against live responses and are deliberately awkward:
//   - submittedAt is a number, Unix seconds. It used to be an ISO string here,
//     which drove formatDate's string fast-path and never the numeric branch
//     production always takes.
//   - currentLocation is an object. It used to be a bare string, so
//     locationName() was never exercised through normalizeNode at all.
// userId's raw type was never observed - every probe coerced it - so it is
// covered in both shapes below rather than asserted as one.
function node(overrides = {}) {
  return {
    id: 'JP7700001',
    currentApplication: { submittedAt: 1786465883 },
    recruitCandidate: {
      masked: false,
      concealed: false,
      candidate: {
        userId: 7700001,
        name: 'Jane Doe',
        headline: 'Backend engineer',
        currentLocation: {
          __typename: 'Location',
          id: '1',
          name: 'Berlin',
          country: 'Germany',
          state: null,
        },
        currentRole: 'Senior Engineer',
        yearsExperienceInRole: 6,
        // Wellfound sends these four as paths, not URLs. Only angellistUrl is
        // absolute. Every fixture in this repo used to say otherwise.
        linkedinUrl: '/link/7700001/abc/linkedin_url',
        githubUrl: '/link/7700001/abc/github_url',
        website: '/link/7700001/abc/online_bio_url',
        angellistUrl: 'https://wellfound.com/u/jd',
        usAuthorized: true,
        resumeUrl: '/link/7700001/abc/resume_url',
        ...(overrides.candidate ?? {}),
      },
      ...(overrides.recruitCandidate ?? {}),
    },
    ...(overrides.node ?? {}),
  };
}

describe('normalizeNode', () => {
  it('flattens the fields the CSV and downloader need', () => {
    const out = normalizeNode(node(), ctx);
    expect(out).toMatchObject({
      applicantId: 'JP7700001',
      userId: '7700001',
      name: 'Jane Doe',
      location: 'Berlin',
      yearsExperience: 6,
      usAuthorized: true,
      jobId: '9100001',
      jobTitle: 'Backend Engineer',
    });
  });

  it('maps angellistUrl onto wellfoundUrl', () => {
    expect(normalizeNode(node(), ctx).wellfoundUrl).toBe('https://wellfound.com/u/jd');
  });

  it('resolves the relative resume path into a URL the downloader can use', () => {
    expect(normalizeNode(node(), ctx).resumeUrl).toBe(
      'https://wellfound.com/link/7700001/abc/resume_url',
    );
  });

  it('resolves every other relative link field the same way', () => {
    const out = normalizeNode(node(), ctx);
    expect(out.linkedinUrl).toBe('https://wellfound.com/link/7700001/abc/linkedin_url');
    expect(out.githubUrl).toBe('https://wellfound.com/link/7700001/abc/github_url');
    expect(out.website).toBe('https://wellfound.com/link/7700001/abc/online_bio_url');
  });

  it('returns null resumeUrl when the candidate has no resume', () => {
    const out = normalizeNode(node({ candidate: { resumeUrl: null } }), ctx);
    expect(out.resumeUrl).toBe(null);
  });

  it('marks masked candidates and still produces a record', () => {
    const out = normalizeNode(node({ recruitCandidate: { masked: true } }), ctx);
    expect(out.masked).toBe(true);
    expect(out.applicantId).toBe('JP7700001');
  });

  it('survives a missing candidate object without throwing', () => {
    const out = normalizeNode({ id: 'JP1', recruitCandidate: null }, ctx);
    expect(out.applicantId).toBe('JP1');
    expect(out.name).toBe(null);
    expect(out.userId).toBe(null);
  });

  it('survives a missing currentApplication', () => {
    expect(normalizeNode({ id: 'JP1' }, ctx).submittedAt).toBe(null);
  });

  it('carries submittedAt raw, for the CSV to format', () => {
    // The number Wellfound sends, untouched: formatting is the CSV's job, and
    // coercing here would put the decision in two places.
    expect(normalizeNode(node(), ctx).submittedAt).toBe(1786465883);
  });

  // C3: `String()` on userId is load-bearing. runner.js keys dedup on
  // `seen.has(record.userId)` and the ledger stores strings, so a numeric
  // userId that reached the record unconverted would miss on every re-run and
  // the extension would re-download everybody forever. Which type Wellfound
  // actually sends was never observed raw, so both are covered: whichever it
  // is, the coercion cannot be removed without one of these failing.
  describe('userId, whichever type Wellfound sends', () => {
    it('normalizes a numeric userId to a string', () => {
      const out = normalizeNode(node({ candidate: { userId: 7700001 } }), ctx);
      expect(out.userId).toBe('7700001');
      expect(typeof out.userId).toBe('string');
    });

    it('normalizes a string userId to the same string', () => {
      const out = normalizeNode(node({ candidate: { userId: '7700001' } }), ctx);
      expect(out.userId).toBe('7700001');
      expect(typeof out.userId).toBe('string');
    });
  });

  it('drops headline, which Wellfound returns null for on every applicant', () => {
    expect('headline' in normalizeNode(node(), ctx)).toBe(false);
  });

  it('starts resumeFilename empty for the runner to fill in', () => {
    expect(normalizeNode(node(), ctx).resumeFilename).toBe(null);
  });

  it('starts resumeStatus empty for the runner to set on every branch', () => {
    expect(normalizeNode(node(), ctx).resumeStatus).toBe(null);
  });
});

describe('absoluteUrl', () => {
  it('resolves a Wellfound path against wellfound.com', () => {
    expect(absoluteUrl('/link/1/tok/resume_url')).toBe('https://wellfound.com/link/1/tok/resume_url');
  });

  it('leaves an absolute URL byte for byte, signed query string included', () => {
    const signed = 'https://s3.amazonaws.com/r/1.pdf?X-Amz-Signature=abc%2Fdef';
    expect(absoluteUrl(signed)).toBe(signed);
  });

  it('treats null, undefined and blank as no link at all', () => {
    expect(absoluteUrl(null)).toBe(null);
    expect(absoluteUrl(undefined)).toBe(null);
    expect(absoluteUrl('   ')).toBe(null);
  });
});

describe('locationName', () => {
  it('takes the name out of the live location object', () => {
    const out = normalizeNode(
      node({ candidate: { currentLocation: { __typename: 'Location', id: '1', name: 'San Francisco', country: 'US', state: 'CA' } } }),
      ctx,
    );
    expect(out.location).toBe('San Francisco');
  });

  it('reads a plain string location as itself', () => {
    expect(locationName('Austin')).toBe('Austin');
    expect(normalizeNode(node({ candidate: { currentLocation: 'Austin' } }), ctx).location).toBe(
      'Austin',
    );
  });

  it('is null for no location and for a location object with no name', () => {
    expect(locationName(null)).toBe(null);
    expect(locationName({ __typename: 'Location', id: '1', country: 'US' })).toBe(null);
    expect(locationName({ name: '  ' })).toBe(null);
  });
});
