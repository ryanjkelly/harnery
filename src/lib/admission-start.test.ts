import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import {
  acquireAdmission,
  admissionStartIdentityApplies,
  holderPidReused,
  holderStartToken,
} from "./admission.ts";

describe("admission holder identity without /proc", () => {
  test("a recorded start time that no longer matches the live pid marks a reused pid", () => {
    expect(holderPidReused({ pid: 42, start: "Mon" }, true, () => "Tue", 0)).toBe(true);
  });

  test("a matching, unreadable, or unrecorded start time keeps the holder", () => {
    expect(holderPidReused({ pid: 43, start: "Mon" }, true, () => "Mon", 0)).toBe(false);
    expect(holderPidReused({ pid: 44, start: "Mon" }, true, () => null, 0)).toBe(false);
    expect(holderPidReused({ pid: 45 }, true, () => "Tue", 0)).toBe(false);
  });

  test("with /proc present nothing is recorded or compared", () => {
    expect(holderStartToken(1, false, () => "Mon")).toBeUndefined();
    expect(holderPidReused({ pid: 46, start: "Mon" }, false, () => "Tue", 0)).toBe(false);
  });

  test("a confirmed holder is not probed again within the confirmation window", () => {
    let reads = 0;
    const read = () => {
      reads += 1;
      return "Mon";
    };
    holderPidReused({ pid: 47, start: "Mon" }, true, read, 1_000);
    holderPidReused({ pid: 47, start: "Mon" }, true, read, 2_000);
    expect(reads).toBe(1);
  });

  test("this platform's default probe agrees with the platform", () => {
    expect(admissionStartIdentityApplies()).toBe(
      process.platform !== "win32" && process.platform !== "linux",
    );
  });

  test.if(process.platform !== "win32")(
    "the ps reader returns a stable start for this process",
    () => {
      const first = holderStartToken(process.pid, true);
      expect(first).toBeTruthy();
      expect(holderStartToken(process.pid, true)).toBe(first);
    },
  );

  test("a held ticket keeps its slot when nothing is recorded (Linux path unchanged)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harnery-admission-start-"));
    try {
      const held = join(dir, "build", "held");
      mkdirSync(held, { recursive: true });
      mkdirSync(join(dir, "build", "tickets"), { recursive: true });
      writeFileSync(
        join(held, `${String(Date.now()).padStart(13, "0")}-${process.pid}-aaaaaaaa.json`),
        JSON.stringify({ pid: process.pid, label: "self", created_at: new Date().toISOString() }),
      );
      const attempt = acquireAdmission(
        { dir, resource: "build", capacity: 1, pollMs: 10, historyDir: null },
        { label: "second", timeoutMs: 100 },
      );
      await expect(attempt).rejects.toThrow();
      expect(readdirSync(held)).toHaveLength(1);
    } finally {
      removeDir(dir);
    }
  });
});
