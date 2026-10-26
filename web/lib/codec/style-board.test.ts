import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { listCodecStyleStudies, resolveCodecStyleStudy } from "./style-board";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "codec-style-board-"));
});

describe("Codec style-board assets", () => {
  test("lists only the newest valid board and slugged PNG studies", () => {
    for (const board of ["2026-08-20", "2026-08-21"]) {
      mkdirSync(path.join(root, "codec", "style-boards", board), { recursive: true });
      writeFileSync(path.join(root, "codec", "style-boards", board, "graphic-cel.png"), "png");
    }
    writeFileSync(path.join(root, "codec", "style-boards", "2026-08-21", "notes.txt"), "no");
    writeFileSync(path.join(root, "codec", "style-boards", "2026-08-22"), "not a board");
    mkdirSync(path.join(root, "codec", "style-boards", "2026-08-21", "not-a-study.png"));
    expect(listCodecStyleStudies(root)).toEqual([
      {
        board_id: "2026-08-21",
        study_id: "graphic-cel",
        label: "graphic cel",
        asset_url: "/api/codec-style-board/2026-08-21/graphic-cel",
      },
    ]);
  });

  test("resolves validated files and rejects traversal or missing studies", () => {
    const dir = path.join(root, "codec", "style-boards", "2026-08-21");
    mkdirSync(dir, { recursive: true });
    const expected = path.join(dir, "kinetic-shonen.png");
    writeFileSync(expected, "png");
    expect(resolveCodecStyleStudy("2026-08-21", "kinetic-shonen", root)).toBe(expected);
    expect(resolveCodecStyleStudy("../secret", "kinetic-shonen", root)).toBeUndefined();
    expect(resolveCodecStyleStudy("2026-08-21", "../secret", root)).toBeUndefined();
    expect(resolveCodecStyleStudy("2026-08-21", "missing", root)).toBeUndefined();
  });

  test("rejects symlinks outside a board and skips boards outside the collection", () => {
    const boardsRoot = path.join(root, "codec", "style-boards");
    const boardDir = path.join(boardsRoot, "2026-08-21");
    const outsideDir = path.join(root, "outside");
    mkdirSync(boardDir, { recursive: true });
    mkdirSync(outsideDir);
    writeFileSync(path.join(boardDir, "valid.png"), "png");
    writeFileSync(path.join(outsideDir, "outside.png"), "private");
    symlinkSync(path.join(outsideDir, "outside.png"), path.join(boardDir, "outside.png"));
    symlinkSync(outsideDir, path.join(boardsRoot, "2026-08-22"), "dir");

    expect(resolveCodecStyleStudy("2026-08-21", "outside", root)).toBeUndefined();
    expect(resolveCodecStyleStudy("2026-08-22", "outside", root)).toBeUndefined();
    expect(listCodecStyleStudies(root).map((study) => study.study_id)).toEqual(["valid"]);
  });
});
