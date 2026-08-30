import {
  SUPERVISOR_ANOMALY_SCHEMA_VERSION,
  SUPERVISOR_HISTORY_SCHEMA_VERSION,
  SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
  SUPERVISOR_SNAPSHOT_SCHEMA_VERSION,
  type SupervisorAnomalies,
  type SupervisorHistory,
  type SupervisorLogFeed,
  type SupervisorSnapshot,
} from "../../src/core/supervisor/contract";
import {
  readSupervisorAnomalies,
  readSupervisorHistory,
  readSupervisorLogFeed,
  readSupervisorSnapshot,
} from "../../src/core/supervisor/storage";

export interface SupervisorDashboardReport {
  snapshot?: SupervisorSnapshot;
  history?: SupervisorHistory;
  anomalies?: SupervisorAnomalies;
  logFeed?: SupervisorLogFeed;
}

export function readSupervisorDashboard(root: string): SupervisorDashboardReport {
  const snapshot = readSupervisorSnapshot(root);
  const history = readSupervisorHistory(root);
  const anomalies = readSupervisorAnomalies(root);
  const logFeed = readSupervisorLogFeed(root);
  return {
    snapshot:
      snapshot?.schema_version === SUPERVISOR_SNAPSHOT_SCHEMA_VERSION ? snapshot : undefined,
    history: history?.schema_version === SUPERVISOR_HISTORY_SCHEMA_VERSION ? history : undefined,
    anomalies:
      anomalies?.schema_version === SUPERVISOR_ANOMALY_SCHEMA_VERSION ? anomalies : undefined,
    logFeed: logFeed?.schema_version === SUPERVISOR_LOG_FEED_SCHEMA_VERSION ? logFeed : undefined,
  };
}
