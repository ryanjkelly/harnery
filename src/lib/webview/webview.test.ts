import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaceGate } from "../pace/index.ts";
import {
  type BunWebViewRuntime,
  buildWebViewBackend,
  parseWebViewTypeStep,
  parseWebViewViewport,
  runWebView,
} from "./webview.ts";

describe("Bun.WebView integration", () => {
  test("parses viewport and type-step contracts", () => {
    expect(parseWebViewViewport("390x844")).toEqual({
      width: 390,
      height: 844,
    });
    expect(() => parseWebViewViewport("390-by-844")).toThrow("Expected WxH");
    expect(() => parseWebViewViewport("20000x800")).toThrow("between 1 and 16384");
    expect(parseWebViewTypeStep("input[name=q]=>Example=>Text")).toEqual({
      selector: "input[name=q]",
      text: "Example=>Text",
    });
    expect(() => parseWebViewTypeStep(" =>Example")).toThrow("Expected <selector>=><text>");
  });

  test("never auto-connects the Chrome backend to an existing user browser", () => {
    expect(buildWebViewBackend("auto", { platform: "linux" })).toEqual({
      backend: { type: "chrome", url: false },
      resolved: "chrome",
    });
    expect(buildWebViewBackend("auto", { platform: "darwin" })).toEqual({
      resolved: "webkit",
    });
    expect(() => buildWebViewBackend("webkit", { platform: "linux" })).toThrow(
      "only available on macOS",
    );
  });

  test("runs scroll-safe interactions and closes the view", async () => {
    const calls: string[] = [];
    class FakeWebView {
      url = "about:blank";
      title = "";
      loading = false;
      onNavigated: ((url: string, title: string) => void) | null = null;
      onNavigationFailed: ((error: Error) => void) | null = null;

      constructor(options: unknown) {
        calls.push(`construct:${JSON.stringify(options)}`);
      }

      async navigate(url: string): Promise<void> {
        calls.push(`navigate:${url}`);
        this.url = url;
        this.title = "Probe";
      }

      async evaluate(script: string): Promise<unknown> {
        calls.push(`evaluate:${script}`);
        if (script.includes("href: location.href")) {
          return {
            href: this.url,
            title: this.title,
            readyState: "complete",
            bodyHtmlLength: 13,
          };
        }
        if (script.includes("document.body?.innerText")) return "Rendered body";
        if (script.includes("document.documentElement?.outerHTML"))
          return "<html><body>Rendered body</body></html>";
        return 42;
      }

      async screenshot(): Promise<Buffer> {
        return Buffer.from("png");
      }

      async click(selector: string): Promise<void> {
        calls.push(`click:${selector}`);
      }

      async type(text: string): Promise<void> {
        calls.push(`type:${text}`);
      }

      async press(key: string): Promise<void> {
        calls.push(`press:${key}`);
      }

      async scrollTo(selector: string): Promise<void> {
        calls.push(`scroll:${selector}`);
      }

      close(): void {
        calls.push("close");
      }
    }

    const result = await runWebView("https://example.com", {
      runtime: {
        version: "1.4.0",
        WebView: FakeWebView,
      } as unknown as BunWebViewRuntime,
      platform: "linux",
      userAgent: "native",
      pace: null,
      typeSteps: [{ selector: "#name", text: "Example" }],
      clicks: ["#submit"],
      presses: ["Enter"],
      evaluate: "21 * 2",
      captureHtml: true,
    });

    expect(result).toMatchObject({
      backend: "chrome",
      runtimeVersion: "1.4.0",
      url: "https://example.com",
      title: "Probe",
      text: "Rendered body",
      html: "<html><body>Rendered body</body></html>",
      evaluation: 42,
    });
    expect(calls[0]).toContain(
      'construct:{"width":1280,"height":800,"backend":{"type":"chrome","url":false}',
    );
    expect(calls).toContain("navigate:https://example.com");
    expect(calls).toContain("scroll:#name");
    expect(calls).toContain("click:#name");
    expect(calls).toContain("type:Example");
    expect(calls).toContain("scroll:#submit");
    expect(calls).toContain("click:#submit");
    expect(calls).toContain("press:Enter");
    expect(calls).toContain("evaluate:21 * 2");
    expect(calls).toContain("evaluate:document.body?.innerText ?? ''");
    expect(calls).toContain("evaluate:document.documentElement?.outerHTML ?? ''");
    expect(calls.at(-1)).toBe("close");
    const previousUa = process.env.HARNERY_BROWSER_UA;
    process.env.HARNERY_BROWSER_UA = "FixtureBrowser/1";
    try {
      calls.length = 0;
      await runWebView("https://example.com", {
        runtime: { WebView: FakeWebView } as unknown as BunWebViewRuntime,
        platform: "linux",
        pace: null,
      });
      expect(calls[0]).toContain("--user-agent=FixtureBrowser/1");
    } finally {
      if (previousUa === undefined) delete process.env.HARNERY_BROWSER_UA;
      else process.env.HARNERY_BROWSER_UA = previousUa;
    }
  });

  test("reserves a human-pace slot for the target site before navigating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harnery-webview-pace-"));
    const waits: string[] = [];
    const calls: string[] = [];
    class QuietWebView {
      url = "about:blank";
      title = "";
      loading = false;
      onNavigated = null;
      onNavigationFailed = null;
      async navigate(url: string): Promise<void> {
        calls.push(`navigate:${url}`);
        this.url = url;
      }
      async evaluate(): Promise<unknown> {
        return "";
      }
      async screenshot(): Promise<Buffer> {
        return Buffer.from("png");
      }
      async click(): Promise<void> {}
      async type(): Promise<void> {}
      async press(): Promise<void> {}
      async scrollTo(): Promise<void> {}
      close(): void {}
    }
    try {
      const gate = new PaceGate(
        {
          enabled: true,
          minMs: 0,
          maxMs: 0,
          exemptSuffixes: [],
          ledgerPath: join(dir, "pace.json"),
        },
        { onWait: (w) => waits.push(w.site) },
      );
      await runWebView("https://www.example.com/page", {
        runtime: { version: "1.4.0", WebView: QuietWebView } as unknown as BunWebViewRuntime,
        platform: "linux",
        pace: gate,
        userAgent: "native",
      });
      expect(waits).toEqual(["example.com"]);
      expect(calls).toEqual(["navigate:https://www.example.com/page"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("waits for a same-URL replacement document after a click", async () => {
    class ReloadingWebView {
      url = "https://example.com/form";
      title = "Before";
      loading = false;
      onNavigated: ((url: string, title: string) => void) | null = null;
      onNavigationFailed: ((error: Error) => void) | null = null;
      private body = "Old body";

      async navigate(): Promise<void> {}

      async evaluate(script: string): Promise<unknown> {
        if (script.includes("href: location.href")) {
          return {
            href: this.url,
            title: this.title,
            readyState: "complete",
            bodyHtmlLength: this.body.length,
          };
        }
        if (script.includes("document.body?.innerText")) return this.body;
        return undefined;
      }

      async click(): Promise<void> {
        this.title = "After";
        this.body = "Replacement body";
        this.onNavigated?.(this.url, this.title);
      }

      async screenshot(): Promise<Buffer> {
        return Buffer.from("png");
      }

      async type(): Promise<void> {}
      async press(): Promise<void> {}
      async scrollTo(): Promise<void> {}
      close(): void {}
    }

    const result = await runWebView("https://example.com/form", {
      runtime: {
        version: "1.4.0",
        WebView: ReloadingWebView,
      } as unknown as BunWebViewRuntime,
      platform: "linux",
      pace: null,
      userAgent: "native",
      clicks: ["#submit"],
    });

    expect(result).toMatchObject({
      url: "https://example.com/form",
      title: "After",
      text: "Replacement body",
    });
  });
});
