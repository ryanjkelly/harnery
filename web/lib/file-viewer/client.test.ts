/**
 * Locks the pure URL-building in the file-viewer client. `rawUrl` feeds
 * <img>/<audio>/<video>/<iframe> src and the download/open-raw header actions;
 * `sandboxedRenderUrl` opens inert HTML on the current dashboard origin,
 * `renderUrl` opens HTML on the isolated files origin, and `viewUrl` opens the
 * dashboard Source|Preview chrome.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { FILES_ORIGIN_HOST, filesOriginUrl, isFilesOriginHost } from "../files-origin.ts";
import { isHtmlPreviewPath, rawUrl, renderUrl, sandboxedRenderUrl, viewUrl } from "./client.ts";

describe("rawUrl", () => {
  test("encodes the path so slashes/spaces/specials survive as one param value", () => {
    expect(rawUrl("docs/plans/a plan.md")).toBe("/api/file?path=docs%2Fplans%2Fa%20plan.md");
    expect(rawUrl("a/b&c?d#e.ts")).toBe("/api/file?path=a%2Fb%26c%3Fd%23e.ts");
    expect(rawUrl("weird/%252e.ts")).toBe("/api/file?path=weird%2F%25252e.ts");
  });

  test("download name is appended as its own encoded param (no smuggling)", () => {
    expect(rawUrl("docs/x.md", { download: "x.md" })).toBe(
      "/api/file?path=docs%2Fx.md&download=x.md",
    );
    expect(rawUrl("docs/x.md", { download: "a&b=c.md" })).toBe(
      "/api/file?path=docs%2Fx.md&download=a%26b%3Dc.md",
    );
  });

  test("omitting download leaves no download param", () => {
    expect(rawUrl("a.ts")).toBe("/api/file?path=a.ts");
    expect(rawUrl("a.ts").includes("download")).toBe(false);
  });
});

describe("files origin helpers", () => {
  const prevPort = process.env.HARNERY_WEB_PORT;
  afterEach(() => {
    if (prevPort === undefined) {
      delete process.env.HARNERY_WEB_PORT;
    } else {
      process.env.HARNERY_WEB_PORT = prevPort;
    }
  });

  test("isFilesOriginHost ignores port and case", () => {
    expect(isFilesOriginHost("harnery-files.localhost:9000")).toBe(true);
    expect(isFilesOriginHost("Harnery-Files.Localhost")).toBe(true);
    expect(isFilesOriginHost("localhost:9000")).toBe(false);
    expect(isFilesOriginHost(null)).toBe(false);
  });

  test("filesOriginUrl / renderUrl use the isolated host + encoded segments", () => {
    process.env.HARNERY_WEB_PORT = "9000";
    expect(FILES_ORIGIN_HOST).toBe("harnery-files.localhost");
    expect(filesOriginUrl("docs/a plan.html")).toBe(
      "http://harnery-files.localhost:9000/docs/a%20plan.html",
    );
    expect(renderUrl("docs/x.html")).toBe("http://harnery-files.localhost:9000/docs/x.html");
  });
});

describe("sandboxedRenderUrl", () => {
  test("uses the current origin API route so remote tunnels keep working", () => {
    expect(sandboxedRenderUrl("docs/a plan.html")).toBe(
      "/api/file?path=docs%2Fa%20plan.html&render=1",
    );
  });
});

describe("viewUrl", () => {
  test("encodes the path and defaults to no mode param", () => {
    expect(viewUrl("docs/a plan.html")).toBe("/files/view?path=docs%2Fa%20plan.html");
  });

  test("mode is appended as its own param", () => {
    expect(viewUrl("x.html", { mode: "preview" })).toBe("/files/view?path=x.html&mode=preview");
    expect(viewUrl("x.html", { mode: "source" })).toBe("/files/view?path=x.html&mode=source");
  });
});

describe("isHtmlPreviewPath", () => {
  test("true for .html / .htm only", () => {
    expect(isHtmlPreviewPath("docs/page.html")).toBe(true);
    expect(isHtmlPreviewPath("docs/PAGE.HTM")).toBe(true);
    expect(isHtmlPreviewPath("docs/config.xml")).toBe(false);
    expect(isHtmlPreviewPath("docs/readme.md")).toBe(false);
  });
});
