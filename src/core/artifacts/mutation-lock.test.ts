import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { processStartToken } from "../agents/state/proc-start.ts";
import { withArtifactLock } from "./mutation-lock.ts";

const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "artifact-lock-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("artifact mutation lock", () => {
  test("records the process and refuses a live owner, then releases on exceptions", () => {
    const path = root();
    const lock = join(path, ".harnery/artifacts-mutation.lock");
    expect(() =>
      withArtifactLock(path, () => {
        const owner = JSON.parse(readFileSync(join(lock, readdirSync(lock)[0]!), "utf8"));
        expect(owner.pid).toBe(process.pid);
        expect(owner.host).toBe(hostname());
        expect(() => withArtifactLock(path, () => {})).toThrow("lock unavailable");
        throw new Error("action failed");
      }),
    ).toThrow("action failed");
    expect(existsSync(lock)).toBe(false);
    expect(withArtifactLock(path, () => 42)).toBe(42);
  });

  test("recovers after a child is killed while holding the lock", async () => {
    const path = root();
    const module = new URL("./mutation-lock.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `import { withArtifactLock } from ${JSON.stringify(module)};
      withArtifactLock(${JSON.stringify(path)}, () => { process.stdout.write("locked"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await Promise.race([
        once(child.stdout!, "data"),
        once(child, "exit").then(() => {
          throw new Error("child exited before acquiring lock");
        }),
      ]);
      expect(() => withArtifactLock(path, () => {})).toThrow();
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      expect(withArtifactLock(path, () => "recovered")).toBe("recovered");
    } finally {
      child.kill("SIGKILL");
    }
  }, 10_000);

  test("recovers a recycled PID but preserves a live PID with an unverifiable token", () => {
    const path = root();
    const lock = join(path, ".harnery/artifacts-mutation.lock");
    mkdirSync(lock, { recursive: true });
    const file = join(lock, "owner-11111111-1111-1111-1111-111111111111.json");
    const owner = {
      version: 1,
      host: hostname(),
      pid: process.pid,
      process_start: null as string | null,
    };
    writeFileSync(file, JSON.stringify(owner));
    expect(() => withArtifactLock(path, () => {})).toThrow();
    // A wall-clock token mismatch cannot safely prove a recycled live PID.
    writeFileSync(file, JSON.stringify({ ...owner, process_start: "pDifferent start time" }));
    expect(() => withArtifactLock(path, () => {})).toThrow();
    const token = processStartToken(process.pid);
    if (token && /^l[0-9a-f]{8}\.\d+$/.test(token)) {
      writeFileSync(file, JSON.stringify({ ...owner, process_start: `${token}1` }));
      expect(withArtifactLock(path, () => "recovered")).toBe("recovered");
    }
  });

  test("competing reapers never remove a replacement owner's lock", async () => {
    const path = root();
    const lock = join(path, ".harnery/artifacts-mutation.lock");
    mkdirSync(lock, { recursive: true });
    // A completed child gives us a real exited PID instead of guessing an unused one.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await once(dead, "exit");
    writeFileSync(
      join(lock, "owner-11111111-1111-1111-1111-111111111111.json"),
      JSON.stringify({
        version: 1,
        host: hostname(),
        pid: dead.pid,
        process_start: null,
      }),
    );
    const module = new URL("./mutation-lock.ts", import.meta.url).href;
    const children = Array.from({ length: 4 }, () =>
      spawn(
        process.execPath,
        [
          "-e",
          `
      import { withArtifactLock } from ${JSON.stringify(module)};
      import { openSync, closeSync, unlinkSync } from "node:fs";
      const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      for (let i = 0; i < 100; i++) {
        try {
          withArtifactLock(${JSON.stringify(path)}, () => {
            let fd;
            try { fd = openSync(${JSON.stringify(join(path, "critical-section"))}, "wx"); }
            catch { throw new Error("overlapping owners"); }
            pause(); closeSync(fd); unlinkSync(${JSON.stringify(join(path, "critical-section"))});
          });
          process.exit(0);
        } catch (error) {
          if (error.message.includes("overlapping owners")) process.exit(2);
          pause();
        }
      }
      process.exit(3);
    `,
        ],
        { stdio: "ignore" },
      ),
    );
    try {
      const results = await Promise.all(children.map((child) => once(child, "exit")));
      expect(results.map(([code]) => code)).toEqual([0, 0, 0, 0]);
      expect(existsSync(lock)).toBe(false);
    } finally {
      for (const child of children) child.kill("SIGKILL");
    }
  }, 10_000);

  test("never recovers an empty, foreign, malformed, or symlink lock", () => {
    for (const kind of ["empty", "foreign", "malformed", "symlink"]) {
      const path = root();
      const lock = join(path, ".harnery/artifacts-mutation.lock");
      mkdirSync(join(path, ".harnery"));
      if (kind === "symlink") symlinkSync(path, lock, "dir");
      else {
        mkdirSync(lock);
        if (kind !== "empty")
          writeFileSync(
            join(lock, "owner-11111111-1111-1111-1111-111111111111.json"),
            kind === "malformed"
              ? "{"
              : JSON.stringify({
                  version: 1,
                  host: "different-host",
                  pid: 999999,
                  process_start: null,
                }),
          );
      }
      expect(() =>
        withArtifactLock(path, () => {
          throw new Error("must not execute");
        }),
      ).toThrow("lock unavailable");
      expect(existsSync(lock)).toBe(true);
    }
  });
});
