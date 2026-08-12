// The only module that talks to Wellfound, tested against the shape captured
// live from Wellfound. It ships as a classic script - MV3 will not run a module
// in the MAIN world - so it is loaded the way Chrome loads it and asked for its
// own functions rather than imported. See tests/helpers/classic-script.js.
import { describe, it, expect } from 'vitest';
import { loadClassicScript, createFakeWindow } from './helpers/classic-script.js';
import { capturedResponse, applicantNode, OP_NAME } from './helpers/captured-shape.js';

// A stand-in for the page's Apollo client. `queries` are what
// getObservableQueries() returns; each carries the options a real
// ObservableQuery carries, because that is where the collector reads both the
// document and the variables from.
function fakeApollo({ variables = { filters: { status: 'inbox' } }, snapshot = {}, response } = {}) {
  const calls = [];
  const query = { definitions: [{ name: { value: OP_NAME } }] };
  const observable = { options: { query, variables } };
  return {
    calls,
    client: {
      getObservableQueries: () => new Map([['q1', observable]]),
      cache: { extract: () => snapshot },
      async query(args) {
        calls.push(args);
        return response ?? { data: capturedResponse() };
      },
    },
    observable,
  };
}

function load({ apollo } = {}) {
  const fakeWindow = createFakeWindow();
  const { exposed } = loadClassicScript('src/content/collector.js', {
    globals: { window: fakeWindow.window, __APOLLO_CLIENT__: apollo },
    expose: '__WFX_COLLECTOR__',
  });
  // The MAIN world script reads the client off `window`, so it lives there too.
  fakeWindow.window.__APOLLO_CLIENT__ = apollo;
  return { ...exposed, ...fakeWindow };
}

describe('unwrapPage', () => {
  it('hands back the nodes, not the edges that wrap them', () => {
    const { unwrapPage } = load();
    const page = unwrapPage(
      capturedResponse({
        nodes: [applicantNode({ userId: '9100001' }), applicantNode({ userId: '9100002' })],
      }),
    );
    // The regression this exists for: if the unwrap is dropped, every element
    // is `{ __typename, node }`, normalize reads userId: null for everyone, and
    // the run downloads nothing while reporting success.
    expect(page.edges).toHaveLength(2);
    expect(page.edges.map((n) => n.recruitCandidate.candidate.userId)).toEqual([
      '9100001',
      '9100002',
    ]);
    expect(page.edges.every((n) => !('node' in n))).toBe(true);
  });

  it('reads the cursor out of pageInfo, which is nested under applicants', () => {
    const { unwrapPage } = load();
    const page = unwrapPage(capturedResponse({ endCursor: 'cursor-2', hasNextPage: true }));
    expect(page).toMatchObject({ endCursor: 'cursor-2', hasNextPage: true });
  });

  it('says hasNextPage is false rather than undefined when the key is missing', () => {
    const { unwrapPage } = load();
    const data = capturedResponse();
    delete data.talent.viewer.currentStartup.recruit.jobListing.applicants.pageInfo.hasNextPage;
    // The pager loops while this is true; undefined would end the run silently
    // rather than loudly, so it is coerced.
    expect(unwrapPage(data).hasNextPage).toBe(false);
  });

  it('carries the job title through, and null when Wellfound omits it', () => {
    const { unwrapPage } = load();
    expect(unwrapPage(capturedResponse({ title: 'Backend Engineer' })).jobTitle).toBe(
      'Backend Engineer',
    );
    const untitled = capturedResponse();
    untitled.talent.viewer.currentStartup.recruit.jobListing.title = undefined;
    expect(unwrapPage(untitled).jobTitle).toBe(null);
  });

  it('refuses a response with no jobListing rather than reading through null', () => {
    const { unwrapPage } = load();
    const data = capturedResponse();
    data.talent.viewer.currentStartup.recruit.jobListing = null;
    expect(() => unwrapPage(data)).toThrow(/Unexpected response shape/);
    expect(() => unwrapPage({})).toThrow(/Unexpected response shape/);
    expect(() => unwrapPage(undefined)).toThrow(/Unexpected response shape/);
  });
});

