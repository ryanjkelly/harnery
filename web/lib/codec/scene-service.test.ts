import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { CodecScene } from "./contracts";
import { createCodecSceneService } from "./scene-service";

function scene(label: string): CodecScene {
  return {
    generated_at: label,
    freshness: { value: "live" },
    panels: [{ instance_id: label }],
  } as unknown as CodecScene;
}

const services: CodecSceneService[] = [];
type CodecSceneService = ReturnType<typeof createCodecSceneService>;

afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

describe("Codec scene service", () => {
  test("coalesces concurrent scene reads into one build", async () => {
    let finishBuild: ((value: CodecScene) => void) | undefined;
    let builds = 0;
    const service = createCodecSceneService({
      eventPaths: () => [],
      build: () => {
        builds += 1;
        return new Promise((resolve) => {
          finishBuild = resolve;
        });
      },
    });
    services.push(service);

    const first = service.getScene();
    const second = service.getScene();
    expect(builds).toBe(1);
    finishBuild?.(scene("one"));

    expect(await first).toEqual(scene("one"));
    expect(await second).toEqual(scene("one"));
    expect(builds).toBe(1);
  });

  test("multicasts one refreshed scene to every connected tab", async () => {
    let builds = 0;
    const service = createCodecSceneService({
      eventPaths: () => [],
      build: async () => scene(`scene-${++builds}`),
    });
    services.push(service);
    const firstScenes: CodecScene[] = [];
    const secondScenes: CodecScene[] = [];

    const first = await service.connect(
      (next) => firstScenes.push(next),
      () => {},
    );
    const second = await service.connect(
      (next) => secondScenes.push(next),
      () => {},
    );
    expect(first.snapshot.generated_at).toBe("scene-1");
    expect(second.snapshot.generated_at).toBe("scene-1");
    expect(builds).toBe(1);

    await service.refresh();
    expect(builds).toBe(2);
    expect(firstScenes.map((value) => value.generated_at)).toEqual(["scene-2"]);
    expect(secondScenes.map((value) => value.generated_at)).toEqual(["scene-2"]);

    first.close();
    second.close();
  });

  test("does not repeat a request refresh when a queued watcher timer fires", async () => {
    let builds = 0;
    let changed: (() => void) | undefined;
    const watcher = Object.assign(new EventEmitter(), { close() {} });
    const service = createCodecSceneService({
      eventPaths: () => [import.meta.path],
      refreshMs: 50,
      watch: ((_path: unknown, listener: (eventType: string, filename: string | null) => void) => {
        changed = () => listener("change", "events.ndjson");
        return watcher;
      }) as unknown as typeof import("node:fs").watch,
      build: async () => scene(`scene-${++builds}`),
    });
    services.push(service);

    const connection = await service.connect(
      () => {},
      () => {},
    );
    changed?.();
    await Bun.sleep(10);
    await service.refresh();
    await Bun.sleep(45);

    expect(builds).toBe(2);
    connection.close();
  });
});
