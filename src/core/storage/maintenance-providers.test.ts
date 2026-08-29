import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "./catalog.ts";
import {
  HARNERY_MAINTENANCE_CURSOR_SCHEMA,
  HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
  type HarneryMaintenanceAction,
  type HarneryMaintenanceProvider,
  writePressureSummary,
} from "./maintenance.ts";
import {
  createAutomaticMaintenanceComposition,
  createExistingMaintenanceProviders,
  createStructuredLogMaintenanceProviders,
  runAutomaticMaintenancePass,
} from "./maintenance-providers.ts";

const roots: string[] = [];
const originalSwitch = process.env.HARNERY_SESSIONSTART_MAINTENANCE;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalSwitch === undefined) delete process.env.HARNERY_SESSIONSTART_MAINTENANCE;
  else process.env.HARNERY_SESSIONSTART_MAINTENANCE = originalSwitch;
});

describe("automatic maintenance provider composition", () => {
  test("dormant and process-disabled repositories perform no writes", async () => {
    const root = fixture();
    const composition = createAutomaticMaintenanceComposition(root, noops());
    expect(await runAutomaticMaintenancePass(composition)).toMatchObject({
      ran: false,
      reason: "no-pressure",
    });
    expect(existsSync(join(root, ".harnery"))).toBeFalse();
    process.env.HARNERY_SESSIONSTART_MAINTENANCE = "0";
    expect(await runAutomaticMaintenancePass(composition)).toMatchObject({
      ran: false,
      reason: "disabled",
    });
    expect(existsSync(join(root, ".harnery"))).toBeFalse();
  });

  test("existing owner providers plan bounded explicit-only destructive work", async () => {
    let calls = 0;
    const providers = createExistingMaintenanceProviders({
      journal: () => {
        calls += 1;
      },
      images: () => {},
      artifacts: () => {},
    });
    const plan = await providers[0]!.plan({
      coord_root: fixture(),
      pressure: pressureRow("journal-history", 1_000, 100),
      budget: { max_duration_ms: 10, max_files: 3, max_bytes: 20 },
      now: new Date("2026-08-29T23:59:00.000Z"),
    });
    expect(plan.actions[0]).toMatchObject({
      family_id: "journal-history",
      files: 3,
      bytes: 20,
      destructive: true,
      metadata: { activation: "explicit-only" },
    });
    expect(calls).toBe(0);
  });

  test("keeps structured-log deletion providers out of automatic composition", () => {
    const root = fixture();
    const catalog = createStorageCatalog({ coord_root: root, project_root: root });
    const structured = createStructuredLogMaintenanceProviders(catalog);
    expect(structured.length).toBeGreaterThan(0);
    expect(
      structured.every(({ destructive_scope }) => destructive_scope === "structured-log-retention"),
    ).toBeTrue();
    expect(
      createAutomaticMaintenanceComposition(root, noops()).providers.some(
        ({ destructive_scope }) => destructive_scope === "structured-log-retention",
      ),
    ).toBeFalse();
  });

  test("one daily claim plans work without invoking destructive providers", async () => {
    const root = fixture();
    writePressureSummary(root, pressure("storage-maintenance-run-log"));
    let applied = 0;
    const provider = fixtureProvider(() => {
      applied += 1;
    });
    const composition = {
      catalog: createStorageCatalog({ coord_root: root, project_root: root }),
      providers: [provider],
    };
    const now = new Date("2026-08-29T12:00:00.000Z");
    expect(await runAutomaticMaintenancePass(composition, { now })).toMatchObject({
      ran: true,
      reason: "planned",
      actions: 1,
    });
    expect(await runAutomaticMaintenancePass(composition, { now })).toMatchObject({
      ran: false,
      reason: "fresh",
    });
    expect(applied).toBe(0);
  });

  test("concurrent starts elect one planner", async () => {
    const root = fixture();
    writePressureSummary(root, pressure("storage-maintenance-run-log"));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = fixtureProvider(undefined, async () => {
      await gate;
      return { actions: [action()] };
    });
    const composition = {
      catalog: createStorageCatalog({ coord_root: root, project_root: root }),
      providers: [provider],
    };
    const now = new Date("2026-08-29T12:01:00.000Z");
    const first = runAutomaticMaintenancePass(composition, { now });
    await Bun.sleep(20);
    expect(await runAutomaticMaintenancePass(composition, { now })).toMatchObject({
      ran: false,
      reason: "contended",
    });
    release?.();
    expect((await first).reason).toBe("planned");
  });

  test("stale interrupted claims resume without applying owner work", async () => {
    const root = fixture();
    writePressureSummary(root, pressure("storage-maintenance-run-log"));
    const cursors = join(root, ".harnery", "maintenance", "cursors");
    mkdirSync(cursors, { recursive: true });
    writeFileSync(
      join(cursors, "daily.json"),
      `${JSON.stringify({ schema: HARNERY_MAINTENANCE_CURSOR_SCHEMA, state: "running", claimed_at: "2026-08-29T11:00:00.000Z", transaction_id: "missing-transaction" })}\n`,
    );
    let applied = 0;
    const composition = {
      catalog: createStorageCatalog({ coord_root: root, project_root: root }),
      providers: [
        fixtureProvider(() => {
          applied += 1;
        }),
      ],
    };
    const result = await runAutomaticMaintenancePass(composition, {
      now: new Date("2026-08-29T12:00:00.000Z"),
    });
    expect(result.reason).toBe("planned");
    expect(readdirSync(cursors).some((name) => name.startsWith("daily.interrupted-"))).toBeTrue();
    expect(JSON.parse(readFileSync(join(cursors, "daily.json"), "utf8")).state).toBe("complete");
    expect(applied).toBe(0);
  });

  test("project kill switch prevents a claimed pass", async () => {
    const root = fixture();
    writePressureSummary(root, pressure("storage-maintenance-run-log"));
    writeFileSync(join(root, ".harnery", "maintenance.disabled"), "disabled\n");
    const composition = {
      catalog: createStorageCatalog({ coord_root: root, project_root: root }),
      providers: [fixtureProvider()],
    };
    expect(await runAutomaticMaintenancePass(composition)).toMatchObject({
      ran: false,
      reason: "disabled",
    });
    expect(existsSync(join(root, ".harnery", "maintenance", "cursors", "daily.json"))).toBeFalse();
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-maintenance-providers-"));
  roots.push(root);
  return root;
}

function noops() {
  return { journal: () => {}, images: () => {}, artifacts: () => {} };
}

function pressure(familyId: string) {
  return {
    schema: HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
    captured_at: "2026-08-29T12:00:00.000Z",
    families: [pressureRow(familyId, 1_000, 10)],
  } as const;
}

function pressureRow(family_id: string, logical_bytes: number, regular_files: number) {
  return {
    family_id,
    logical_bytes,
    regular_files,
    needs_maintenance: true,
    observed_at: "2026-08-29T12:00:00.000Z",
  } as const;
}

function action(): HarneryMaintenanceAction {
  return {
    action_id: "destructive-canary",
    family_id: "storage-maintenance-run-log",
    kind: "delete",
    target_ref: "canary",
    files: 1,
    bytes: 10,
    destructive: true,
    authorization_scope: "fixture-owner-delete",
  };
}

function fixtureProvider(
  apply: (() => void) | undefined = undefined,
  plan: HarneryMaintenanceProvider["plan"] = () => ({ actions: [action()] }),
): HarneryMaintenanceProvider {
  return {
    family_id: "storage-maintenance-run-log",
    destructive_scope: "fixture-owner-delete",
    plan,
    apply: () => {
      apply?.();
      return { outcome: "applied" };
    },
  };
}
