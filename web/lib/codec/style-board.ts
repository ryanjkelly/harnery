/** Read-only discovery for runtime Codec art-direction studies. */

import fs from "node:fs";
import path from "node:path";

import { harneryDir } from "@/lib/coord-reader";

const BOARD_ID = /^\d{4}-\d{2}-\d{2}$/;
const STUDY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface CodecStyleStudy {
  board_id: string;
  study_id: string;
  label: string;
  asset_url: string;
}

export function listCodecStyleStudies(root = harneryDir()): CodecStyleStudy[] {
  const boardsRoot = path.join(root, "codec", "style-boards");
  let boards: string[];
  try {
    boards = fs
      .readdirSync(boardsRoot)
      .filter((entry) => Boolean(resolveBoardDir(entry, root)))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const current = boards[0];
  if (!current) return [];
  try {
    return fs
      .readdirSync(path.join(boardsRoot, current))
      .filter((entry) =>
        entry.endsWith(".png") &&
        Boolean(resolveCodecStyleStudy(current, entry.slice(0, -4), root)),
      )
      .sort()
      .map((entry) => {
        const studyId = entry.slice(0, -4);
        return {
          board_id: current,
          study_id: studyId,
          label: studyId.replaceAll("-", " "),
          asset_url: `/api/codec-style-board/${current}/${studyId}`,
        };
      });
  } catch {
    return [];
  }
}

export function resolveCodecStyleStudy(
  boardId: string,
  studyId: string,
  root = harneryDir(),
): string | undefined {
  if (!STUDY_ID.test(studyId)) return undefined;
  const boardDir = resolveBoardDir(boardId, root);
  if (!boardDir) return undefined;
  const filePath = path.join(root, "codec", "style-boards", boardId, `${studyId}.png`);
  try {
    const target = fs.realpathSync(filePath);
    return withinDirectory(boardDir, target) && fs.statSync(target).isFile()
      ? filePath
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveBoardDir(boardId: string, root: string): string | undefined {
  if (!BOARD_ID.test(boardId)) return undefined;
  try {
    const boardsRoot = fs.realpathSync(path.join(root, "codec", "style-boards"));
    const boardDir = fs.realpathSync(path.join(boardsRoot, boardId));
    return withinDirectory(boardsRoot, boardDir) && fs.statSync(boardDir).isDirectory()
      ? boardDir
      : undefined;
  } catch {
    return undefined;
  }
}

function withinDirectory(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
