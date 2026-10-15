import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../tests/helpers/event-v3-runtime.ts";
import { createHarneryProgram, type EmitContext, loadLazyCommand } from "../commander.ts";
import { createArtifact } from "../core/artifacts/index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnery-rm-cli-")));
  roots.push(root);
  const file = join(root, "render.mp4");
  writeFileSync(file, "render");
  return { root, file };
}
function capture() {
  const data: unknown[] = [];
  const errors: unknown[] = [];
  let code = 0;
  const emit: EmitContext = {
    config() {},
    file() {},
    log() {},
    data(value) {
      data.push(value);
    },
    rows() {},
    text() {},
    error(value) {
      errors.push(value);
    },
    setExitCode(value) {
      code = value;
    },
  };
  return { emit, data, errors, code: () => code };
}

test("registers lazily with root requirement, recursive and preview flags", async () => {
  const program = createHarneryProgram();
  await loadLazyCommand(program, "rm");
  const rm = program.commands.find((command) => command.name() === "rm");
  expect(rm?.helpInformation()).toContain("--root");
  expect(rm?.helpInformation()).toContain("--dry-run");
  expect(rm?.helpInformation()).toContain("--entry-limit");
  expect(rm?.helpInformation()).not.toContain("--force");
  expect(
    createHarneryProgram({ skipCommands: ["rm"] }).commands.some(
      (command) => command.name() === "rm",
    ),
  ).toBe(false);
});

test("CLI emits preview and applies only with yes", async () => {
  const { root, file } = fixture();
  for (const yes of [false, true]) {
    const output = capture();
    const program = createHarneryProgram({ emit: output.emit, context: { repoRoot: root } });
    await program.parseAsync(
      ["rm", "--root", root, "--json", ...(yes ? ["--yes"] : []), "--", file],
      { from: "user" },
    );
    expect(output.code()).toBe(0);
    expect(output.data[0]).toMatchObject({
      schema: "harnery.removal/v1",
      applied: yes,
      targets: [file],
    });
    expect(existsSync(file)).toBe(!yes);
  }
});

test("CLI blocks another agent's exact, ancestor and descendant claims", async () => {
  for (const claim of ["render.mp4", ".", "render.mp4/child"]) {
    const { root, file } = fixture();
    initializeV3Fixture(root);
    seedV3Session(root, "peer", { name: "Peer", claims: [claim] });
    const output = capture();
    const program = createHarneryProgram({ emit: output.emit, context: { repoRoot: root } });
    await program.parseAsync(["rm", "--root", root, "--yes", file], { from: "user" });
    expect(output.code()).toBe(1);
    expect(output.errors[0]).toMatchObject({ code: "removal_refused" });
    expect(existsSync(file)).toBe(true);
  }
}, 20_000);

test("CLI removes a protected path only when --allow-protected names it", async () => {
  const { root } = fixture();
  const copy = join(root, "copy");
  const creds = join(copy, ".credentials");
  mkdirSync(creds, { recursive: true });
  writeFileSync(join(creds, "key.json"), "{}");
  for (const allow of [false, true]) {
    const output = capture();
    const program = createHarneryProgram({ emit: output.emit, context: { repoRoot: root } });
    await program.parseAsync(
      [
        "rm",
        "--root",
        root,
        "--recursive",
        "--json",
        "--yes",
        ...(allow ? ["--allow-protected", creds] : []),
        "--",
        copy,
      ],
      { from: "user" },
    );
    expect(output.code()).toBe(allow ? 0 : 1);
    if (allow) expect(output.data[0]).toMatchObject({ applied: true, protected: [creds] });
    else expect(output.errors[0]).toMatchObject({ code: "removal_refused" });
    expect(existsSync(copy)).toBe(!allow);
  }
});

