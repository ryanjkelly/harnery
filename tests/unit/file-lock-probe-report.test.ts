// Reporting-only: measures which error codes Windows returns when an
// exclusive lock create races a concurrent release. It logs histograms and
// always passes. Temporary; removed once the result is recorded.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = join(import.meta.dir, "..", "fixtures", "file-lock-probe", "probe.mjs");

test.skipIf(process.platform !== "win32")(
  "file lock race probe (reporting only)",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "file-lock-probe-"));
    try {
      const result = spawnSync(
        process.execPath,
        [probe, "--workers", "6", "--modes", "mkdir,openwx,writewx", "--dir", dir],
        { encoding: "utf8", timeout: 280_000 },
      );
      for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
        if (line.startsWith("PROBE")) console.log(`FILE_LOCK_PROBE ${line}`);
      }
      console.log(`FILE_LOCK_PROBE exit=${result.status} signal=${result.signal}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(true).toBe(true);
  },
  300_000,
);
