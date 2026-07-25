import { describe, expect, test } from "bun:test";
import { renderTunnelErrorPage } from "./error-page";

const base = {
  incidentId: "test-1234",
  timestamp: "2026-07-24T14:00:00.000Z",
  tunnelName: "preview",
  method: "GET",
  path: "/example",
  clientIp: "203.0.113.8",
  cloudflareRay: "ray-123",
};

describe("renderTunnelErrorPage", () => {
  test("shows the rejected client IP in a copyable diagnostic", () => {
    const html = renderTunnelErrorPage({ ...base, kind: "access-denied" });

    expect(html).toContain("This device is not allowed yet");
    expect(html).toContain("Client IP: 203.0.113.8");
    expect(html).toContain("Copy diagnostic");
    expect(html).toContain("Problem: access-denied");
  });

  test("shows upstream failure details and escapes untrusted values", () => {
    const html = renderTunnelErrorPage({
      ...base,
      kind: "upstream-unavailable",
      path: "/<script>alert(1)</script>",
      target: "http://127.0.0.1:8092",
      errorCode: "ConnectionRefused",
      errorMessage: 'Unable to connect <img src="x">',
    });

    expect(html).toContain("The preview is temporarily offline");
    expect(html).toContain("Error code: ConnectionRefused");
    expect(html).toContain("The public tunnel and access check are working");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('<img src="x">');
    expect(html).toContain("\\u003cscript>");
  });
});
