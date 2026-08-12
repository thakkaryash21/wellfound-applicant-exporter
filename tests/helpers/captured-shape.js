// Fixtures built from .superpowers/sdd/2026-08-11-wellfound-applicant-exporter/
// captured-api-shape.md - the structure captured live from Wellfound's own
// Apollo client. The shape is theirs; every value here is invented.
//
// The point of this file is the connection: `edges: [{ __typename, node }]`
// with `pageInfo` nested under `applicants`. Every other fixture in this suite
// supplies the already-flattened result, which is why `edges.map(e => e.node)`
// has never once been executed by a test.

export const OP_NAME = 'RecruitJobListingApplicants';

export function applicantNode({ userId = 9100001, name = 'Jane Doe' } = {}) {
  return {
    __typename: 'Applicant',
    id: `applicant-${userId}`,
    recruitCandidate: {
      __typename: 'RecruitCandidate',
      userId,
      name,
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
