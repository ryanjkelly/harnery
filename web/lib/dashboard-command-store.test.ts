import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandIntent } from "./dashboard-command-protocol";
import {
  CommandConflict,
  dashboardActionResponse,
  executeDashboardCommand,
  readDashboardCommand,
} from "./dashboard-command-store";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dashboard-custody-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function intent(): CommandIntent {
  return {
    command_id: "receipt-fixture",
    project_root: root,
    action: "ping",
    arguments: { instance_id: "fixture", message: "once" },
  };
}

describe("durable dashboard command custody", () => {
  test("concurrent retries observe pending and replay the exact settled refusal", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const original = executeDashboardCommand(root, intent(), async () => {
      calls++;
      await waiting;
      return { ok: false, error: "owner refused" };
    });
    const retry = await executeDashboardCommand(root, intent(), () => {
      calls++;
      return { ok: true };
    });
    expect(retry.state).toBe("pending");
    finish();
    const settled = await original;
    expect(
      await executeDashboardCommand(root, intent(), () => {
        calls++;
        return {};
      }),
    ).toEqual(settled);
    expect(settled.result).toEqual({ ok: false, error: "owner refused" });
    expect(calls).toBe(1);
  });

  test("the claimed id cannot change action, target, message or project", async () => {
    await executeDashboardCommand(root, intent(), () => ({ ok: true }));
    let calls = 0;
    for (const changed of [
      { ...intent(), action: "end-session" as const },
      { ...intent(), arguments: { instance_id: "replacement", message: "once" } },
      { ...intent(), arguments: { instance_id: "fixture", message: "different" } },
      { ...intent(), project_root: "other-project" },
    ])
      await expect(
        executeDashboardCommand(root, changed, () => {
          calls++;
          return {};
        }),
      ).rejects.toBeInstanceOf(CommandConflict);
    expect(calls).toBe(0);
    expect(readDashboardCommand(root, intent().command_id)?.result).toEqual({ ok: true });
  });

  test("an effect that throws after writing remains unknown and cannot repeat", async () => {
    const marker = path.join(root, "effect");
    const first = await executeDashboardCommand(root, intent(), () => {
      appendFileSync(marker, "one\n");
      throw new Error("lost outcome");
    });
    expect(first.state).toBe("unknown");
    expect(
      await executeDashboardCommand(root, intent(), () => {
        appendFileSync(marker, "two\n");
        return {};
      }),
    ).toMatchObject({ state: "unknown" });
    expect(readFileSync(marker, "utf8")).toBe("one\n");
    expect(readDashboardCommand(root, intent().command_id)?.result).toBeUndefined();
  });

  async function worker(mode: string) {
    const source = `import { executeDashboardCommand } from ${JSON.stringify(import.meta.resolve("./dashboard-command-store.ts"))};
      import { appendFileSync } from "node:fs";
      const i = JSON.parse(process.env.DASHBOARD_TEST_INTENT);
      const result = await executeDashboardCommand(process.env.DASHBOARD_TEST_ROOT, i, () => {
        appendFileSync(process.env.DASHBOARD_TEST_ROOT + "/effect", "effect\\n");
        if (process.env.DASHBOARD_TEST_MODE === "crash") process.exit(9);
        return { ok: true, receipt: "exact-first-result" };
      }); console.log(JSON.stringify(result));`;
    const child = Bun.spawn([process.execPath, "--eval", source], {
      env: {
        ...process.env,
        DASHBOARD_TEST_INTENT: JSON.stringify(intent()),
        DASHBOARD_TEST_ROOT: root,
        DASHBOARD_TEST_MODE: mode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  }

  test("a fresh process replays the durable receipt without invoking the helper", async () => {
    const first = await worker("settle");
    const second = await worker("settle");
    expect(first.exit).toBe(0);
    expect(first.stderr).toBe("");
    expect(second.exit).toBe(0);
    expect(second.stderr).toBe("");
    expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
    expect(readFileSync(path.join(root, "effect"), "utf8")).toBe("effect\n");
  });

  test("a worker exiting after its effect cannot be redispatched by a fresh process", async () => {
    const crashed = await worker("crash");
    const recovered = await worker("settle");
    expect(crashed.exit).toBe(9);
    expect(recovered.exit).toBe(0);
    expect(recovered.stderr).toBe("");
    expect(JSON.parse(recovered.stdout)).toMatchObject({ state: "unknown" });
    expect(readFileSync(path.join(root, "effect"), "utf8")).toBe("effect\n");
  });

  test("old unconfirmed claims are not expired and damaged receipts fail closed", async () => {
    await worker("crash");
    const claim = path.join(root, ".harnery/dashboard-commands/receipt-fixture.intent.json");
    utimesSync(claim, new Date(0), new Date(0));
    expect(readDashboardCommand(root, intent().command_id)?.state).toBe("unknown");
    writeFileSync(claim, "{");
    let called = false;
    await expect(
      executeDashboardCommand(root, intent(), () => {
        called = true;
        return {};
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
    expect(existsSync(claim)).toBe(true);
  });

  test("API validation refuses missing identity and root drift before dispatch", async () => {
    let calls = 0;
    for (const body of [
      {},
      { command_id: "../bad", project_root: root },
      { command_id: "good", project_root: "other" },
      { command_id: "good", project_root: root, instance_id: "fixture", extra: "ignored?" },
    ]) {
      const response = await dashboardActionResponse(
        root,
        "end-session",
        body,
        { instance_id: "fixture" },
        () => {
          calls++;
          return {};
        },
      );
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
    expect(readDashboardCommand(root, "good")).toBeNull();
  });
});
