import { describe, expect, test } from "bun:test";
import { openPlan, parseOpenUrl } from "./open.ts";

describe("parseOpenUrl", () => {
  test("accepts http and https addresses", () => {
    expect(parseOpenUrl(" https://example.com/a?b=1&c=%20 ").href).toBe(
      "https://example.com/a?b=1&c=%20",
    );
    expect(parseOpenUrl("http://localhost:4278/permissions").protocol).toBe("http:");
  });

  test("refuses anything that is not a web address", () => {
    expect(() => parseOpenUrl("not a url")).toThrow("Not a web address");
    expect(() => parseOpenUrl("file:///C:/Windows/system.ini")).toThrow("Only http and https");
    expect(() => parseOpenUrl("javascript:alert(1)")).toThrow("Only http and https");
  });
});

describe("openPlan", () => {
  const url = new URL("https://example.com/search?q=a&b=c");
  const none = () => false;

  test("Windows hands the whole address to the URL protocol handler as one argument", () => {
    expect(openPlan(url, { platform: "win32", wsl: false, exists: none })).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url.href],
    });
  });

  test("WSL opens the Windows default browser", () => {
    expect(openPlan(url, { platform: "linux", wsl: true, exists: () => true }).command).toBe(
      "/mnt/c/Windows/System32/rundll32.exe",
    );
    expect(openPlan(url, { platform: "linux", wsl: true, exists: none }).command).toBe(
      "rundll32.exe",
    );
  });

  test("macOS and Linux desktops use their own opener", () => {
    expect(openPlan(url, { platform: "darwin", wsl: false, exists: none })).toEqual({
      command: "open",
      args: [url.href],
    });
    expect(openPlan(url, { platform: "linux", wsl: false, exists: none })).toEqual({
      command: "xdg-open",
      args: [url.href],
    });
  });
});
