// Wellfound hands most link fields back as a path - `/link/{userId}/{token}/
// resume_url` - and only `angellistUrl` absolute. `chrome.downloads.download`
// requires an absolute URL, and an extension page is no base for a path, so a
// relative resumeUrl fails every download in a run. A module constant, not
// `location`: this module is pure and runs in contexts that have no document.
const BASE = 'https://wellfound.com';

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

export function absoluteUrl(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  // Already absolute - handed back byte for byte, because a signed S3 link's
  // query string must not be re-encoded on its way to the downloader.
  if (ABSOLUTE.test(text)) return text;
  try {
    return new URL(text, BASE).href;
  } catch {
    // Not a path and not a URL: nothing honest to build from it.
    return null;
  }
}

// The one field that reads better as a name than as an object. Live shape is
// { __typename, id, name, country, state }; `name` alone is the city a recruiter
// reads, and the whole object stringifies to [object Object] in the CSV.
export function locationName(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  const name = value.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}

export function normalizeNode(node, ctx) {
  const rc = node?.recruitCandidate ?? {};
  const c = rc.candidate ?? {};
  return {
    applicantId: node?.id ?? null,
    userId: c.userId != null ? String(c.userId) : null,
    name: c.name ?? null,
    // `headline` is deliberately absent: Wellfound returns null for it on every
    // applicant sampled, and a column empty in every row of every export is
    // noise in the artifact.
    location: locationName(c.currentLocation),
    yearsExperience: c.yearsExperienceInRole ?? null,
    linkedinUrl: absoluteUrl(c.linkedinUrl),
    githubUrl: absoluteUrl(c.githubUrl),
    website: absoluteUrl(c.website),
    wellfoundUrl: absoluteUrl(c.angellistUrl),
    usAuthorized: c.usAuthorized ?? null,
    resumeUrl: absoluteUrl(c.resumeUrl),
    // Filled in by the runner once the file lands, so the CSV row can point at
    // the file on disk. Null for anyone whose resume was not downloaded.
    resumeFilename: null,
    // Set explicitly by the runner on every branch, so a blank Resume Filename
    // cell can be read as "already had it" rather than "resume missing".
    resumeStatus: null,
    submittedAt: node?.currentApplication?.submittedAt ?? null,
    masked: Boolean(rc.masked || rc.concealed),
    jobId: ctx.jobId,
    jobTitle: ctx.jobTitle,
  };
}
