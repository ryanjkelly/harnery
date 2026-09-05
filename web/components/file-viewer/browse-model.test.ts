import { describe, expect, test } from "bun:test";
import {
  addRecent,
  type BrowserEntry,
  browseHref,
  displayName,
  filterEntries,
  inBrowseScope,
  readBrowseLocation,
} from "./browse-model";

describe("Browse navigation", () => {
  test("file deep links open their containing folder", () => {
    expect(readBrowseLocation("?file=work%2Fframes%2Fone.png")).toEqual({
      view: "folder",
      dir: "work/frames",
      file: "work/frames/one.png",
    });
    expect(readBrowseLocation("?dir=")).toEqual({ view: "folder", dir: "", file: null });
    expect(readBrowseLocation("")).toEqual({ view: "recent", dir: "", file: null });
  });
  test("folder history preserves agent scope and encodes special filenames", () => {
    const href = browseHref(
      "https://example.test/browse?agent=agent-June&file=old.txt&path=old.txt#detail",
      { view: "folder", dir: "work/new folder", file: "work/new folder/a#b?.png" },
    );
    expect(href).toBe(
      "/browse?agent=agent-June&dir=work%2Fnew+folder&file=work%2Fnew+folder%2Fa%23b%3F.png#detail",
    );
    expect(readBrowseLocation(new URL(href, "https://example.test").search)).toEqual({
      view: "folder",
      dir: "work/new folder",
      file: "work/new folder/a#b?.png",
    });
  });
  test("navigation out of a preview removes file and obsolete overlay parameters", () => {
    expect(
      browseHref("/browse?agent=agent-June&dir=work&file=work/a.png&path=work/a.png", {
        view: "pinned",
        dir: "",
        file: null,
      }),
    ).toBe("/browse?agent=agent-June&view=pinned");
  });
  test("scope matching requires a full path segment", () => {
    expect(inBrowseScope("work/one/file.txt", ["work/one"])).toBe(true);
    expect(inBrowseScope("work/ones/file.txt", ["work/one"])).toBe(false);
    expect(inBrowseScope("work/one", [])).toBe(false);
    expect(inBrowseScope("anywhere", undefined)).toBe(true);
  });
});

describe("Browse discovery", () => {
  const entries: BrowserEntry[] = [
    {
      name: "frame10.png",
      relPath: "work/frame10.png",
      kind: "file",
      mtime: "2026-09-05T10:00:00.000Z",
    },
    {
      name: "frame2.png",
      relPath: "work/frame2.png",
      kind: "file",
      mtime: "2026-09-04T10:00:00.000Z",
    },
    {
      name: "older-folder",
      relPath: "work/older-folder",
      kind: "dir",
      mtime: "2026-09-01T10:00:00.000Z",
      owner: "agent-June",
      title: "Motion study",
      purpose: "Review lighting",
    },
  ];
  test("folders stay first under every sort and input is not mutated", () => {
    for (const sort of ["name", "date", "type"] as const)
      expect(filterEntries(entries, "", "all", sort)[0].kind).toBe("dir");
    expect(filterEntries(entries, "", "all", "name").map((entry) => entry.name)).toEqual([
      "older-folder",
      "frame2.png",
      "frame10.png",
    ]);
    expect(entries[0].name).toBe("frame10.png");
  });
  test("search matches title, purpose and owner words with type filtering", () => {
    expect(filterEntries(entries, "june lighting", "dir", "name")).toEqual([entries[2]]);
    expect(filterEntries(entries, "frame", "image", "date").map((entry) => entry.name)).toEqual([
      "frame10.png",
      "frame2.png",
    ]);
    expect(filterEntries(entries, "frame", "document", "name")).toEqual([]);
  });
  test("only direct artifact workspace names lose date and hash decoration", () => {
    expect(
      displayName({
        name: "2026-09-05_motion-study_1234abcd",
        relPath: ".harnery/artifacts/2026-09-05_motion-study_1234abcd",
        kind: "dir",
      }),
    ).toBe("Motion study");
    expect(
      displayName({
        name: "2026-09-05_motion-study_1234abcd",
        relPath: "source/2026-09-05_motion-study_1234abcd",
        kind: "file",
      }),
    ).toBe("2026-09-05_motion-study_1234abcd");
  });
  test("recent files remain unique and bounded", () => {
    const paths = Array.from({ length: 20 }, (_, index) => `file-${index}.txt`);
    const next = addRecent(paths, "file-5.txt");
    expect(next).toHaveLength(12);
    expect(next[0]).toBe("file-5.txt");
    expect(new Set(next).size).toBe(12);
  });
});
