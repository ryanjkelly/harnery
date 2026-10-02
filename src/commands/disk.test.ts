import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createHarneryProgram, type EmitContext } from "../commander.ts";
import { registerDiskCommand } from "./disk.ts";

function capture() {
  const data: unknown[] = [];
  const text: string[] = [];
  const errors: unknown[] = [];
  const exits: number[] = [];
  const emit: EmitContext = {
    config: () => {},
    rows: () => {},
    file: () => {},
    log: () => {},
    data: (value) => {
      data.push(value);
    },
    text: (value) => {
      text.push(value);
    },
    error: (value) => {
      errors.push(value);
    },
    setExitCode: (value) => {
      exits.push(value);
    },
  };
  return { emit, data, text, errors, exits };
}

test("disk is available lazily in standalone and composed command trees", async () => {
  const root = mkdtempSync(join(tmpdir(), "harnery-disk-cli-"));
  try {
    writeFileSync(join(root, "one.mp4"), Buffer.alloc(100));
    const output = capture();
    const program = createHarneryProgram({ binName: "testcli", emit: output.emit });
    expect(program.commands.some((command) => command.name() === "disk")).toBe(true);
    await program.parseAsync(["disk", root, "--type", "video", "--apparent", "--json"], {
      from: "user",
    });
    expect(output.data[0]).toMatchObject({
      schema: "harnery.disk-usage/v1",
      totals: { files: 1, apparent_bytes: 100 },
    });
    expect(output.errors).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("text output labels measurement and filtered Git state", async () => {
  const root = mkdtempSync(join(tmpdir(), "harnery-disk-cli-"));
  try {
    writeFileSync(join(root, "one.txt"), "12345");
    const output = capture();
    const program = new Command();
    registerDiskCommand(program, output.emit);
    await program.parseAsync(["disk", root, "--apparent", "--group", "extension"], {
      from: "user",
    });
    expect(output.text[0]).toContain("5 B in 1 regular files (apparent)");
    expect(output.text[0]).toContain("non-repository");
    expect(output.text[0]).toContain(".txt");
    expect(output.text[0]).toContain("Directory metadata and symlinks are excluded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan failures emit an error and set a nonzero exit without killing the host process", async () => {
  const output = capture();
  const program = new Command();
  registerDiskCommand(program, output.emit);
  await program.parseAsync(["disk", join(tmpdir(), "harnery-disk-missing-path-unknown")], {
    from: "user",
  });
  expect(output.errors[0]).toMatchObject({ code: "disk_usage_failed" });
  expect(output.exits).toEqual([1]);
});
