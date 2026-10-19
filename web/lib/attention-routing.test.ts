import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ATTENTION_FRESH_MS, type AttentionObservation } from "./attention-client";
import {
  type AttentionPresence,
  acknowledgeAttention,
  claimAttention,
  observeAttention,
  selectAttentionClient,
} from "./attention-routing";

const roots: string[] = [];
const root = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attention-routing-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const observation = (
  clientId: string,
  extra: Partial<AttentionObservation> = {},
): AttentionObservation => ({
  clientId,
  eventKey: "att:copy",
  visible: false,
  focused: false,
  interaction: 0,
  holdingGeneration: null,
  ...extra,
});
const presence = (clientId: string, extra: Partial<AttentionPresence> = {}): AttentionPresence => ({
  ...observation(clientId),
  observedAt: 1000,
  interactionAt: null,
  ...extra,
});
const eventDir = (dir: string) =>
  path.join(
    dir,
    ".harnery/attention/events",
    createHash("sha256").update("att:copy").digest("hex"),
  );

describe("fresh client selection", () => {
  test("stale focused tab cannot absorb an alert from a fresh phone", () => {
    expect(
      selectAttentionClient(
        [
          presence("old-tab", { observedAt: 0, visible: true, focused: true, interactionAt: 0 }),
          presence("phone", { observedAt: 7000 }),
        ],
        "att:copy",
        7000,
      )?.clientId,
    ).toBe("phone");
  });
  test("future nonfinite and missing observations cannot win or suppress", () => {
    expect(
      selectAttentionClient(
        [
          presence("future", {
            observedAt: 1001,
            visible: true,
            focused: true,
            interactionAt: 1001,
          }),
          presence("nan", { observedAt: Number.NaN }),
          presence("valid"),
        ],
        "att:copy",
        1000,
      )?.clientId,
    ).toBe("valid");
    expect(selectAttentionClient([], "att:copy", 1000)).toBeNull();
    expect(
      selectAttentionClient([presence("a", { eventKey: "other" })], "att:copy", 1000),
    ).toBeNull();
  });
  test("engagement then visibility then recency then ID resolve ties deterministically", () => {
    const rows = [
      presence("b"),
      presence("a"),
      presence("visible", { visible: true }),
      presence("engaged", { visible: true, focused: true, interactionAt: 999 }),
    ];
    expect(selectAttentionClient(rows, "att:copy", 1000)?.clientId).toBe("engaged");
    expect(selectAttentionClient(rows.slice(0, 3), "att:copy", 1000)?.clientId).toBe("visible");
    expect(selectAttentionClient(rows.slice(0, 2).reverse(), "att:copy", 1000)?.clientId).toBe("a");
    expect(
      selectAttentionClient([presence("a"), presence("b", { observedAt: 1001 })], "att:copy", 1001)
        ?.clientId,
    ).toBe("b");
  });
});

