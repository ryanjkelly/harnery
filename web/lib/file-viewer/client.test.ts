/**
 * Locks the pure URL-building in the file-viewer client. `rawUrl` feeds
 * <img>/<audio>/<video>/<iframe> src and the download/open-raw header actions;
 * `sandboxedRenderUrl` opens inert HTML on the current dashboard origin,
 * `renderUrl` opens HTML on the isolated files origin, and `viewUrl` opens the
 * dashboard Source|Preview chrome.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { FILES_ORIGIN_HOST, filesOriginUrl, isFilesOriginHost } from "../files-origin.ts";
import {
  isHtmlPreviewPath,
  markdownImageUrl,
  rawUrl,
  renderUrl,
  sandboxedRenderUrl,
  viewUrl,
} from "./client.ts";

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

describe("markdownImageUrl", () => {
  const document = ".harnery/artifacts/run-1/review/review.md";

  test("resolves sibling and nested images beside the Markdown document", () => {
    expect(markdownImageUrl(document, "chapter.png")).toBe(
      "/api/file?path=.harnery%2Fartifacts%2Frun-1%2Freview%2Fchapter.png",
    );
    expect(markdownImageUrl(document, "sheets/chapter 1.png")).toBe(
      "/api/file?path=.harnery%2Fartifacts%2Frun-1%2Freview%2Fsheets%2Fchapter%201.png",
    );
  });

  test("normalizes dot segments without allowing traversal above the repository", () => {
    expect(markdownImageUrl(document, "../shared/frame.png#crop")).toBe(
      "/api/file?path=.harnery%2Fartifacts%2Frun-1%2Fshared%2Fframe.png#crop",
    );
    expect(markdownImageUrl(document, "/assets/logo.png")).toBe("/api/file?path=assets%2Flogo.png");
    expect(markdownImageUrl("readme.md", "../outside.png")).toBe("../outside.png");
  });

  test("decodes Markdown URL paths and carries cache-busting queries without smuggling", () => {
    expect(markdownImageUrl(document, "sheets/frame%201.png?v=2&download=evil#focus")).toBe(
      "/api/file?path=.harnery%2Fartifacts%2Frun-1%2Freview%2Fsheets%2Fframe%201.png&sourceQuery=v%3D2%26download%3Devil#focus",
    );
    expect(markdownImageUrl(document, "sheets/bad%ZZ.png")).toBe("sheets/bad%ZZ.png");
  });

  test("leaves non-local destinations to react-markdown's URL policy", () => {
    for (const source of [
      "https://example.com/frame.png",
      "data:image/png;base64,AA==",
      "blob:https://example.com/id",
      "//cdn.example.com/frame.png",
      "#poster",
      "?frame=1",
      "C:\\frames\\one.png",
    ]) {
      expect(markdownImageUrl(document, source)).toBe(source);
    }
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

  test("filesOriginUrl uses the mnemonic web port when the env is absent", () => {
    delete process.env.HARNERY_WEB_PORT;
    expect(filesOriginUrl("docs/x.html")).toBe("http://harnery-files.localhost:4276/docs/x.html");
  });
});

describe("sandboxedRenderUrl", () => {
  test("uses a path-shaped current-origin route so relative assets and tunnels work", () => {
    expect(sandboxedRenderUrl("docs/a plan.html")).toBe("/files/render/docs/a%20plan.html");
    expect(sandboxedRenderUrl("/docs/a#b?.html")).toBe("/files/render/docs/a%23b%3F.html");
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
