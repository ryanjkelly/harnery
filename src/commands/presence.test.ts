import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeDir } from "../../tests/helpers/remove-dir.ts";

const commandUrl = new URL("./presence.ts", import.meta.url).href;
const script = `
  import { Command } from "commander";
  import { registerPresenceCommand } from ${JSON.stringify(commandUrl)};
  const emit = {
    config() {}, rows() {}, file() {}, log() {}, setExitCode(n) { process.exitCode = n; },
    data(value) { console.log(JSON.stringify(value)); },
    text(value) { process.stdout.write(value); },
    error(value) { console.error(JSON.stringify(value)); },
  };
  const program = new Command().name("testcli");
  registerPresenceCommand(program, emit);
  await program.parseAsync(process.argv.slice(1), { from: "user" });
`;

describe("mobile/office presence commands", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "presence-command-"));
  });

  afterEach(() => removeDir(home));

  function run(...args: string[]) {
    // Windows takes the home folder from USERPROFILE, not HOME.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    for (const key of Object.keys(env)) {
      if (key.startsWith("HARNERY_")) delete env[key];
    }
    // Resolve dependencies from the package while keeping coordination state in the sandbox.
    env.HARNERY_COORD_ROOT_OVERRIDE = home;
    const result = Bun.spawnSync([process.execPath, "--eval", script, "presence", ...args], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env,
      stdin: "ignore",
    });
    return {
      code: result.exitCode,
      out: result.stdout.toString(),
      err: result.stderr.toString(),
    };
  }

  test("get reports the default state, source, and pin status in text and JSON", () => {
    expect(run("get")).toMatchObject({
      code: 0,
      out: "office (source: default, pinned: no)\n",
    });
    const json = run("get", "--json");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({
      state: "office",
      source: null,
      pinned: false,
      is_default: true,
      path: join(home, ".claude", "presence"),
    });
  });

  test.each(["office", "mobile"])("pin %s persists and unpin keeps the state", (state) => {
    const pin = run("pin", state);
    expect(pin.code).toBe(0);
    expect(JSON.parse(pin.out)).toMatchObject({ state, source: "cli", pinned: true });
    expect(run("get").out).toBe(`${state} (source: cli, pinned: yes)\n`);
    expect(JSON.parse(run("get", "--json").out)).toMatchObject({ state, pinned: true });
    const unpin = run("unpin");
    expect(unpin.code).toBe(0);
    expect(JSON.parse(unpin.out)).toMatchObject({ state, source: "cli", pinned: false });
  });

  test("set replaces a pin with a one-shot state", () => {
    expect(run("pin", "office").code).toBe(0);
    const set = run("set", "mobile");
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toMatchObject({ state: "mobile", source: "cli", pinned: false });
  });

  test("clear removes a pin and returns to the default", () => {
    expect(run("pin", "mobile").code).toBe(0);
    expect(run("clear").code).toBe(0);
    expect(JSON.parse(run("get", "--json").out)).toMatchObject({
      state: "office",
      pinned: false,
      is_default: true,
    });
  });

  test("pin rejects an invalid state without writing a record", () => {
    const pin = run("pin", "away");
    expect(pin.code).toBe(2);
    expect(JSON.parse(pin.err)).toMatchObject({ code: "invalid_state" });
    expect(JSON.parse(run("get", "--json").out).is_default).toBe(true);
  });

  test("set help explains automatic changes and points to pin", () => {
    const help = run("set", "--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("Detection can overwrite it");
    expect(help.out).toContain("presence pin");
  });
});