function ownedCopy(owner = "rm-owner-self") {
  const { root } = fixture();
  initializeV3Fixture(root);
  seedV3Session(root, "rm-owner-self", { name: "Self" });
  const artifact = createArtifact(root, {
    slug: "copy",
    purpose: "Synthetic copied state",
    retentionDays: 1,
    actor: { instance_id: owner },
  });
  const copy = join(artifact.path, "snapshot", ".harnery");
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, "state.json"), "copy");
  return {
    root,
    workspace: artifact.path,
    copy,
    record: join(artifact.path, ".harnery-artifact.json"),
  };
}

async function copyCommand(
  input: ReturnType<typeof ownedCopy>,
  options: {
    actor?: string;
    allow?: boolean;
    yes?: boolean;
    root?: string;
    target?: string;
    entryLimit?: string;
  } = {},
) {
  const savedOwner = process.env.HARNERY_AGENT_COORD_OWNER;
  const savedBridge = process.env.HARNERY_AGENT_COORD_BRIDGE;
  try {
    if (options.actor === "none") delete process.env.HARNERY_AGENT_COORD_OWNER;
    else process.env.HARNERY_AGENT_COORD_OWNER = options.actor ?? "rm-owner-self";
    // Exercise the supported environment identity route in this isolated fixture.
    delete process.env.HARNERY_AGENT_COORD_BRIDGE;
    const output = capture();
    const program = createHarneryProgram({ emit: output.emit, context: { repoRoot: input.root } });
    await program.parseAsync(
      [
        "rm",
        "--root",
        options.root ?? input.workspace,
        "--recursive",
        "--json",
        ...(options.yes ? ["--yes"] : []),
        ...(options.entryLimit ? ["--entry-limit", options.entryLimit] : []),
        ...(options.allow === false ? [] : ["--allow-protected", input.copy]),
        "--",
        options.target ?? input.copy,
      ],
      { from: "user" },
    );
    return output;
  } finally {
    if (savedOwner === undefined) delete process.env.HARNERY_AGENT_COORD_OWNER;
    else process.env.HARNERY_AGENT_COORD_OWNER = savedOwner;
    if (savedBridge === undefined) delete process.env.HARNERY_AGENT_COORD_BRIDGE;
    else process.env.HARNERY_AGENT_COORD_BRIDGE = savedBridge;
  }
}

test("CLI previews and applies only the authenticated caller's explicitly named copied state", async () => {
  const input = ownedCopy();
  const preview = await copyCommand(input);
  expect(preview.code()).toBe(0);
  expect(preview.data[0]).toMatchObject({ applied: false, protected: [input.copy] });
  expect(existsSync(input.copy)).toBe(true);
  const unnamed = await copyCommand(input, { allow: false, yes: true });
  expect(unnamed.code()).toBe(1);
  expect(existsSync(input.copy)).toBe(true);
  const applied = await copyCommand(input, { yes: true });
  expect(applied.code()).toBe(0);
  expect(applied.data[0]).toMatchObject({ applied: true, protected: [input.copy] });
  expect(existsSync(input.copy)).toBe(false);
  expect(existsSync(input.record)).toBe(true);
});

for (const mode of ["unowned", "released", "invalid", "unauthenticated"]) {
  test(`CLI refuses ${mode} copied-state removal`, async () => {
    const input = ownedCopy(mode === "unowned" ? "rm-owner-peer" : "rm-owner-self");
    const manifest = JSON.parse(readFileSync(input.record, "utf8"));
    if (mode === "released") manifest.released_at = new Date().toISOString();
    if (mode === "invalid") manifest.schema_version = 999;
    writeFileSync(input.record, JSON.stringify(manifest));
    const output = await copyCommand(input, {
      yes: true,
      actor: mode === "unauthenticated" ? "rm-owner-unknown" : "rm-owner-self",
    });
    expect(output.code()).toBe(1);
    expect(output.errors[0]).toMatchObject({ code: "removal_refused" });
    expect(existsSync(input.copy)).toBe(true);
  });
}

