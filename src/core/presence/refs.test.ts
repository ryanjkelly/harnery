import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { registerPresenceCommand } from "../../commands/presence.ts";
import * as transport from "./git.ts";
import { fetchMachineRefs, readMachineRefs } from "./git.ts";
import { readRemoteMachines } from "./index.ts";
import { deleteMachineRef, listMachineRefs, parseRefPruneAge, pruneMachineRefs } from "./refs.ts";

const DAY = 86_400_000;
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
let base: string;
let origin: string;
let writer: string;
let reader: string;
const saved: Record<string, string | undefined> = {};

function git(root: string, args: string[], input?: string, date = now): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ref-test",
      GIT_AUTHOR_EMAIL: "ref-test@example.invalid",
      GIT_COMMITTER_NAME: "ref-test",
      GIT_COMMITTER_EMAIL: "ref-test@example.invalid",
      GIT_AUTHOR_DATE: date.toISOString(),
      GIT_COMMITTER_DATE: date.toISOString(),
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function seed(
  namespace: "presence" | "mail" | "docket",
  machine: string,
  days = 45,
  body?: unknown,
): string {
  const tree = git(writer, ["mktree"], "");
  const date = new Date(now.getTime() - days * DAY);
  const payload = body ?? {
    v: 1,
    machine,
    published_at: date.toISOString(),
    agents: [{ instance_id: "peer", activity: "idle", task_state: "active" }],
  };
  const sha = git(writer, ["commit-tree", tree], JSON.stringify(payload), date);
  git(writer, ["push", "--quiet", "origin", `+${sha}:refs/harnery/${namespace}/${machine}`]);
  return sha;
}

function mail(
  machine: string,
  outbox: Array<{ id: string; days: number; to?: string }> = [],
  acks: string[] = [],
): unknown {
  return {
    v: 1,
    machine,
    published_at: now.toISOString(),
    acks,
    outbox: outbox.map((entry) => ({
      schema: "harnery.mail-envelope/v1",
      message_id: entry.id,
      from_machine: machine,
      to_machine: entry.to ?? "receiver",
      sender_instance_id: "sender",
      sender_display_name: "Sender",
      recipient_instance_id: "recipient",
      recipient_display_name: "Recipient",
      created_at: new Date(now.getTime() - entry.days * DAY).toISOString(),
      body: "hello",
      body_bytes: 5,
    })),
  };
}

function remoteRefs(): string[] {
  return git(origin, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "harnery-refs-"));
  origin = join(base, "origin.git");
  writer = join(base, "writer");
  reader = join(base, "reader");
  git(base, ["init", "--bare", origin]);
  for (const clone of [writer, reader]) {
    git(base, ["init", clone]);
    git(clone, ["remote", "add", "origin", origin]);
    mkdirSync(join(clone, ".harnery"));
  }
  for (const key of ["HARNERY_MACHINE", "HARNERY_COORD_ROOT_OVERRIDE", "HARNERY_PRESENCE"]) {
    saved[key] = process.env[key];
  }
  process.env.HARNERY_MACHINE = "This Machine";
  process.env.HARNERY_COORD_ROOT_OVERRIDE = reader;
  process.env.HARNERY_PRESENCE = "1";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeDir(base);
});

