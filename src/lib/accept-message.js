// The grammar of the outbound accept message, and its only owner.
//
// Accepting a candidate is not a status toggle: Wellfound's reviewer sends
// this text to the candidate under the operator's name. The wording is
// supplied by the operator, stored as configuration, and substituted per
// candidate before every send. Composing it and guarding it are two halves
// of one contract, so both live here rather than being trusted to whatever
// caller happens to type into the composer.

// Byte for byte from the operator's message. `We've`, `We're` and `we'd` use
// typographic apostrophes (U+2019); `We'll` uses a straight one. Reproduce
// exactly - do not normalise the punctuation.
export const DEFAULT_MESSAGE = `Hey [first_name],

Thanks so much for applying for the [role_name] role, really appreciate you taking the time to apply.

We’ve added you to our network and will reach out when we come across a role that feels like a great fit. We’re helping some of the fastest-growing startups build their teams, and we’d love to connect you with the right opportunity when it comes up. We'll be in touch soon, cheers!`;

// Every token this grammar knows, in one place, so composeMessage and the
// leftover-token guard below agree by construction rather than by convention.
export const TOKENS = {
  first_name: 'firstName',
  role_name: 'roleName',
};

// Any `[a-z_]+` bracket token still present after substitution means a value
// was missing from the record, not just empty - composeMessage always
// resolves first_name (even to '') and role_name, so a survivor here is a
// token this grammar does not know about, or a caller that skipped
// substitution. Either way the message must never be sendable.
const LEFTOVER_TOKEN = /\[[a-z_]+\]/;

// Marks where a token slot was in the template, keyed by token name. Token
// slots are swapped for markers first, and only that intermediate result is
// checked for leftover bracket tokens below - catching an unknown template
// token such as [typo_name] - before candidate values are dropped into the
// markers' places. Because the guard runs before candidate text is inserted,
// a candidate whose own name happens to read "[role_name]" can never have
// that text mistaken for a second token: the values go in after the only
// scan that matters, so nothing gets re-substituted.
function marker(token) {
  return 'TOKEN_MARKER_' + token + '_END';
}

function tokenizeTemplate(template) {
  const pattern = new RegExp(
    Object.keys(TOKENS)
      .map((token) => `\\[${token}\\]`)
      .join('|'),
    'g'
  );
  return template.replace(pattern, (match) => marker(match.slice(1, -1)));
}

function fillMarkers(tokenized, values) {
  let message = tokenized;
  for (const [token, field] of Object.entries(TOKENS)) {
    message = message.split(marker(token)).join(values[field]);
  }
  return message;
}

// Builds the exact text that will be sent. `firstName` missing, empty, or
// whitespace-only drops the name from the greeting without leaving the space
// before the comma stranded - `Hey [first_name],` must become `Hey,`, never
// `Hey ,`. `roleName` is never expected to be missing (it is the job the run
// is walking) but is coerced the same way for safety.
//
// Throws if any `[a-z_]+` bracket token survives substitution: a message
// that still contains a literal token must never be sendable.
export function composeMessage({ template = DEFAULT_MESSAGE, firstName, roleName } = {}) {
  const first = String(firstName ?? '').trim();
  const role = String(roleName ?? '').trim();

  const tokenized = tokenizeTemplate(template);
  if (LEFTOVER_TOKEN.test(tokenized)) {
    throw new Error(`accept-message: unresolved token survived substitution: ${tokenized.match(LEFTOVER_TOKEN)[0]}`);
  }

  let message = fillMarkers(tokenized, { firstName: first, roleName: role });

  // Dropping the name can strand the space that separated it from the comma
  // in `Hey [first_name],` -> `Hey ,`. Collapse only that specific pattern:
  // one or more spaces immediately before a comma.
  if (!first) {
    message = message.replace(/ +,/g, ',');
  }

  return message;
}
