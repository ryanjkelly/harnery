import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../tests/helpers/event-v3-runtime.ts";
import { createHarneryProgram, type EmitContext, loadLazyCommand } from "../commander.ts";

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
});