describe("durable recipient generations", () => {
  test("a claim must name the selected generation before its first effect", () => {
    const dir = root(),
      selected = observeAttention(dir, observation("tab"), 1000);
    expect(claimAttention(dir, "att:copy", "tab", "old-generation", 1001).granted).toBe(false);
    expect(claimAttention(dir, "att:copy", "tab", selected.generation!, 1002).granted).toBe(true);
  });
  test("one current recipient and one claim survive duplicate polls and restarted readers", () => {
    const dir = root();
    const selected = observeAttention(dir, observation("tab-a"), 1000);
    expect(observeAttention(dir, observation("tab-b", { visible: true }), 1001).recipientId).toBe(
      "tab-a",
    );
    const claim = claimAttention(dir, "att:copy", "tab-a", selected.generation!, 1002);
    expect(claim.granted).toBe(true);
    expect(claimAttention(dir, "att:copy", "tab-a", selected.generation!, 1003).granted).toBe(
      false,
    );
    expect(claimAttention(dir, "att:copy", "tab-b", selected.generation!, 1003).granted).toBe(
      false,
    );
    const child = Bun.spawnSync([
      process.execPath,
      "-e",
      `import { claimAttention } from ${JSON.stringify(path.join(import.meta.dir, "attention-routing.ts"))}; console.log(JSON.stringify(claimAttention(${JSON.stringify(dir)}, "att:copy", "tab-a", ${JSON.stringify(selected.generation)}, 1004)))`,
    ]);
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(child.stdout)).granted).toBe(false);
  });
  test("recipient disappearance allows a fresh successor with the same event key", () => {
    const dir = root(),
      selected = observeAttention(dir, observation("tab-a"), 1000);
    claimAttention(dir, "att:copy", "tab-a", selected.generation!, 1001);
    const successor = observeAttention(dir, observation("phone"), 1000 + ATTENTION_FRESH_MS);
    expect(successor.recipientId).toBe("phone");
    expect(successor.eventKey).toBe("att:copy");
    expect(successor.generation).not.toBe(selected.generation);
    expect(claimAttention(dir, "att:copy", "phone", successor.generation!, 7001).granted).toBe(
      true,
    );
    expect(claimAttention(dir, "att:copy", "tab-a", selected.generation!, 7001).granted).toBe(
      false,
    );
  });
  test("lost grant cannot be kept alive by polls that never received its generation", () => {
    const dir = root(),
      selected = observeAttention(dir, observation("tab"), 1000);
    claimAttention(dir, "att:copy", "tab", selected.generation!, 1001);
    expect(observeAttention(dir, observation("tab"), 6999).generation).toBe(selected.generation);
    const recovered = observeAttention(dir, observation("tab"), 7000);
    expect(recovered.generation).not.toBe(selected.generation);
    expect(recovered.state).toBe("selected");
    expect(claimAttention(dir, "att:copy", "tab", recovered.generation!, 7001).granted).toBe(true);
  });
  test("a received generation renews without another grant", () => {
    const dir = root(),
      selected = observeAttention(dir, observation("tab"), 1000);
    claimAttention(dir, "att:copy", "tab", selected.generation!, 1001);
    const renewed = observeAttention(
      dir,
      observation("tab", { holdingGeneration: selected.generation }),
      6500,
    );
    expect(renewed.generation).toBe(selected.generation);
    expect(renewed.expiresAt).toBe(12500);
    expect(renewed.granted).toBe(false);
  });
  test("a late heartbeat cannot revive an expired generation", () => {
    const dir = root(),
      selected = observeAttention(dir, observation("tab"), 1000);
    claimAttention(dir, "att:copy", "tab", selected.generation!, 1001);
    const renewed = observeAttention(
      dir,
      observation("tab", { holdingGeneration: selected.generation }),
      7000,
    );
    expect(renewed.generation).not.toBe(selected.generation);
    expect(renewed.state).toBe("selected");
  });
  test("unchanged interaction counters cannot turn periodic polls into permanent engagement", () => {
    const dir = root(),
      input = observation("tab", { visible: true, focused: true, interaction: 1 });
    const selected = observeAttention(dir, input, 1000);
    expect(selected.engaged).toBe(true);
    claimAttention(dir, "att:copy", "tab", selected.generation!, 1000);
    for (const now of [3000, 5000, 7000, 9000]) {
      const reply = observeAttention(
        dir,
        { ...input, holdingGeneration: selected.generation },
        now,
      );
      if (now === 9000) expect(reply.engaged).toBe(false);
    }
    expect(
      observeAttention(
        dir,
        { ...input, holdingGeneration: selected.generation, interaction: 2 },
        9001,
      ).engaged,
    ).toBe(true);
  });
  test("acknowledgment before claim blocks delivery and never changes approval files", () => {
    const dir = root(),
      selected = observeAttention(dir, observation("tab"), 1000);
    const approval = path.join(dir, "approval.json");
    fs.writeFileSync(approval, '{"state":"pending"}');
    expect(acknowledgeAttention(dir, "att:copy", "tab", 1001).state).toBe("acknowledged");
    expect(claimAttention(dir, "att:copy", "tab", selected.generation!, 1002).granted).toBe(false);
    expect(observeAttention(dir, observation("phone"), 1003).state).toBe("acknowledged");
    expect(fs.readFileSync(approval, "utf8")).toBe('{"state":"pending"}');
  });
  test("event replacement invalidates old claims before successor selection", () => {
    const dir = root(),
      selected = observeAttention(dir, observation("tab"), 1000);
    observeAttention(dir, observation("tab", { eventKey: "att:new" }), 1001);
    expect(claimAttention(dir, "att:copy", "tab", selected.generation!, 1002).granted).toBe(false);
    const successor = observeAttention(dir, observation("phone"), 1003);
    expect(successor.recipientId).toBe("phone");
  });
  test("an absent recipient returns waiting while fresh successor observation always selects one", () => {
    const dir = root(),
      selected = observeAttention(dir, observation("tab"), 1000);
    const waiting = claimAttention(dir, "att:copy", "tab", selected.generation!, 7000);
    expect(waiting.state).toBe("waiting");
    expect(waiting.recipientId).toBeNull();
    expect(observeAttention(dir, observation("phone"), 7000).recipientId).toBe("phone");
  });
  test("a CAS loser rereads the winning revision instead of publishing a second recipient", () => {
    const dir = root();
    let injected = false;
    const link = fs.linkSync;
    const spy = spyOn(fs, "linkSync").mockImplementation((source, target) => {
      if (!injected && String(target).endsWith("000000000001.json")) {
        injected = true;
        fs.writeFileSync(
          target,
          JSON.stringify({
            revision: 1,
            eventKey: "att:copy",
            recipientId: "tab",
            generation: "winning-generation",
            selectedAt: 1000,
            claimed: false,
          }),
        );
      }
      return link(source, target);
    });
    try {
      expect(observeAttention(dir, observation("tab"), 1000).generation).toBe("winning-generation");
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(eventDir(dir)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });
  test("failed publication authorizes no effect and unpublished crash debris is ignored", () => {
    const dir = root();
    const link = spyOn(fs, "linkSync").mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    try {
      expect(() => observeAttention(dir, observation("tab"), 1000)).toThrow("disk unavailable");
    } finally {
      link.mockRestore();
    }
    fs.writeFileSync(path.join(eventDir(dir), "000000000001.json.crashed.tmp"), "partial");
    expect(observeAttention(dir, observation("tab"), 1001).state).toBe("selected");
  });
  test("malformed committed records and substituted event identity fail closed", () => {
    const dir = root();
    observeAttention(dir, observation("tab"), 1000);
    const file = path.join(eventDir(dir), "000000000001.json");
    fs.writeFileSync(file, "partial");
    expect(() => observeAttention(dir, observation("phone"), 1001)).toThrow();
    fs.writeFileSync(
      file,
      JSON.stringify({
        revision: 1,
        eventKey: "another",
        recipientId: "tab",
        generation: "gen",
        selectedAt: 1000,
        claimed: false,
      }),
    );
    expect(() => claimAttention(dir, "att:copy", "tab", "gen", 1001)).toThrow(
      "attention_revision_unreadable",
    );
  });
  test("competing fresh workers claim one generation once", async () => {
    const dir = root(),
      selected = observeAttention(dir, observation("tab"), 1000);
    const script = `import { claimAttention } from ${JSON.stringify(path.join(import.meta.dir, "attention-routing.ts"))};
      process.on("message", () => { console.log(JSON.stringify(claimAttention(${JSON.stringify(dir)}, "att:copy", "tab", ${JSON.stringify(selected.generation)}, 1001))); process.exit(0); }); process.send("ready");`;
    const children = Array.from({ length: 2 }, () => {
      let ready!: () => void;
      const prepared = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const child = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
        ipc(message) {
          if (message === "ready") ready();
        },
      });
      return { child, prepared };
    });
    try {
      await Promise.all(children.map(({ prepared }) => prepared));
      for (const { child } of children) child.send("claim");
      const results = await Promise.all(
        children.map(async ({ child }) => {
          const output = await new Response(child.stdout).text();
          expect(await child.exited).toBe(0);
          return JSON.parse(output);
        }),
      );
      expect(results.filter((value) => value.granted)).toHaveLength(1);
      expect(new Set(results.map((value) => value.generation)).size).toBe(1);
    } finally {
      for (const { child } of children) child.kill();
    }
  });
  test("a killed publisher leaves no partial revision and a killed granted client gets a fresh successor", async () => {
    for (const phase of ["before-publication", "after-grant"]) {
      const dir = root(),
        selected = observeAttention(dir, observation("tab"), 1000);
      const script = `import * as fs from "node:fs"; import { spyOn } from "bun:test";
        import { claimAttention } from ${JSON.stringify(path.join(import.meta.dir, "attention-routing.ts"))};
        const halt = () => { process.send("held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
        if (${JSON.stringify(phase)} === "before-publication") spyOn(fs, "linkSync").mockImplementation(() => halt());
        const result = claimAttention(${JSON.stringify(dir)}, "att:copy", "tab", ${JSON.stringify(selected.generation)}, 1001);
        if (!result.granted) throw new Error("expected original grant"); halt();`;
      let held!: () => void;
      const reached = new Promise<void>((resolve) => {
        held = resolve;
      });
      const child = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
        ipc(message) {
          if (message === "held") held();
        },
      });
      try {
        await reached;
        child.kill("SIGKILL");
        await child.exited;
        const retry = claimAttention(dir, "att:copy", "tab", selected.generation!, 1002);
        expect(retry.granted).toBe(phase === "before-publication");
        const successor = observeAttention(dir, observation("phone"), 7000);
        expect(successor.recipientId).toBe("phone");
        expect(claimAttention(dir, "att:copy", "phone", successor.generation!, 7001).granted).toBe(
          true,
        );
      } finally {
        child.kill();
      }
    }
  });
});
