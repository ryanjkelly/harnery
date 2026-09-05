import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThumbnailBackground } from "./thumbnail-background";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Background watcher did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function fixture(busy: () => boolean = () => false) {
  const root = mkdtempSync(join(tmpdir(), "harn-prewarm-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const folder = ".harnery/artifacts/2026-09-05_preview-fixture";
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "notes.txt"), "initial");
  const calls: Array<{ path: string; content: string }> = [];
  const background = createThumbnailBackground({
    root,
    debounceMs: 30,
    tickMs: 10,
    scanIntervalMs: 100,
    busy,
    enqueue: async (relative) => {
      calls.push({ path: relative, content: readFileSync(join(root, relative), "utf8") });
      return 200;
    },
  });
  cleanup.push(() => background.stop());
  return { root, folder, calls, background };
}

test("changed artifact files are debounced and prepared before a browser request", async () => {
  const { root, folder, calls } = fixture();
  await until(() => calls.length === 1);
  const file = join(root, folder, "notes.txt");
  writeFileSync(file, "partial");
  writeFileSync(file, "finished");
  await until(() => calls.some((call) => call.content === "finished"));
  expect(calls.map((call) => call.content)).toEqual(["initial", "finished"]);
});

test("visible work pauses background admission without losing pending files", async () => {
  let busy = true;
  const { calls, background } = fixture(() => busy);
  await until(() => background.pending > 0);
  expect(calls).toHaveLength(0);
  busy = false;
  await until(() => calls.length === 1);
});

test("new folders and explicit preview registration trigger discovery", async () => {
  const { root, folder, calls } = fixture();
  await until(() => calls.length === 1);
  mkdirSync(join(root, folder, "output"));
  writeFileSync(join(root, folder, "output", "next.json"), '{"ready":true}');
  await until(() => calls.some((call) => call.path.endsWith("next.json")));
  writeFileSync(join(root, folder, ".thumbnail-preview-association.json"), "{}");
  await until(() => calls.filter((call) => call.path.endsWith("notes.txt")).length === 2);
  expect(calls.every((call) => !call.path.includes(".thumbnail-preview-"))).toBe(true);
});

test("browsed folders participate while denied files and repository-root speculation stay excluded", async () => {
  const { root, calls, background } = fixture();
  await until(() => calls.length === 1);
  mkdirSync(join(root, "reports"));
  writeFileSync(join(root, "reports", "report.md"), "# Report");
  writeFileSync(join(root, "reports", ".env"), "secret");
  writeFileSync(join(root, "reports", "opaque.bin"), Buffer.from([0, 1, 0]));
  background.touch("reports");
  await until(() => calls.some((call) => call.path === "reports/report.md"));
  background.touch("");
  expect(calls.every((call) => !call.path.endsWith(".env") && !call.path.endsWith(".bin"))).toBe(
    true,
  );
});