describe("machine ref retirement", () => {
  test("lists all namespaces from origin with commit age and sanitized ownership", () => {
    seed("presence", "old", 45, { published_at: now.toISOString() });
    seed("docket", "this-machine");
    seed("mail", "old", 45, mail("old"));
    const result = listMachineRefs(reader, now);
    expect(result.machine).toBe("this-machine");
    expect(result.refs).toHaveLength(3);
    expect(result.refs.find((row) => row.namespace === "presence")).toMatchObject({
      age_secs: (45 * DAY) / 1000,
      own: false,
    });
    expect(result.refs.find((row) => row.namespace === "docket")).toMatchObject({
      machine: "this-machine",
      own: true,
    });
    expect(git(reader, ["for-each-ref", "--format=%(refname)"])).toBe("");
  });

  test("defaults to a 30-day preview, preserving all refs and protecting self", () => {
    seed("presence", "old");
    seed("docket", "recent", 29);
    seed("mail", "this-machine", 90, mail("this-machine"));
    const before = remoteRefs();
    const result = pruneMachineRefs(reader, { now });
    expect(result).toMatchObject({ older_than: "30d", preview: true, deleted: [], failed: [] });
    expect(result.refs.filter((row) => row.would_delete).map((row) => row.ref)).toEqual([
      "refs/harnery/presence/old",
    ]);
    expect(result.refs.find((row) => row.machine === "this-machine")?.reason).toBe("own machine");
    expect(remoteRefs()).toEqual(before);
  });

  test("refuses short or malformed durations before any remote operation", () => {
    git(reader, ["remote", "remove", "origin"]);
    for (const duration of ["0d", "14m", "899s", "-30d", "30", "1month", "Infinityd", "1e5s"]) {
      expect(() => pruneMachineRefs(reader, { olderThan: duration, yes: true })).toThrow(
        "at least 15m",
      );
    }
    expect(parseRefPruneAge("15m")).toBe(900_000);
    expect(parseRefPruneAge("1.5h")).toBe(5_400_000);
  });

  test("does not delete refs at the cutoff, younger refs, or future commits", () => {
    seed("presence", "cutoff", 30);
    seed("presence", "recent", 1);
    seed("presence", "future", -1);
    const result = pruneMachineRefs(reader, { now, yes: true });
    expect(result.deleted).toEqual([]);
    expect(remoteRefs()).toHaveLength(3);
  });

  test("protects this clone's suffixed and renamed docket refs", () => {
    const stateDir = join(reader, ".harnery", "presence");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "docket-machine-id"), "abcdef123456\n");
    writeFileSync(
      join(stateDir, "docket-state.json"),
      JSON.stringify({ ref: "previous-label-abcdef" }),
    );
    seed("docket", "this-machine-abcdef");
    seed("docket", "previous-label-abcdef");
    seed("docket", "another-old-label", 45, { machine_id: "abcdef123456" });
    seed("docket", "peer");
    const result = pruneMachineRefs(reader, { now, yes: true });
    expect(result.deleted).toEqual(["refs/harnery/docket/peer"]);
    expect(result.refs.filter((row) => row.own)).toHaveLength(3);
    const row = result.refs.find((entry) => entry.machine === "this-machine-abcdef")!;
    expect(deleteMachineRef(reader, { ...row, own: false }).ok).toBe(false);
  });

  test("protects undelivered unexpired mail and reports loss with include-mail", () => {
    seed(
      "mail",
      "sender",
      3,
      mail("sender", [
        { id: "live", days: 2 },
        { id: "expired", days: 15 },
      ]),
    );
    const preview = pruneMachineRefs(reader, { now, olderThan: "1d" });
    expect(preview.refs[0]).toMatchObject({
      would_delete: false,
      undelivered_mail: 1,
      mail_messages_lost: 0,
    });
    const included = pruneMachineRefs(reader, { now, olderThan: "1d", includeMail: true });
    expect(included.refs[0]).toMatchObject({
      would_delete: true,
      undelivered_mail: 1,
      mail_messages_lost: 1,
    });
    expect(remoteRefs()).toHaveLength(1);
    const deleted = pruneMachineRefs(reader, {
      now,
      olderThan: "1d",
      includeMail: true,
      yes: true,
    });
    expect(deleted.deleted).toEqual(["refs/harnery/mail/sender"]);
  });

  test("only the recipient's acknowledgement makes unexpired mail delivered", () => {
    seed(
      "mail",
      "sender",
      3,
      mail("sender", [
        { id: "delivered", days: 2 },
        { id: "waiting", days: 2 },
      ]),
    );
    seed("mail", "receiver", 0, mail("receiver", [], ["delivered"]));
    seed("mail", "other", 0, mail("other", [], ["waiting"]));
    const result = pruneMachineRefs(reader, { now, olderThan: "1d" });
    expect(result.refs.find((row) => row.machine === "sender")).toMatchObject({
      undelivered_mail: 1,
      would_delete: false,
    });
  });

  test("deletes expired or acknowledged mail without include-mail", () => {
    seed("mail", "expired", 45, mail("expired", [{ id: "expired", days: 14 }]));
    seed("mail", "delivered", 45, mail("delivered", [{ id: "done", days: 1 }]));
    seed("mail", "receiver", 0, mail("receiver", [], ["done"]));
    const result = pruneMachineRefs(reader, { now, yes: true });
    expect(result.deleted).toEqual(["refs/harnery/mail/delivered", "refs/harnery/mail/expired"]);
    expect(remoteRefs()).toEqual(["refs/harnery/mail/receiver"]);
  });

  test("skips unreadable mail even with include-mail", () => {
    seed("mail", "broken", 45, { v: 1, machine: "broken", outbox: [{}], acks: [] });
    const result = pruneMachineRefs(reader, { now, yes: true, includeMail: true });
    expect(result.refs[0]).toMatchObject({
      would_delete: false,
      undelivered_mail: null,
      reason: "cannot verify mail contents",
    });
    expect(result.deleted).toEqual([]);
  });

  test("deletes exact eligible refs remotely and locally, preserving self and branches", () => {
    const sha = seed("presence", "old");
    seed("docket", "old");
    seed("presence", "old-neighbor", 1);
    for (const namespace of ["presence", "mail", "docket"] as const) {
      seed(namespace, "this-machine", 90, namespace === "mail" ? mail("this-machine") : undefined);
    }
    git(writer, ["push", "--quiet", "origin", `${sha}:refs/heads/keep`]);
    expect(fetchMachineRefs(reader, { sync: true }).ok).toBe(true);
    const result = pruneMachineRefs(reader, { now, yes: true, includeMail: true });
    expect(result.deleted).toEqual(["refs/harnery/docket/old", "refs/harnery/presence/old"]);
    expect(result.failed).toEqual([]);
    expect(remoteRefs()).toContain("refs/heads/keep");
    expect(readMachineRefs(reader).map((row) => row.machine)).toEqual([
      "old-neighbor",
      "this-machine",
    ]);
  });

  test("a rejected deletion reports failure and continues to the next exact ref", () => {
    seed("presence", "a-blocked");
    seed("presence", "b-delete");
    expect(fetchMachineRefs(reader, { sync: true }).ok).toBe(true);
    writeFileSync(
      join(origin, "hooks", "pre-receive"),
      '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in refs/harnery/presence/a-blocked) echo "protected ref" >&2; exit 1;; esac\ndone\n',
      { mode: 0o755 },
    );
    const result = pruneMachineRefs(reader, { now, yes: true });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.ref).toBe("refs/harnery/presence/a-blocked");
    expect(result.deleted).toEqual(["refs/harnery/presence/b-delete"]);
    expect(readMachineRefs(reader).map((row) => row.machine)).toEqual(["a-blocked"]);
  });

  test("leases reject a ref refreshed after inspection and retain its local value", () => {
    seed("presence", "peer");
    expect(fetchMachineRefs(reader, { sync: true }).ok).toBe(true);
    const row = listMachineRefs(reader, now).refs[0]!;
    seed("presence", "peer", 0);
    expect(fetchMachineRefs(reader, { sync: true }).ok).toBe(true);
    expect(deleteMachineRef(reader, row).ok).toBe(false);
    expect(remoteRefs()).toEqual([row.ref]);
    expect(readMachineRefs(reader)).toHaveLength(1);
    expect(deleteMachineRef(reader, { ...row, ref: "refs/heads/keep" }).ok).toBe(false);
    expect(
      deleteMachineRef(reader, { ...row, ref: "refs/harnery/presence/this-machine", own: false })
        .ok,
    ).toBe(false);
  });

  test("fetch removes deleted refs from readers that include stale machines", () => {
    seed("presence", "retired");
    expect(fetchMachineRefs(reader, { sync: true }).ok).toBe(true);
    expect(readRemoteMachines(reader, { includeStale: true }).map((row) => row.machine)).toEqual([
      "retired",
    ]);
    git(writer, ["push", "origin", "--delete", "refs/harnery/presence/retired"]);
    expect(fetchMachineRefs(reader, { sync: true }).ok).toBe(true);
    expect(readMachineRefs(reader)).toEqual([]);
    expect(readRemoteMachines(reader, { includeStale: true })).toEqual([]);
    expect(fetchMachineRefs(reader, { sync: true }).ok).toBe(true);
  });

  test("inspection tolerates a ref disappearing between advertisement and fetch", () => {
    seed("presence", "gone");
    seed("docket", "kept");
    const run = transport.runPresenceGit;
    const spy = spyOn(transport, "runPresenceGit").mockImplementation((root, args, input) => {
      if (args[0] === "fetch") {
        git(origin, ["update-ref", "-d", "refs/harnery/presence/gone"]);
        git(origin, ["gc", "--prune=now"]);
      }
      return run(root, args, input);
    });
    try {
      const result = listMachineRefs(reader, now);
      expect(result.refs.find((row) => row.machine === "gone")?.error).toBe(
        "ref disappeared during inspection",
      );
      expect(result.refs.find((row) => row.namespace === "docket")?.age_secs).toBe(
        (45 * DAY) / 1000,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("the CLI lists and previews through JSON and requires --yes for deletion", async () => {
    seed("presence", "old");
    let data: unknown;
    const text: string[] = [];
    const program = new Command();
    registerPresenceCommand(program, {
      config: () => {},
      data: (value: unknown) => {
        data = value;
      },
      text: (value: string) => text.push(value),
      error: (error: { message: string }) => {
        throw new Error(error.message);
      },
    } as never);
    await program.parseAsync(["node", "harn", "presence", "refs", "--json"]);
    expect(data).toMatchObject({
      refs: [{ ref: "refs/harnery/presence/old", namespace: "presence" }],
    });
    await program.parseAsync(["node", "harn", "presence", "refs", "prune", "--json"]);
    expect(data).toMatchObject({ preview: true, deleted: [], refs: [{ would_delete: true }] });
    expect(remoteRefs()).toHaveLength(1);
    await program.parseAsync(["node", "harn", "presence", "refs", "prune", "--yes", "--json"]);
    expect(data).toMatchObject({ preview: false, deleted: ["refs/harnery/presence/old"] });
    expect(remoteRefs()).toEqual([]);
    expect(readFileSync(join(reader, ".git", "config"), "utf8")).toContain(origin);
  });

  test("the terminal preview names exact refs and mail loss, then prints deleted refs", async () => {
    seed("mail", "sender", 3, mail("sender", [{ id: "waiting", days: 2 }]));
    const output: string[] = [];
    const program = new Command();
    registerPresenceCommand(program, {
      config: () => {},
      data: () => {
        throw new Error("expected terminal output");
      },
      text: (value: string) => output.push(value),
      error: (error: { message: string }) => {
        throw new Error(error.message);
      },
    } as never);
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await program.parseAsync([
        "node",
        "harn",
        "presence",
        "refs",
        "prune",
        "--older-than",
        "1d",
        "--include-mail",
      ]);
      expect(output.join("")).toContain("refs/harnery/mail/sender  machine=sender");
      expect(output.join("")).toContain("would-delete=yes undelivered-mail=1 would-lose=1");
      expect(output.join("")).toContain("Deleted refs (0):");
      output.length = 0;
      await program.parseAsync([
        "node",
        "harn",
        "presence",
        "refs",
        "prune",
        "--older-than",
        "1d",
        "--include-mail",
        "--yes",
      ]);
      expect(output.join("")).toContain("Deleted refs (1):\n  refs/harnery/mail/sender\n");
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });
});
