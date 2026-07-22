import {
  listSupervisors,
  readSupervisor,
  readSupervisorServiceStatus,
  type SupervisorRecord,
  type SupervisorServiceStatus,
  type SupervisorState,
} from "harnery/core/supervisor/state";

export type { SupervisorRecord, SupervisorServiceStatus, SupervisorState };

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

export function readSupervisorBackgroundService(root: string): SupervisorServiceStatus {
  return readSupervisorServiceStatus(root);
}
