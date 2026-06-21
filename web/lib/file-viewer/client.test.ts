/**
 * Locks the pure URL-building in the file-viewer client. `rawUrl` feeds
 * <img>/<audio>/<video>/<iframe> src and the download/open-raw header actions;
 * a path or download name that isn't encoded would break on slashes, spaces,
 * `#`, `?`, `&`, or `%`, or let a crafted name smuggle extra query params.
 */

import { describe, expect, test } from "bun:test";
import { rawUrl } from "./client.ts";

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
    // A download name carrying & / = can't inject a new param.
    expect(rawUrl("docs/x.md", { download: "a&b=c.md" })).toBe(
      "/api/file?path=docs%2Fx.md&download=a%26b%3Dc.md",
    );
  });

  test("omitting download leaves no download param", () => {
    expect(rawUrl("a.ts")).toBe("/api/file?path=a.ts");
    expect(rawUrl("a.ts").includes("download")).toBe(false);
  });
});
