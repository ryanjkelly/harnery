/**
 * Shared failure-text extraction for the adapter spawn adapters.
 *
 * A vendor CLI prints its banner, resolved config, and startup warnings first,
 * and the reason it actually failed last. Every adapter used to keep the FIRST
 * 500 characters of the transcript, which reliably preserved the banner and
 * discarded the answer: a child that died with "your workspace is out of
 * credits" reported a cosmetic startup warning instead.
 *
 * Two rules follow. Keep the tail. Include both streams, because which one
 * carries the reason varies by vendor and by failure.
 */

const DEFAULT_MAX_CHARS = 500;

/** Bounded failure text from a finished child, tail-preserving. */
export function vendorFailureText(
  raw: { stdout?: string; stderr?: string },
  maxChars = DEFAULT_MAX_CHARS,
): string {
  const parts = [raw.stderr, raw.stdout]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part);
  if (parts.length === 0) return "";
  // Both streams, stderr first, so a reason on the unexpected stream survives.
  const combined = parts.join("\n");
  return combined.length > maxChars ? `…${combined.slice(-maxChars)}` : combined;
}

// A 429 or 5xx status, but only where it sits in HTTP-status CONTEXT — not any
// digits that merely happen to fall in that range. A bare-number match treats a
// line number ("at line 500"), an item count ("got 429 items"), or a duration
// ("after 502 seconds") as an upstream refusal, which wrongly withholds a charge
// for a failure that was entirely our code. Three recognized shapes:
//   1. after an "HTTP" label:  "HTTP 429", "HTTP/1.1 503 Service Unavailable"
//   2. after a "status" label: "status 500", "status: 429", "status code 502"
//   3. a bare status line:     "503 Service Unavailable" (code at line start,
//      then a reason phrase) — the classic "<code> <Reason-Phrase>" shape.
// The trailing `(?![0-9])` and the label/line-start anchors also keep a status
// embedded in a longer number ("4295"/"5031") out. All 5xx are server-side; 429
// is the only 4xx that means "reached and refused, retry later".
const STATUS = "(?:429|5[0-9]{2})";
const UPSTREAM_STATUS = new RegExp(
  `(?:\\bHTTP\\b[/0-9. ]*|\\bstatus(?:\\s*code)?\\b[\\s:=]*)${STATUS}(?![0-9])` +
    `|(?:^|\\n)\\s*${STATUS}\\s+[A-Za-z]`,
  "i",
);
// Explicit vendor wording for the same conditions when a numeric status is
// absent. Deliberately short — see isUpstreamFailureText.
const UPSTREAM_PHRASES =
  /circuit[ _-]?open|service unavailable|too many requests|rate[ _-]?limit|overloaded|bad gateway|gateway time-?out|internal server error/i;

/**
 * Whether failure text names an UPSTREAM refusal — the vendor was reached and
 * refused (a 5xx/429 status or circuit-open wording), as opposed to a work
 * failure (the model ran and produced a wrong or incomplete result).
 *
 * There is no structural upstream signal the way ENOENT structurally marks a
 * missing binary, so this is the one text match in the classifier. It is kept
 * SHORT and documented on purpose: a per-vendor regex zoo would rot, and a
 * false positive here wrongly withholds a charge, so both the phrase list and
 * the numeric match stay tight — the number must sit in HTTP-status context, not
 * merely fall in the 429/5xx range. Anything it does not match falls through to
 * a charged work failure.
 */
export function isUpstreamFailureText(text: string): boolean {
  return UPSTREAM_STATUS.test(text) || UPSTREAM_PHRASES.test(text);
}
