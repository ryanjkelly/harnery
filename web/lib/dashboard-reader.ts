import { Worker } from "node:worker_threads";
import { coordRoot } from "./coord-reader";
import { DashboardReaderClient } from "./dashboard-reader-client";
import type {
  DashboardInputs,
  DashboardReadKind,
  DashboardResults,
} from "./dashboard-reader-protocol";

const scope = globalThis as typeof globalThis & {
  __harneryDashboardReader?: { root: string; client: DashboardReaderClient };
};

/** Presentation reads only. Mutations keep their own current authority checks. */
export function readDashboard<K extends DashboardReadKind>(
  kind: K,
  input?: DashboardInputs[K],
  options?: { signal?: AbortSignal },
): Promise<DashboardResults[K]> {
  const root = coordRoot();
  if (scope.__harneryDashboardReader?.root !== root) {
    scope.__harneryDashboardReader?.client.close();
    scope.__harneryDashboardReader = {
      root,
      client: new DashboardReaderClient(
        () =>
          new Worker(new URL("./dashboard-reader-worker.ts", import.meta.url), {
            env: { ...process.env, HARNERY_COORD_ROOT: root },
            resourceLimits: { maxOldGenerationSizeMb: 512 },
          }),
      ),
    };
  }
  return scope.__harneryDashboardReader.client.read(kind, input, options);
}
