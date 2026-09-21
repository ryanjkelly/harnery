/**
 * Headers the tunnel gate sends to the upstream after the Host rewrite.
 *
 * The gate replaces Host so PHP (and other vhost-routed servers) see the
 * configured review host. Callers that compare Origin to Host then fail,
 * because the browser still sends the public tunnel hostname. Copy that
 * original Host into X-Forwarded-Host, overwriting any client-supplied
 * value, so the upstream can recover the hostname the browser used.
 */
export function applyUpstreamHeaders(headers: Headers, vhost: string): void {
  const originalHost = headers.get("host") ?? "";
  headers.set("host", vhost);
  if (originalHost) headers.set("x-forwarded-host", originalHost);
  headers.set("accept-encoding", "identity");
  headers.delete("connection");
}
