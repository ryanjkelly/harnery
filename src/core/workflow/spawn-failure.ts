/**
 * Shared failure-text extraction for the harness spawn adapters.
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
