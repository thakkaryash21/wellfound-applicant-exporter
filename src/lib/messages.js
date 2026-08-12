// The only runtime messaging in this extension is panel -> content script.
// The panel imports these; bridge.js and collector.js are classic content
// scripts and cannot import, so they carry the same literals inline.
export const CX = {
  LIST_JOBS: 'CX_LIST_JOBS',
  FETCH_PAGE: 'CX_FETCH_PAGE',
  // A cheap readiness probe: which job's applicants query is registered on this
  // page? Answers `{ jobId }` or null - never a bare yes, because a stale
  // document mid-navigation can answer yes correctly and take the run down with
  // it. It touches no network, so polling it costs Wellfound nothing.
  QUERY_READY: 'CX_QUERY_READY',
};
