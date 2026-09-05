import type { AgentsSnapshot, EventsResponse } from "./coord-reader";
import type { EventQueryOptions } from "./event-query-reader";
import type { HomeSnapshot } from "./home-snapshot-reader";
import type {
  CouncilsPageSnapshot,
  EventsPageOptions,
  EventsPageSnapshot,
} from "./page-snapshot-reader";
import type { PaletteCatalog } from "./palette/catalog";

export interface DashboardResults {
  agents: AgentsSnapshot;
  palette: PaletteCatalog;
  home: HomeSnapshot;
  events: EventsResponse;
  eventsPage: EventsPageSnapshot;
  councilsPage: CouncilsPageSnapshot;
}

export interface DashboardInputs {
  agents: undefined;
  palette: undefined;
  home: undefined;
  events: EventQueryOptions;
  eventsPage: EventsPageOptions;
  councilsPage: undefined;
}

export type DashboardReadKind = keyof DashboardResults;
export type DashboardRequest = {
  [K in DashboardReadKind]: { id: number; kind: K; input?: DashboardInputs[K] };
}[DashboardReadKind];

export type DashboardResponse =
  | { id: number; ok: true; value: DashboardResults[DashboardReadKind] }
  | { id: number; ok: false; error: string };