describe('listJobsFrom', () => {
  const snapshot = {
    'JobListing:2': { __typename: 'JobListing', id: 2, title: 'Backend Engineer' },
    'JobListing:1': {
      __typename: 'JobListing',
      id: 1,
      title: 'Android Engineer',
      actionableApplicantsCount: 4,
      draft: true,
    },
    'RecruitCandidate:9100001': { __typename: 'RecruitCandidate', id: 9100001, title: 'Aardvark' },
    'JobListing:3': { __typename: 'JobListing', id: 3 },
    ROOT_QUERY: { __typename: 'Query' },
    'JobListing:null': null,
  };

  it('takes only JobListing entries that can name themselves', () => {
    const { listJobsFrom } = load();
    // The cache holds every object the page has ever seen. A candidate with a
    // `title` is not a job, and a listing with no title cannot be shown.
    expect(listJobsFrom(snapshot).map((j) => j.jobId)).toEqual(['1', '2']);
  });

  it('sorts by title, so the list does not reshuffle between runs', () => {
    const { listJobsFrom } = load();
    // Cache key order is Apollo's business and changes as the page is used.
    expect(listJobsFrom(snapshot).map((j) => j.title)).toEqual([
      'Android Engineer',
      'Backend Engineer',
    ]);
  });

  it('reports a missing applicant count as null, never as a number', () => {
    const { listJobsFrom } = load();
    const [android, backend] = listJobsFrom(snapshot);
    // Wellfound only populates the count once an applicant list has been
    // visited. Absent means unknown, and the panel says so; 0 would claim the
    // job has no applicants.
    expect(android.actionableCount).toBe(4);
    expect(backend.actionableCount).toBe(null);
    expect(android.draft).toBe(true);
    expect(backend.draft).toBe(false);
  });

  it('stringifies the id, because the ledger is keyed on it', () => {
    const { listJobsFrom } = load();
    expect(listJobsFrom(snapshot).map((j) => j.jobId)).toEqual(['1', '2']);
  });

  it('answers with nothing for an empty cache instead of throwing', () => {
    const { listJobsFrom } = load();
    expect(listJobsFrom({})).toEqual([]);
  });
});

describe('queryReady', () => {
  it('names the job the live query is actually serving', () => {
    // Readiness used to be a bare boolean, which the document the browser was
    // about to discard could answer truthfully. The jobId comes from the live
    // query's own variables rather than the URL, because the variables are what
    // Apollo will serve.
    const apollo = fakeApollo({ variables: { jobId: 9100001, filters: { status: 'inbox' } } });
    const { queryReady } = load({ apollo: apollo.client });
    expect(queryReady()).toEqual({ jobId: '9100001' });
  });

  it('is not ready when the applicants query is not on the page yet', () => {
    const apollo = fakeApollo();
    apollo.client.getObservableQueries = () => new Map();
    const { queryReady } = load({ apollo: apollo.client });
    expect(queryReady()).toBe(null);
  });

  it('is not ready when there is no Apollo client at all', () => {
    const { queryReady } = load({ apollo: undefined });
    // Throwing here would leave the panel polling a page that will never
    // answer; a null is a plain "not yet".
    expect(queryReady()).toBe(null);
  });

  it('is not ready when the live query carries no jobId', () => {
    const apollo = fakeApollo({ variables: { filters: { status: 'inbox' } } });
    const { queryReady } = load({ apollo: apollo.client });
    expect(queryReady()).toBe(null);
  });
});

describe('mergeVariables', () => {
  const base = {
    jobId: '9100002',
    first: 10,
    after: 'old-cursor',
    filters: { status: 'shortlisted', locations: ['Remote'] },
    sort: 'RECENT',
  };

  it('replaces only the three it owns and leaves the recruiter filters alone', () => {
    const { mergeVariables } = load();
    // `first` on the way out: it is Wellfound's variable name, and the only
    // place in this codebase that word survives.
    expect(mergeVariables(base, { jobId: 9100001, pageSize: 50, after: 'c1' })).toEqual({
      jobId: '9100001',
      first: 50,
      after: 'c1',
      filters: { status: 'shortlisted', locations: ['Remote'] },
      sort: 'RECENT',
    });
  });

  it('sends null rather than undefined for the first page', () => {
    const { mergeVariables } = load();
    // `after: undefined` disappears from the request; a real null is what asks
    // for the start of the connection.
    expect(mergeVariables(base, { jobId: '9100001', pageSize: 50, after: undefined }).after).toBe(
      null,
    );
  });

  it('does not hand the live query own objects to the request', () => {
    const { mergeVariables } = load();
    const merged = mergeVariables(base, { jobId: '9100001', pageSize: 50, after: null });
    merged.filters.status = 'mutated';
    // Apollo is still reading `base`. A shallow copy would have shared
    // `filters` and rewritten what the UI is showing.
    expect(base.filters.status).toBe('shortlisted');
  });
});

