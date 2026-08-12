import { formatEntry } from '../lib/trace.js';

// The one place in src/ where the console ban is lifted, and only while the user
// has ticked "Log run detail to the console" in Advanced. Off by default, off
// again every time the panel is opened, and it still cannot see an applicant
// name or a resume URL: everything printed here has already been through the
// trace's whitelist, so a toggle that leaks PII is not a state this can reach.
//
// (run-controller.js holds the other exception - a render failure - which is a
// single line rather than a stream.)

let enabled = false;

export function setVerbose(on) {
  enabled = Boolean(on);
}

export function isVerbose() {
  return enabled;
}

export function consoleSink(entry, detail) {
  if (!enabled) return;
  const extra = detail && Object.keys(detail).length ? detail : '';
  // eslint-disable-next-line no-console
  console.log(`[wfx] ${formatEntry(entry)}`, extra);
}
