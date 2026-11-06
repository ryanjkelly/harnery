import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createArtifact } from "../core/artifacts/index.ts";
import { registerArtifactsCommand } from "./artifacts.ts";

test("artifact show and list accept an explicit JSON request", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "artifacts-json-"));
  try {
    const created = createArtifact(repoRoot, {
      slug: "sample",
      purpose: "JSON reader test",
      retentionDays: 7,
    });
    const invoke = async (args: string[]) => {
      const data: unknown[] = [];
      const errors: unknown[] = [];
      const formats: unknown[] = [];
      const program = new Command().exitOverride().configureOutput({ writeErr() {} });
      registerArtifactsCommand(
        program,
        {
          config(value) {
            formats.push(value);
          },
          data(value) {
            data.push(value);
          },
          rows() {},
          text() {},
          file() {},
          log() {},
          error(value) {
            errors.push(value);
          },
          setExitCode() {},
        },
        { repoRoot },
      );
      await program.parseAsync(["artifacts", ...args], { from: "user" });
      expect(errors).toEqual([]);
      expect(data).toHaveLength(1);
      if (args.includes("--json")) expect(formats).toContainEqual({ format: "json" });
      return data[0];
    };
    const id = created.manifest.artifact_id;
    const plain = await invoke(["show", id]);
    expect(await invoke(["show", id, "--json"])).toEqual(plain);
    const listed = await invoke(["list", "--json"]);
    expect(listed).toMatchObject({ rows: [{ artifact_id: id }] });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
