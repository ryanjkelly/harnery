import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3, rotateOversizedEventLedgerV3 } from "./bootstrap.ts";
import { sha256V3 } from "./canonical.ts";
import { withGenerationCustodyV3 } from "./generation-custody.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root() {
  const value = mkdtempSync(join(tmpdir(), "generation-custody-"));
  roots.push(value);
  return value;
}

function child(coordRoot: string, instance: string, crash = false) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `
    import { withGenerationCustodyV3 } from ${JSON.stringify(new URL("./generation-custody.ts", import.meta.url).href)};
    withGenerationCustodyV3(${JSON.stringify(coordRoot)}, [${JSON.stringify(instance)}], () => {
      ${crash ? 'process.kill(process.pid, "SIGKILL");' : 'process.stdout.write("acquired");'}
    });
  `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
}

test("same-instance custody excludes a second process while unrelated instances progress", () => {
  const coordRoot = root();
  withGenerationCustodyV3(coordRoot, ["inst_first"], () => {
    expect(withGenerationCustodyV3(coordRoot, ["inst_first"], () => "nested")).toBe("nested");
    const other = child(coordRoot, "inst_second");
    expect(other.status).toBe(0);
    expect(other.stdout).toBe("acquired");
    const conflict = child(coordRoot, "inst_first");
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain("live or unexpired owner");
  });
  expect(child(coordRoot, "inst_first").status).toBe(0);
});

test("a killed local custody owner can be recovered without a timing wait", () => {
  const coordRoot = root();
  const killed = child(coordRoot, "inst_crashed", true);
  expect(killed.signal).toBe("SIGKILL");
  expect(withGenerationCustodyV3(coordRoot, ["inst_crashed"], () => "recovered")).toBe("recovered");
});

test("custody excludes the same instance across epoch rotation while other instances progress", () => {
  const coordRoot = root();
  initializeEventLedgerV3({
    coordRoot,
    harneryBuild: "custody-rotation-fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("custody-rotation-config"),
    approvalRecordId: "fixture-custody-rotation",
  });
  withGenerationCustodyV3(coordRoot, ["inst_rotating"], () => {
    expect(rotateOversizedEventLedgerV3(coordRoot, { thresholdBytes: 1 }).state).toBe("rotated");
    const conflict = child(coordRoot, "inst_rotating");
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toContain("live or unexpired owner");
    const other = child(coordRoot, "inst_independent");
    expect(other.status).toBe(0);
    expect(other.stdout).toBe("acquired");
  });
  expect(child(coordRoot, "inst_rotating").status).toBe(0);
});
