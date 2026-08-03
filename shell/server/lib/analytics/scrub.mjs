// Scrubbing error text before it is stored, shown or exported.
//
// A pageview's path has its query string stripped at ingest because query strings carry tokens and
// order references belonging to the SITE's own users. Error messages, sources and stack traces had
// no such treatment, and they carry the same things and worse: a failed fetch prints the whole URL
// it tried, an auth error prints the token it was given, and a stack trace prints both plus the
// file paths of whoever built the app.
//
// This is deliberately blunt. A false positive costs a redacted string in a log; a false negative
// puts one customer's secret in another customer's export.

// Ordered most specific first, so a bearer token is labelled as one rather than caught by the
// generic long-string rule.
const PATTERNS = [
  // Authorization headers and bearer tokens. The separator is OPTIONAL because the commonest form
  // in the wild is `Authorization: Bearer <token>` — a space, not a colon, immediately before the
  // value — and requiring one meant the single most likely secret in a stack trace went through
  // untouched.
  [/\b(bearer|authorization)\b\s*:?\s*(bearer\s+)?["']?[\w.\-]{16,}["']?/gi, "$1 [redacted]"],
  [/\btoken\b\s*[:=]\s*["']?[\w.\-]{12,}["']?/gi, "token [redacted]"],
  // Common API key shapes: sk-…, pk_live_…, ghp_…, xoxb-…, AKIA…, JWTs.
  [/\b(sk|pk|rk)[-_](live|test)?[-_]?[A-Za-z0-9]{16,}/g, "[redacted-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted-key]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-key]"],
  // Segments deliberately short: a real JWT's are far longer, and a scrubber that only catches
  // well-formed ones is a scrubber that misses the malformed one carrying the session.
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, "[redacted-jwt]"],
  // Anything that calls itself a secret, key, password or token and is then assigned a value.
  [/\b(api[_-]?key|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"',;)}]{6,}["']?/gi, "$1=[redacted]"],
  // Email addresses belonging to the site's own users.
  [/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, "[redacted-email]"],
  // IPv4 addresses.
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]"],
  // Connection strings.
  [/\b\w+:\/\/[^\s:@/]+:[^\s@/]+@/g, "[redacted-credentials]@"],
];

/**
 * A URL with its query string and credentials removed, keeping enough to be useful.
 *
 * `https://api.example.com/v1/orders?token=abc&email=x` becomes
 * `https://api.example.com/v1/orders` — which still says what failed without saying who it failed
 * for.
 */
function stripUrlQueries(text) {
  return String(text).replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (match) => {
    try {
      const url = new URL(match);
      url.search = "";
      url.hash = "";
      url.username = "";
      url.password = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return match.split("?")[0].split("#")[0];
    }
  });
}

/**
 * Scrub one piece of error text.
 *
 * Returns null for empty input so callers can store null rather than an empty string, which reads
 * as "there was a message and it was blank" rather than "there was no message".
 */
export function scrubText(value, { max = 4_000 } = {}) {
  if (value == null) return null;
  let text = String(value);
  if (!text.trim()) return null;
  text = stripUrlQueries(text);
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text.slice(0, max);
}

// The three fields an error event carries, each with its own sensible cap.
export function scrubErrorFields({ message, source, stack }) {
  return {
    message: scrubText(message, { max: 500 }),
    source: scrubText(source, { max: 300 }),
    stack: scrubText(stack, { max: 4_000 }),
  };
}

/**
 * A stable label for grouping errors that are "the same problem".
 *
 * Digits, hashes and quoted values are replaced so that "Cannot read x of undefined at line 42"
 * and the same error at line 91 group together. This is what survives the raw-event prune, so it
 * has to be both stable and free of anything identifying.
 */
export function errorSignature(message) {
  const scrubbed = scrubText(message, { max: 300 });
  if (!scrubbed) return "Unknown error";
  return scrubbed
    .replace(/["'`][^"'`]{0,80}["'`]/g, "'…'")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200) || "Unknown error";
}
