import { describe, expect, test } from "bun:test";
import { checkPidToken, processStartToken } from "./proc-start.ts";

/** A pid nothing is using, so no token can be read for it. */
function deadPid(): number {
  for (let candidate = 30000; candidate < 40000; candidate++) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no unused pid found");
}

describe("processStartToken", () => {
  test("reads a stable token for a live process", () => {
    const first = processStartToken(process.pid);
    expect(first).toBeTruthy();
    // Start instants do not move. A token that drifts between reads would
    // invalidate every row it was ever compared against.
    expect(processStartToken(process.pid)).toBe(first!);
  });

  test("tags the token by probe, so two platforms are never compared", () => {
    expect(processStartToken(process.pid)).toMatch(/^[lp]/);
  });

  test("declines to guess for a dead pid or a nonsense one", () => {
    expect(processStartToken(deadPid())).toBeNull();
    expect(processStartToken(0)).toBeNull();
    expect(processStartToken(-1)).toBeNull();
  });
});

describe("checkPidToken", () => {
  test("matches the token it just read", () => {
    const token = processStartToken(process.pid)!;
    expect(checkPidToken(process.pid, token)).toBe("match");
  });

  test("calls a re-issued pid a mismatch, not a live row", () => {
    // The distinction this whole module exists for: the pid is alive, and the
    // row is still wrong.
    expect(checkPidToken(process.pid, "l1")).toBe("mismatch");
  });

  test("says unverified rather than mismatch when either side is missing", () => {
    expect(checkPidToken(process.pid, undefined)).toBe("unverified");
    expect(checkPidToken(process.pid, "")).toBe("unverified");
    // Nothing to read for a dead pid, so the recorded token cannot be refuted.
    expect(checkPidToken(deadPid(), "l12345")).toBe("unverified");
  });
});
