export interface FailedRequestCandidate {
  url: string;
  method: string;
  failure: string;
  resourceType: string;
}

/**
 * Next.js may start a speculative React Server Component fetch and cancel it
 * once the destination is no longer needed. Chromium reports that deliberate
 * cancellation as net::ERR_ABORTED even though the rendered page is healthy.
 */
export function isBenignNextRscAbort(request: FailedRequestCandidate): boolean {
  if (
    request.failure !== "net::ERR_ABORTED" ||
    request.method !== "GET" ||
    request.resourceType !== "fetch"
  ) {
    return false;
  }

  try {
    return new URL(request.url).searchParams.has("_rsc");
  } catch {
    return false;
  }
}
