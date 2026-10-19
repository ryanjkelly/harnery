/**
 * bun test preload: give this test process its own temporary directory and
 * delete it when the run ends.
 *
 * Tests make scratch folders with mkdtempSync(join(tmpdir(), ...)) and many
 * never remove them; on 2026-10-19 the shared temporary directory held more
 * than 400,000 of them. Pointing TMPDIR at a per-process folder collects all
 * of that in one place, including what spawned children write. A run that
 * dies before cleanup leaves its folder behind; the next run removes it once
 * its process is gone.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = tmpdir();
const PREFIX = "bun-test-";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

for (const name of readdirSync(base)) {
  const pid = Number(/^bun-test-(\d+)-/.exec(name)?.[1]);
  if (pid && pid !== process.pid && !alive(pid)) {
    rmSync(join(base, name), { recursive: true, force: true });
  }
}

const dir = mkdtempSync(join(base, `${PREFIX}${process.pid}-`));
process.env.TMPDIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
