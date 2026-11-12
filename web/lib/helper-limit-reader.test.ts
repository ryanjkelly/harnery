import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetCoordRootCache } from "./coord-reader";
import { helperLimitReportFixture } from "./helper-limit-fixture";
import { readHelperLimitReport } from "./helper-limit-reader";

describe.skipIf(process.platform === "win32")("readHelperLimitReport", () => {
  let root = "";
  let previousRoot: string | undefined;
  const harn = (body: string) => {
    const file = path.join(root, "bin", "harn");
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };

  beforeEach(() => {
    previousRoot = process.env.HARNERY_COORD_ROOT;
    root = mkdtempSync(path.join(tmpdir(), "helper-limit-reader-"));
    mkdirSync(path.join(root, ".harnery"));
    mkdirSync(path.join(root, "bin"));
    process.env.HARNERY_COORD_ROOT = root;
    __resetCoordRootCache();
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
    else process.env.HARNERY_COORD_ROOT = previousRoot;
    __resetCoordRootCache();
    rmSync(root, { recursive: true, force: true });
  });

  test("runs the read command and returns the validated report", async () => {
    const report = helperLimitReportFixture();
    writeFileSync(path.join(root, "report.json"), JSON.stringify(report));
    harn(
      `[ "$*" = "devtools helpers --format json" ] || { echo "bad args: $*" >&2; exit 2; }\ncat "${path.join(root, "report.json")}"`,
    );
    expect(await readHelperLimitReport()).toEqual(report);
  });

  test("returns null when the command fails or prints something else", async () => {
    harn('echo "error: too many arguments" >&2; exit 1');
    expect(await readHelperLimitReport()).toBeNull();
    harn('echo "{\\"tool\\":\\"claude-code\\"}"');
    expect(await readHelperLimitReport()).toBeNull();
  });
});
