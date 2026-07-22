import {
  listWorkItems,
  readWorkItem,
  type WorkRecord,
  type WorkState,
} from "harnery/core/work/state";

export type { WorkRecord, WorkState };

export function readDurableWork(root: string): WorkRecord[] {
  return listWorkItems(root);
}

export function readDurableWorkItem(root: string, workId: string): WorkRecord | null {
  try {
    return readWorkItem(root, workId);
  } catch {
    return null;
  }
}
