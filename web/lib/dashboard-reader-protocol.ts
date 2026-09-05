import type { AgentsSnapshot, EventsResponse } from "./coord-reader";
import type { EventQueryOptions } from "./event-query-reader";
import type { HomeSnapshot } from "./home-snapshot-reader";
import type { PaletteCatalog } from "./palette/catalog";

export interface DashboardResults {
  agents: AgentsSnapshot;
  palette: PaletteCatalog;
  home: HomeSnapshot;
  events: EventsResponse;
}

export interface DashboardInputs {
  agents: undefined;
  palette: undefined;
  home: undefined;
  events: EventQueryOptions;
}

export type DashboardReadKind = keyof DashboardResults;
export type DashboardRequest = {
  [K in DashboardReadKind]: { id: number; kind: K; input?: DashboardInputs[K] };
}[DashboardReadKind];

export type DashboardResponse =
  | { id: number; ok: true; value: DashboardResults[DashboardReadKind] }
  | { id: number; ok: false; error: string };
