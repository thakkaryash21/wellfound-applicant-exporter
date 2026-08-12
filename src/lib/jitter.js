export const PACING = {
  pageMs: [2500, 7000],
  downloadMs: [1500, 4000],
  breakMs: [15000, 40000],
  breakEvery: [8, 12],
  // The two pauses either side of putting the message into the composer. Not a
  // typing simulation: nobody types the same 400 characters six hundred times,
  // so streaming it a character at a time would be a different tell rather than
  // a smaller one. What a person actually does with boilerplate is paste it and
  // glance over it, so that is what is paced - a beat while the composer opens
  // and the wording is gathered, and a beat to read it back before sending.
  // They draw from the same log-normal `sample` as everything else here; a
  // second randomness model would be its own signature.
  beforePasteMs: [1500, 5000],
  afterPasteMs: [1000, 3000],
};

// Box-Muller gives a normal draw; exponentiating it gives a log-normal shape:
// clustered below the middle with a long right tail, the way human pauses fall.
function standardNormal(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// The distribution's median sits at this fraction of the range, and SIGMA sets
// how wide the spread is. Tuned so the middle half of draws covers about a third
// of the range: a flat histogram is itself a signature, and so is a tight one.
const MEDIAN_FRACTION = 0.42;
const SIGMA = 0.75;
const MAX_ATTEMPTS = 8;

export function sample(min, max, rand = Math.random) {
  if (max <= min) return min;
  // Resample rather than clamp when a draw overshoots. Clamping piles ~12% of
  // draws onto the exact upper bound, and a spike at one value is the most
  // fingerprintable shape there is.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const shaped = MEDIAN_FRACTION * Math.exp(SIGMA * standardNormal(rand));
    if (shaped < 1) return Math.round(min + (max - min) * shaped);
  }
  return max;
}

// Abort-aware, so a stop pressed during a 40 s reading break takes effect now
// rather than when the break elapses. It resolves rather than rejects: the
// pacing is a courtesy to Wellfound, not a promise to the caller, and every
// loop that sleeps already re-reads the signal at the top of its next turn.
export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

// Inclusive of both bounds. The `+ 1` is what makes `max` reachable, and it is
// also what lets a rand() of exactly 1 land on `max + 1` - so the result is
// clamped. Math.random() never returns 1, but `rand` is injected: a test's fixed
// source, or any future one, is under no such obligation, and the value decides
// how many downloads pass before a reading break.
export function sampleInt(range, rand = Math.random) {
  const [min, max] = range;
  return Math.min(max, Math.floor(min + rand() * (max - min + 1)));
}
