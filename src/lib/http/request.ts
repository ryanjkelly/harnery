/**
 * Retrying JSON-API request — the toolkit-tier HTTP primitive for host CLIs'
 * vendor clients.
 *
 * Extracted from the first embedding host, where ten vendor clients carried
 * byte-similar copies of the same loop: abort-controller timeout, retry on
 * 429/5xx with exponential backoff + jitter, `Retry-After` honored when sane,
 * vendor-specific error taxonomy applied by the caller. This module owns the
 * loop; callers keep their auth headers and error classes:
 *
 *   const r = await requestWithRetries(url, {
 *     method, body,
 *     headers: { Authorization: `ApiKey ${key}`, Accept: "application/json" },
 *     timeoutMs: this.timeoutMs,
 *     maxRetries: this.maxRetries,
 *     onResponse: ({ status }) => log(`${method} ${url} → ${status}`),
 *     networkError: (msg) => new VendorError("network_error", msg),
 *   });
 *   if (!r.ok) throw makeHttpError(r.status, url, r.text, r.headers);
 *
 * Design choices, so they survive review:
 *   - Terminal non-2xx responses RETURN (`ok: false`) rather than throw — the
 *     vendor error taxonomy belongs to the caller, not this module.
 *   - Only terminal NETWORK failures throw (after retries), because there is
 *     no response to hand back; `networkError` lets the caller keep its class.
 *   - The response body is always read (even on retried statuses) so keep-alive
 *     sockets are released.
 */

export interface RetryingResponse {
  /** `status` in the 2xx range. */
  ok: boolean;
  status: number;
  /** Response body as text; callers handle JSON parsing. */
  text: string;
  url: string;
  headers: Headers;
}

export interface RequestWithRetriesOptions {
  /** HTTP method. Default GET. */
  method?: string;
  /** Extra headers. Content-Type defaults to application/json when a non-string body is given. */
  headers?: Record<string, string>;
  /**
   * Request body. Strings, Uint8Array, FormData, Blob, and ReadableStream pass
   * through untouched; any other value is JSON.stringify'd (with a
   * Content-Type: application/json default).
   */
  body?: unknown;
  /** Per-attempt timeout (AbortController). Default 30s. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Which statuses to retry. Default: 429 and 5xx. */
  shouldRetry?: (status: number) => boolean;
  /** Delay before retry `attempt` (0-based). Default `backoffDelayMs`. */
  delayMs?: (attempt: number, retryAfterSeconds?: number | null) => number;
  /** Observability hook — fires once per received response (every attempt). */
  onResponse?: (info: { method: string; url: string; status: number; attempt: number }) => void;
  /**
   * Wrap a terminal network failure (fetch threw on the last attempt) in the
   * caller's error class. Default: a plain Error with the message.
   */
  networkError?: (message: string, url: string, retries: number) => Error;
}

/**
 * Exponential backoff with jitter: 500ms · 2^attempt, capped at 30s, plus up
 * to 250ms of jitter. A sane `Retry-After` (0 < s < 60) short-circuits the
 * curve — the server knows better than the guess.
 */
export function backoffDelayMs(attempt: number, retryAfterSeconds?: number | null): number {
  if (retryAfterSeconds && retryAfterSeconds > 0 && retryAfterSeconds < 60) {
    return retryAfterSeconds * 1000 + Math.floor(Math.random() * 250);
  }
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function requestWithRetries(
  url: string,
  opts: RequestWithRetriesOptions = {},
): Promise<RetryingResponse> {
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? 3;
  const shouldRetry = opts.shouldRetry ?? ((status: number) => status === 429 || status >= 500);
  const delayMs = opts.delayMs ?? backoffDelayMs;

  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (opts.body !== undefined && opts.body !== null) {
      const passthrough =
        typeof opts.body === "string" ||
        opts.body instanceof Uint8Array ||
        opts.body instanceof FormData ||
        opts.body instanceof Blob ||
        opts.body instanceof ReadableStream;
      if (passthrough) {
        init.body = opts.body as BodyInit;
      } else {
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
        init.body = JSON.stringify(opts.body);
      }
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err: unknown) {
      clearTimeout(timer);
      if (attempt < maxRetries) {
        await sleep(delayMs(attempt));
        attempt++;
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const message = `request failed after ${maxRetries} retries: ${msg} (URL: ${url})`;
      throw opts.networkError ? opts.networkError(msg, url, maxRetries) : new Error(message);
    }
    clearTimeout(timer);

    opts.onResponse?.({ method, url, status: res.status, attempt });

    if (shouldRetry(res.status) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      // Drain the body so the socket is reusable before we sleep.
      await res.text().catch(() => undefined);
      await sleep(delayMs(attempt, Number.isFinite(retryAfter) ? retryAfter : null));
      attempt++;
      continue;
    }

    return {
      ok: res.ok,
      status: res.status,
      text: await res.text(),
      url,
      headers: res.headers,
    };
  }
}