describe('fetchPage', () => {
  it('asks with the merged variables and the live query document, off the network', async () => {
    const apollo = fakeApollo({
      variables: { jobId: '9100002', filters: { status: 'inbox' }, sort: 'RECENT' },
    });
    const { fetchPage } = load({ apollo: apollo.client });
    await fetchPage({ jobId: 9100001, pageSize: 50, after: 'c1' });
    expect(apollo.calls[0].query).toBe(apollo.observable.options.query);
    expect(apollo.calls[0].fetchPolicy).toBe('network-only');
    expect(apollo.calls[0].variables).toMatchObject({
      jobId: '9100001',
      first: 50,
      after: 'c1',
      sort: 'RECENT',
    });
  });

  it('reports the bucket the recruiter is looking at, not one of its own', async () => {
    const apollo = fakeApollo({ variables: { filters: { status: 'shortlisted' } } });
    const { fetchPage } = load({ apollo: apollo.client });
    expect((await fetchPage({ jobId: 9100001, pageSize: 50 })).bucket).toBe('shortlisted');
  });

  it('reports no bucket when the UI is filtering on something else', async () => {
    const apollo = fakeApollo({ variables: { sort: 'RECENT' } });
    const { fetchPage } = load({ apollo: apollo.client });
    expect((await fetchPage({ jobId: 9100001, pageSize: 50 })).bucket).toBe(null);
  });

  it('raises the first GraphQL error instead of unwrapping a partial response', async () => {
    const apollo = fakeApollo({
      response: { data: capturedResponse(), errors: [{ message: 'Not authorized' }] },
    });
    const { fetchPage } = load({ apollo: apollo.client });
    // Apollo answers 200 with `errors` and whatever data it managed. Reading
    // that as a page would export a truncated list as a complete one.
    await expect(fetchPage({ jobId: 9100001, pageSize: 50 })).rejects.toThrow('Not authorized');
  });

  it('refuses when the applicants query has not been opened yet', async () => {
    const apollo = fakeApollo();
    apollo.client.getObservableQueries = () => new Map();
    const { fetchPage } = load({ apollo: apollo.client });
    await expect(fetchPage({ jobId: 9100001, pageSize: 50 })).rejects.toThrow(/not active yet/);
  });

  it('says the app is not loaded when there is no Apollo client', async () => {
    const { fetchPage } = load({ apollo: undefined });
    await expect(fetchPage({ jobId: 9100001, pageSize: 50 })).rejects.toThrow(/not loaded/);
  });
});

describe('the page-side message boundary', () => {
  it('answers a FETCH_PAGE with unwrapped nodes', async () => {
    const apollo = fakeApollo();
    const page = load({ apollo: apollo.client });
    page.deliver({
      source: 'wfx-cs',
      id: 'wfx-1',
      type: 'FETCH_PAGE',
      payload: { jobId: 9100001, pageSize: 50 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reply = page.posted.find((m) => m.id === 'wfx-1');
    expect(reply).toMatchObject({ source: 'wfx-page', ok: true });
    expect(reply.data.edges[0].recruitCandidate.candidate.name).toBe('Jane Doe');
  });

  it('answers a failure as a message rather than leaving the caller waiting', async () => {
    const page = load({ apollo: undefined });
    page.deliver({ source: 'wfx-cs', id: 'wfx-2', type: 'LIST_JOBS' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.posted.find((m) => m.id === 'wfx-2')).toMatchObject({
      ok: false,
      error: 'Wellfound app not loaded on this page',
    });
  });

  it('ignores traffic that is not the bridge asking', async () => {
    const apollo = fakeApollo();
    const page = load({ apollo: apollo.client });
    const before = page.posted.length;
    page.deliver({ source: 'wfx-page', id: 'x', type: 'LIST_JOBS' });
    page.deliver({ source: 'wfx-cs', id: 'y', type: 'EVAL' });
    page.deliver({ source: 'wfx-cs', id: 'z', type: 'LIST_JOBS' }, { other: 'frame' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Only the three handler names are answerable, and only from this window.
    expect(page.posted.length).toBe(before);
  });

  it('announces itself once, so the bridge knows the MAIN world arrived', () => {
    const apollo = fakeApollo();
    const page = load({ apollo: apollo.client });
    expect(page.posted[0]).toEqual({ source: 'wfx-page', id: 'ready', ok: true, data: 'ready' });
  });
});
