export interface TunnelErrorPageOptions {
  kind: "access-denied" | "upstream-unavailable";
  incidentId: string;
  timestamp: string;
  tunnelName: string;
  method: string;
  path: string;
  clientIp: string;
  cloudflareRay: string;
  target?: string;
  errorCode?: string;
  errorMessage?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function diagnosticText(options: TunnelErrorPageOptions): string {
  const lines = [
    `Tunnel incident: ${options.incidentId}`,
    `Time: ${options.timestamp}`,
    `Problem: ${options.kind}`,
    `Tunnel: ${options.tunnelName}`,
    `Request: ${options.method} ${options.path}`,
    `Client IP: ${options.clientIp || "(not provided by proxy)"}`,
    `Cloudflare Ray: ${options.cloudflareRay || "(not provided)"}`,
  ];

  if (options.target) lines.push(`Upstream: ${options.target}`);
  if (options.errorCode) lines.push(`Error code: ${options.errorCode}`);
  if (options.errorMessage) lines.push(`Error: ${options.errorMessage}`);

  return lines.join("\n");
}

export function renderTunnelErrorPage(options: TunnelErrorPageOptions): string {
  const denied = options.kind === "access-denied";
  const title = denied ? "This device is not allowed yet" : "The preview is temporarily offline";
  const summary = denied
    ? "The tunnel is running, but this device's public IP is not on its access list."
    : "The public tunnel and access check are working, but the local preview server is not responding.";
  const nextStep = denied
    ? "Copy the diagnostic below and send it to the person running the tunnel. It includes the public IP that needs to be allowed."
    : "Copy the diagnostic below and send it to the person running the tunnel. The incident ID can be matched to the server log.";
  const diagnostic = diagnosticText(options);
  const safeDiagnosticForScript = JSON.stringify(diagnostic).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #f4f2ed; color: #17211c; display: grid; place-items: center; padding: 24px; }
    main { width: min(100%, 720px); background: #fff; border: 1px solid #d8d4ca; border-radius: 18px; box-shadow: 0 18px 50px rgba(23, 33, 28, .10); overflow: hidden; }
    .bar { height: 8px; background: ${denied ? "#b54708" : "#b42318"}; }
    .content { padding: clamp(24px, 5vw, 48px); }
    .eyebrow { margin: 0 0 10px; color: ${denied ? "#8a3708" : "#912018"}; font-size: 13px; font-weight: 750; letter-spacing: .09em; text-transform: uppercase; }
    h1 { margin: 0; max-width: 18ch; font-size: clamp(30px, 7vw, 48px); line-height: 1.02; letter-spacing: -.04em; }
    .summary { margin: 20px 0 10px; max-width: 58ch; font-size: 18px; line-height: 1.55; }
    .next { margin: 0 0 24px; max-width: 62ch; color: #536058; line-height: 1.55; }
    .diagnostic-wrap { position: relative; }
    pre { margin: 0; padding: 18px; border: 1px solid #ccd2cd; border-radius: 12px; background: #111814; color: #edf5ef; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    button { width: 100%; margin-top: 12px; border: 0; border-radius: 11px; padding: 14px 18px; background: #17643a; color: #fff; font: inherit; font-weight: 750; cursor: pointer; }
    button:hover { background: #0e5230; }
    button:focus-visible { outline: 3px solid #87c89f; outline-offset: 3px; }
    .incident { margin: 18px 0 0; color: #68736c; font-size: 13px; text-align: center; }
  </style>
</head>
<body>
  <main>
    <div class="bar"></div>
    <div class="content">
      <p class="eyebrow">Tunnel diagnostic</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="summary">${escapeHtml(summary)}</p>
      <p class="next">${escapeHtml(nextStep)}</p>
      <div class="diagnostic-wrap">
        <pre id="diagnostic">${escapeHtml(diagnostic)}</pre>
        <button id="copy" type="button">Copy diagnostic</button>
      </div>
      <p class="incident">Incident ${escapeHtml(options.incidentId)}</p>
    </div>
  </main>
  <script>
    const diagnostic = ${safeDiagnosticForScript};
    const button = document.getElementById("copy");
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(diagnostic);
        button.textContent = "Copied";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById("diagnostic"));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = "Selected — copy now";
      }
    });
  </script>
</body>
</html>`;
}
