export const EARLY_STOP_PAGES = 3;

// Keyed on userId, not on Apollo's node.id. userId is the only identifier that
// survives a CSV round-trip, a filename and a move to another machine, so it is
// the one the ledger, reconciliation and imports all agree on. A record without
// one is never fresh: it cannot be named, deduped or reconciled. The runner
// reports it instead of downloading it.
//
// `allSeen` drives the early-stop streak, so it is judged only over records that
// HAVE a userId. Wellfound conceals candidates until the recruiter unlocks them,
// so a queue can genuinely open with a full page of masked applicants. Deriving
// `allSeen` from `fresh.length === 0` would call such a page fully seen, and
// three of them in a row would stop the run before it reached anybody real.
// An empty page is still fully seen: nothing follows it, and the walk has to be
// able to terminate.
export function diffPage(records, seen) {
  const identifiable = records.filter((r) => r.userId);
  const fresh = identifiable.filter((r) => !seen.has(r.userId));
  const allSeen = records.length === 0 || (identifiable.length > 0 && fresh.length === 0);
  return { fresh, allSeen };
}

// Kept as a named unit, weighed against folding its counter into the run loop.
//
// It is one implementation with one call site, which is usually the shape of an
// indirection worth removing. It survives because what it holds is a rule, not
// a number: a page counts towards the streak only when `allSeen` says so, the
// streak resets on any page with a fresh face, and `forceFullWalk` turns the
// whole thing off. Those three sit next to diffPage above, where `allSeen` is
// computed and where the reason it is not `fresh.length === 0` is written down
// - a lesson that cost a real bug, since a queue can open with a full page of
// masked applicants and three of those would have stopped the run before it
// reached anybody real. Folding the counter into runJob would put the rule
// three hundred lines from its own explanation, add two more mutable locals to
// a loop that already carries eight, and cost the tests that exercise the
// streak directly.
export function createEarlyStop({ forceFullWalk = false } = {}) {
  let streak = 0;
  return {
    observe(allSeen) {
      streak = allSeen ? streak + 1 : 0;
    },
    shouldStop() {
      return !forceFullWalk && streak >= EARLY_STOP_PAGES;
    },
  };
}
