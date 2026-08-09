export interface BrowserProxy {
  server: string;
  username?: string;
  password?: string;
}

export interface BrowserProxyGate {
  checkUrl: string;
  expectedIp: string;
}

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

/**
 * Parse an authenticated HTTP(S) proxy from the child environment without
 * requiring credentials in command arguments. The returned server never
 * contains userinfo, so Playwright owns the 407 challenge response.
 */
export function browserProxyFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserProxy {
  const raw = PROXY_ENV_KEYS.map((key) => env[key]).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!raw) {
    throw new Error(
      "--proxy-from-env requires HTTPS_PROXY, https_proxy, HTTP_PROXY, or http_proxy.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The proxy environment contains an invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser proxy URLs must use http:// or https://.");
  }
  if (!url.hostname || !url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "Browser proxy URLs must contain only scheme, host, port, and optional credentials.",
    );
  }
  if ((url.username && !url.password) || (!url.username && url.password)) {
    throw new Error("Browser proxy URLs must provide both username and password, or neither.");
  }

  const proxy: BrowserProxy = { server: `${url.protocol}//${url.host}` };
  if (url.username) {
    proxy.username = decodeURIComponent(url.username);
    proxy.password = decodeURIComponent(url.password);
  }
  return proxy;
}

/**
 * Read the optional fixed-egress gate injected by an embedding host wrapper.
 * Both fields are required together so a partial contract
 * fails before Chromium visits the requested target.
 */
export function browserProxyGateFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrowserProxyGate | null {
  const expectedIp = env.HARNERY_BROWSER_PROXY_EXPECTED_IP?.trim();
  const checkUrl = env.HARNERY_BROWSER_PROXY_CHECK_URL?.trim();
  if (!expectedIp && !checkUrl) return null;
  if (!expectedIp || !checkUrl) {
    throw new Error(
      "HARNERY_BROWSER_PROXY_EXPECTED_IP and HARNERY_BROWSER_PROXY_CHECK_URL must be set together.",
    );
  }
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(expectedIp)) {
    throw new Error("HARNERY_BROWSER_PROXY_EXPECTED_IP must be an IPv4 address.");
  }
  let parsed: URL;
  try {
    parsed = new URL(checkUrl);
  } catch {
    throw new Error("HARNERY_BROWSER_PROXY_CHECK_URL must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("HARNERY_BROWSER_PROXY_CHECK_URL must use HTTPS.");
  }
  return { expectedIp, checkUrl: parsed.toString() };
}

export function extractObservedIp(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["ip", "query", "origin"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return value.trim().split(",")[0].trim();
    }
    const proxy = parsed.proxy;
    if (proxy && typeof proxy === "object") {
      const value = (proxy as Record<string, unknown>).ip;
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    // A plain-text IP endpoint is also valid.
  }
  const trimmed = body.trim();
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed) ? trimmed : null;
}

export const WEBRTC_PROXY_ONLY_ARG = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
