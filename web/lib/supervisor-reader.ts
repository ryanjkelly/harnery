import {
  listSupervisors,
  readSupervisor,
  type SupervisorRecord,
  type SupervisorState,
} from "harnery/core/supervisor/state";

export type { SupervisorRecord, SupervisorState };

export function readSupervisors(root: string): SupervisorRecord[] {
  return listSupervisors(root);
}

export function readSupervisorGoal(root: string, goalId: string): SupervisorRecord | null {
  try {
    return readSupervisor(root, goalId);
  } catch {
    return null;
  }
}
