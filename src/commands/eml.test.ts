import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import { extractThread, renderMarkdown } from "./eml.ts";

/**
 * Regression coverage for the `eml` render, focused on `--headers`, which was
 * a registered + documented flag whose value was never read (a silent no-op)
 * until it was implemented to render the source message's real headers.
 */

const RAW =
  "From: alice@example.com\r\n" +
  "To: bob@example.com\r\n" +
  "Subject: Test Thread\r\n" +
  "Date: Mon, 01 Jan 2026 10:00:00 +0000\r\n" +
  "Content-Type: text/plain\r\n" +
  "\r\n" +
  "Hello world.\r\n";

async function render(opts: { headers?: boolean }) {
  const parsed = await simpleParser(RAW);
  return renderMarkdown(parsed, extractThread(parsed), { format: "markdown", ...opts });
}

describe("eml renderMarkdown --headers", () => {
  test("omits the source-headers block by default", async () => {
    const md = await render({});
    expect(md).not.toContain("**Source headers:**");
    expect(md).toContain("# Test Thread");
  });

  test("renders the source message's headers when --headers is set", async () => {
    const md = await render({ headers: true });
    expect(md).toContain("**Source headers:**");
    expect(md).toContain("From: alice@example.com");
    expect(md).toContain("Subject: Test Thread");
  });
});

describe("eml HTML sanitization", () => {
  test("removes active elements and neutralizes entity-decoded raw HTML", async () => {
    const parsed = await simpleParser(
      [
        "From: alice@example.com",
        "To: bob@example.com",
        "Subject: Untrusted HTML",
        "Date: Mon, 01 Jan 2026 10:00:00 +0000",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Hello</p><script>alert('executed')</script>",
        "<p>&lt;img src=x onerror=alert(1)&gt;</p>",
      ].join("\r\n"),
    );
    const output = renderMarkdown(parsed, extractThread(parsed), { format: "markdown" });
    expect(output).toContain("Hello");
    expect(output).not.toContain("executed");
    expect(output).not.toContain("<img");
    expect(output).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
