// MAIN world. Talks to the page's own Apollo client so every request carries
// Wellfound's signature headers. Never constructs a query or its variables.
// Message type strings mirror src/lib/messages.js (CX.LIST_JOBS, "FETCH_PAGE"
// is content-script-only). This is a classic script, not a module, so the
// strings are duplicated inline rather than imported.
(() => {
  const OP = 'RecruitJobListingApplicants';

  function client() {
    const c = window.__APOLLO_CLIENT__;
    if (!c) throw new Error('Wellfound app not loaded on this page');
    return c;
  }

  function liveQuery() {
    const queries = [...client().getObservableQueries().values()];
    const found = queries.find((q) => {
      const def = q.options?.query?.definitions?.[0];
      return def?.name?.value === OP;
    });
    if (!found) throw new Error(`${OP} is not active yet`);
    return found;
  }

  // The Apollo cache, reduced to the job list the panel shows. Pure: the whole
  // of what listJobs decides, with the client call left outside it.
  function listJobsFrom(snapshot) {
    return Object.values(snapshot ?? {})
      .filter((v) => v && v.__typename === 'JobListing' && v.id && v.title)
      .map((v) => ({
        jobId: String(v.id),
        title: v.title,
        actionableCount: v.actionableApplicantsCount ?? null,
        draft: Boolean(v.draft),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  function listJobs() {
    return listJobsFrom(client().cache.extract());
  }

  // The UI's own variables with only the three this extension owns replaced.
  // Deep-copied first, because the object belongs to the live query and Apollo
  // is still reading it. Everything else - the recruiter's filters, sort and
  // whatever Wellfound adds next - is carried through untouched.
  // `first` is the wire's name for the page size - Relay's convention, and
  // Wellfound's variable. It is spelled `pageSize` everywhere inside this
  // extension and translated here, at the one boundary that owns the wire.
  function mergeVariables(base, { jobId, pageSize, after }) {
    return {
      ...JSON.parse(JSON.stringify(base ?? {})),
      jobId: String(jobId),
      first: pageSize,
      after: after ?? null,
    };
  }

  // One GraphQL response, reduced to a page. The connection arrives as
  // `edges: [{ __typename, node }]`; every consumer downstream wants the nodes,
  // so the unwrap happens here and nowhere else.
  function unwrapPage(data) {
    const listing = data?.talent?.viewer?.currentStartup?.recruit?.jobListing;
    if (!listing) throw new Error('Unexpected response shape');
    const conn = listing.applicants;
    return {
      jobTitle: listing.title ?? null,
      edges: conn.edges.map((e) => e.node),
      endCursor: conn.pageInfo.endCursor,
      hasNextPage: Boolean(conn.pageInfo.hasNextPage),
    };
  }

  async function fetchPage({ jobId, pageSize, after }) {
    const q = liveQuery();
    const variables = mergeVariables(q.options.variables, { jobId, pageSize, after });
    const result = await client().query({
      query: q.options.query,
      variables,
      fetchPolicy: 'network-only',
    });
    if (result.errors?.length) throw new Error(result.errors[0].message);
    return {
      ...unwrapPage(result.data),
      // Whichever tab the recruiter has open. We copy the UI's filters rather
      // than forcing one, so the export follows what they are looking at.
      bucket: variables.filters?.status ?? null,
    };
  }

  // Readiness, and for WHICH job. A bare boolean was answerable - truthfully -
  // by the document the browser was about to throw away, so the panel would
  // start fetching against a tab whose content script was seconds from
  // vanishing. The job comes from the live query's own variables rather than
  // from the URL, because the variables are what the Apollo client will
  // actually serve.
  function queryReady() {
    try {
      const jobId = liveQuery().options?.variables?.jobId;
      return jobId == null ? null : { jobId: String(jobId) };
    } catch {
      return null;
    }
  }

  const handlers = {
    LIST_JOBS: async () => listJobs(),
    FETCH_PAGE: (p) => fetchPage(p),
    QUERY_READY: async () => queryReady(),
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== 'wfx-cs' || !handlers[msg.type]) return;
    try {
      const data = await handlers[msg.type](msg.payload);
      window.postMessage({ source: 'wfx-page', id: msg.id, ok: true, data }, '*');
    } catch (error) {
      window.postMessage(
        { source: 'wfx-page', id: msg.id, ok: false, error: String(error.message || error) },
        '*',
      );
    }
  });

  window.postMessage({ source: 'wfx-page', id: 'ready', ok: true, data: 'ready' }, '*');

  // The test seam, and the reason this file has none of the usual ones. MV3
  // will not run a module in the MAIN world, so `export` is not available here
  // and never will be. Instead the module hands its logic to a container that
  // only a harness creates: `__WFX_COLLECTOR__` is defined by nothing in this
  // extension and by nothing on Wellfound's page, so in a browser this branch
  // is dead code and the file stays a plain classic script. A test evaluates
  // the file's own text with the container pre-defined and gets the real
  // functions back - not a copy of them, and not a rewrite of the file.
  if (globalThis.__WFX_COLLECTOR__) {
    Object.assign(globalThis.__WFX_COLLECTOR__, {
      listJobsFrom,
      mergeVariables,
      unwrapPage,
      listJobs,
      fetchPage,
      queryReady,
      handlers,
    });
  }
})();
