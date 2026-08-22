import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
});
