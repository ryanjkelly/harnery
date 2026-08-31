import {
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  SUPERVISOR_HISTORY_SCHEMA_VERSION,
  SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
  SUPERVISOR_SNAPSHOT_SCHEMA_VERSION,
  type SupervisorFindings,
  type SupervisorHistory,
  type SupervisorLogFeed,
  type SupervisorSnapshot,
} from "../../src/core/supervisor/contract";
import {
  readSupervisorFindings,
  readSupervisorHistory,
  readSupervisorLogFeed,
  readSupervisorSnapshot,
} from "../../src/core/supervisor/storage";

export interface SupervisorDashboardReport {
  snapshot?: SupervisorSnapshot;
  history?: SupervisorHistory;
  findings?: SupervisorFindings;
  logFeed?: SupervisorLogFeed;
}

export function readSupervisorDashboard(root: string): SupervisorDashboardReport {
  const snapshot = readSupervisorSnapshot(root);
  const history = readSupervisorHistory(root);
  const findings = readSupervisorFindings(root);
  const logFeed = readSupervisorLogFeed(root);
  return {
    snapshot:
      snapshot?.schema_version === SUPERVISOR_SNAPSHOT_SCHEMA_VERSION ? snapshot : undefined,
    history: history?.schema_version === SUPERVISOR_HISTORY_SCHEMA_VERSION ? history : undefined,
    findings: findings?.schema_version === SUPERVISOR_FINDING_SCHEMA_VERSION ? findings : undefined,
    logFeed: logFeed?.schema_version === SUPERVISOR_LOG_FEED_SCHEMA_VERSION ? logFeed : undefined,
  };
}