test("CLI preserves peer claims and refuses broad or symlink artifact roots", async () => {
  const claimed = ownedCopy();
  seedV3Session(claimed.root, "peer", { claims: [claimed.copy] });
  const output = await copyCommand(claimed, { yes: true });
  expect(output.code()).toBe(1);
  expect(JSON.stringify(output.errors)).toContain("another agent's claim");
  expect(existsSync(claimed.copy)).toBe(true);
  const input = ownedCopy();
  expect((await copyCommand(input, { root: input.root, yes: true })).code()).toBe(1);
  const alias = join(input.root, "artifact-alias");
  symlinkSync(input.workspace, alias);
  expect((await copyCommand(input, { root: alias, yes: true })).code()).toBe(1);
  expect(existsSync(input.copy)).toBe(true);
});

test("CLI entry limits verify the exact current owner and retain the artifact and its hold", async () => {
  const input = ownedCopy();
  const manifest = JSON.parse(readFileSync(input.record, "utf8"));
  manifest.holds = [
    {
      id: "review",
      reason: "Keep retained evidence",
      set_by: { instance_id: "rm-owner-self" },
      set_at: new Date().toISOString(),
      persistent: true,
    },
  ];
  const before = JSON.stringify(manifest);
  writeFileSync(input.record, before);
  const result = await copyCommand(input, { entryLimit: "100000", yes: true });
  expect(result.code()).toBe(0);
  expect(result.data[0]).toMatchObject({ applied: true, entry_limit: 100_000 });
  expect(existsSync(input.copy)).toBe(false);
  expect(existsSync(input.workspace)).toBe(true);
  expect(readFileSync(input.record, "utf8")).toBe(before);
});

for (const entryLimit of ["0", "-1", "1.5", "NaN", "Infinity", "100001"]) {
  test(`CLI entry limits reject ${entryLimit}`, async () => {
    const input = ownedCopy();
    const output = await copyCommand(input, { entryLimit, yes: true });
    expect(output.code()).toBe(1);
    expect(JSON.stringify(output.errors)).toContain("entry limit");
    expect(existsSync(input.copy)).toBe(true);
  });
}
for (const mode of ["unowned", "released", "unauthenticated", "broad"]) {
  test(`CLI entry limits reject ${mode} artifacts`, async () => {
    const input = ownedCopy(mode === "unowned" ? "rm-owner-peer" : "rm-owner-self");
    const ordinaryOutput = join(input.workspace, "output.txt");
    writeFileSync(ordinaryOutput, "ordinary output");
    if (mode === "released") {
      const manifest = JSON.parse(readFileSync(input.record, "utf8"));
      manifest.released_at = new Date().toISOString();
      writeFileSync(input.record, JSON.stringify(manifest));
    }
    const output = await copyCommand(input, {
      entryLimit: "10001",
      yes: true,
      allow: false,
      target: ordinaryOutput,
      root: mode === "broad" ? input.root : input.workspace,
      actor: mode === "unauthenticated" ? "rm-owner-unknown" : "rm-owner-self",
    });
    expect(output.code()).toBe(1);
    expect(JSON.stringify(output.errors)).toContain(
      mode === "broad"
        ? "--root to name one owned managed artifact"
        : mode === "unauthenticated"
          ? "authenticated current artifact owner"
          : "valid unreleased artifact owned by the caller",
    );
    expect(readFileSync(ordinaryOutput, "utf8")).toBe("ordinary output");
    expect(existsSync(input.record)).toBe(true);
  });
}

test("CLI entry limits remove ordinary output under valid current ownership", async () => {
  const input = ownedCopy();
  const ordinaryOutput = join(input.workspace, "output.txt");
  writeFileSync(ordinaryOutput, "ordinary output");
  const output = await copyCommand(input, {
    entryLimit: "10001",
    yes: true,
    allow: false,
    target: ordinaryOutput,
  });
  expect(output.code()).toBe(0);
  expect(output.data[0]).toMatchObject({ applied: true, entry_limit: 10_001 });
  expect(existsSync(ordinaryOutput)).toBe(false);
  expect(existsSync(input.record)).toBe(true);
});
