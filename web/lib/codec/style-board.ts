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
      .filter((entry) => BOARD_ID.test(entry))
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
      .filter((entry) => entry.endsWith(".png") && STUDY_ID.test(entry.slice(0, -4)))
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
  if (!BOARD_ID.test(boardId) || !STUDY_ID.test(studyId)) return undefined;
  const filePath = path.join(root, "codec", "style-boards", boardId, `${studyId}.png`);
  try {
    return fs.statSync(filePath).isFile() ? filePath : undefined;
  } catch {
    return undefined;
  }
}
