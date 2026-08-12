// Fixtures built from .superpowers/sdd/2026-08-11-wellfound-applicant-exporter/
// captured-api-shape.md - the structure captured live from Wellfound's own
// Apollo client. The shape is theirs; every value here is invented.
//
// The point of this file is the connection: `edges: [{ __typename, node }]`
// with `pageInfo` nested under `applicants`. Every other fixture in this suite
// supplies the already-flattened result, which is why `edges.map(e => e.node)`
// has never once been executed by a test.
//
// The candidate fields sit under `recruitCandidate.candidate`, one level below
// `recruitCandidate`, which is what `normalize.js` reads. An earlier version of
// this file flattened that level away and so returned null for every field it
// claimed to prove. `tests/captured-shape-e2e.test.js` walks this fixture all
// the way to the CSV precisely so that mistake cannot come back.

export const OP_NAME = 'RecruitJobListingApplicants';

// `userId` defaults to a string because that is what the wire sends. Callers
// pass a number where the point is the `String()` coercion in normalize.js.
export function applicantNode({ userId = '9100001', name = 'Jane Doe' } = {}) {
  return {
    __typename: 'Applicant',
    id: `applicant-${userId}`,
    recruitCandidate: {
      __typename: 'RecruitCandidate',
      id: `rc-${userId}`,
      removal: null,
      candidate: {
        __typename: 'Candidate',
        id: `cand-${userId}`,
        candidateId: `cand-${userId}`,
        jobProfileId: `jp-${userId}`,
        userId,
        name,
        firstName: String(name).split(' ')[0],
        avatar: `/link/${userId}/tok/avatar`,
        headline: null,
        resumeUrl: `/link/${userId}/tok/resume_url`,
        currentLocation: {
          __typename: 'Location',
          id: 'loc-1',
          name: 'Remote',
          country: 'US',
          state: null,
        },
      },
    },
    currentApplication: { __typename: 'Application', id: 'app-1', submittedAt: 1786465883 },
    notes: [],
    bucket: 'inbox',
    bucketSize: 1,
    needsRelocation: false,
    shortlisted: false,
  };
}

// A whole response, down the path
// data.talent.viewer.currentStartup.recruit.jobListing.applicants.
export function capturedResponse({
  nodes = [applicantNode()],
  title = 'Backend Engineer',
  endCursor = 'cursor-1',
  hasNextPage = false,
} = {}) {
  return {
    talent: {
      __typename: 'TalentQuery',
      viewer: {
        __typename: 'Viewer',
        currentStartup: {
          __typename: 'Startup',
          recruit: {
            __typename: 'Recruit',
            jobListing: {
              __typename: 'JobListing',
              id: '9100001',
              title,
              applicants: {
                __typename: 'ApplicantConnection',
                edges: nodes.map((node) => ({ __typename: 'ApplicantEdge', node })),
                pageInfo: { __typename: 'PageInfo', endCursor, hasNextPage },
              },
            },
          },
        },
      },
    },
  };
}
