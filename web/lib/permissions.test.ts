import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { COMPUTER_MODES as CLI_MODES } from "../../src/core/config";
import {
  COMPUTER_MODES,
  CONFIRM_SECONDS,
  checkLocalWrite,
  interpretModeChange,
  isLoopbackHost,
  modeChangeArgs,
  parseModeChangeRequest,
  requestLocality,
} from "./permissions";
import type { HarnResult } from "./run-harn";

function h(values: Record<string, string | undefined>): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) out.set(k, v);
  return out;
}

/** What Next hands a route for a plain request from a browser on this computer. */
const LOCAL = {
  host: "localhost:4392",
  "x-forwarded-host": "localhost:4392",
  "x-forwarded-for": "::1",
  "x-forwarded-port": "4392",
  "x-forwarded-proto": "http",
};

function result(partial: Partial<HarnResult>): HarnResult {
  return { ok: false, stdout: "", stderr: "", exitCode: 1, timedOut: false, ...partial };
}

function declined(message: string): HarnResult {
  return result({
    exitCode: 4,
    stderr: `${JSON.stringify({ error: { code: "computer_approval_declined", message } })}\n`,
  });
}

describe("mirrors of the CLI's constants", () => {
  test("modes match the CLI's list, strictest first", () => {
    expect([...COMPUTER_MODES]).toEqual([...CLI_MODES]);
  });
  test("the pop-up wait matches the computer command's", () => {
    // Read from source: importing the command would pull the CLI into the web typecheck.
    const source = readFileSync(
      path.join(import.meta.dir, "..", "..", "src", "commands", "computer.ts"),
      "utf8",
    );
    const match = /export const DEFAULT_CONFIRM_SECONDS = (\d+);/.exec(source);
    expect(Number(match?.[1])).toBe(CONFIRM_SECONDS);
  });
});

describe("parseModeChangeRequest", () => {
  test("accepts each mode and the project default", () => {
    for (const mode of [...COMPUTER_MODES, "default"]) {
      expect(parseModeChangeRequest({ mode })).toEqual({ ok: true, choice: mode as never });
    }
  });
  test("refuses anything else", () => {
    for (const body of [
      null,
      "on",
      [],
      {},
      { mode: "ON" },
      { mode: "--all-projects" },
      { mode: "on --all-projects" },
      { mode: 1 },
      { mode: "on", allProjects: true },
    ]) {
      expect(parseModeChangeRequest(body).ok).toBe(false);
    }
  });
  test("builds project-scoped CLI arguments only", () => {
    expect(modeChangeArgs("ask-each-task")).toEqual([
      "computer",
      "mode",
      "ask-each-task",
      "--json",
    ]);
    expect(modeChangeArgs("default")).toEqual(["computer", "mode", "--clear", "--json"]);
  });
});

describe("interpretModeChange", () => {
  test("a change reports the new mode in plain words", () => {
    const out = interpretModeChange(
      result({
        ok: true,
        exitCode: 0,
        stdout: '{"mode":"on","mode_source":"user-project","scope":"project"}\n',
      }),
      3_000,
    );
    expect(out.outcome).toBe("changed");
    expect(out.message).toContain("now on: Agents use the screen without asking.");
  });
  test("a quick refusal is a No", () => {
    const out = interpretModeChange(
      declined("Mode not changed: loosening it needs the person's approval, and it was not given."),
      8_000,
    );
    expect(out.outcome).toBe("declined");
  });
  test("a refusal after the pop-up's full wait is no answer", () => {
    const out = interpretModeChange(
      declined("Mode not changed: loosening it needs the person's approval, and it was not given."),
      120_400,
    );
    expect(out).toEqual({
      outcome: "timed-out",
      message: "Not changed: the confirmation pop-up closed after 2 minutes without an answer.",
    });
  });
  test("our own time limit is no answer", () => {
    expect(interpretModeChange(result({ timedOut: true, exitCode: null }), 150_000).outcome).toBe(
      "timed-out",
    );
  });
  test("no pop-up available says why", () => {
    const out = interpretModeChange(
      declined(
        "Mode not changed: loosening it needs the person's approval, and there was no way to ask (powershell.exe was not found).",
      ),
      500,
    );
    expect(out).toEqual({
      outcome: "unavailable",
      message:
        "Not changed: the confirmation pop-up could not be shown on this computer (powershell.exe was not found).",
    });
  });
  test("a project with desktop control off is refused", () => {
    const out = interpretModeChange(
      result({
        stderr:
          '{"error":{"code":"computer_disabled","message":"This project has desktop control off."}}\n',
      }),
      400,
    );
    expect(out.outcome).toBe("refused");
  });
  test("any other failure passes the CLI's message through", () => {
    const out = interpretModeChange(
      result({
        stderr:
          '{"error":{"code":"computer_usage","message":"Not inside a project; pass --all-projects."}}\n',
      }),
      400,
    );
    expect(out).toEqual({
      outcome: "failed",
      message: "Not changed: Not inside a project; pass --all-projects.",
    });
  });
});

describe("requestLocality", () => {
  test("a browser on this computer is local", () => {
    expect(requestLocality(h(LOCAL))).toEqual({ local: true });
    expect(
      requestLocality(h({ host: "127.0.0.1:4392", "x-forwarded-for": "127.0.0.1" })).local,
    ).toBe(true);
    expect(
      requestLocality(h({ host: "[::1]:4392", "x-forwarded-for": "::ffff:127.0.0.1" })).local,
    ).toBe(true);
  });
  test("the tunnel gate's rewrite is not local", () => {
    // The gate keeps Host as localhost and records the public name.
    expect(
      requestLocality(h({ ...LOCAL, "x-forwarded-host": "words-here.trycloudflare.com" })).local,
    ).toBe(false);
  });
  test("Cloudflare and Tailscale visitor headers are not local", () => {
    for (const extra of [
      { "cf-connecting-ip": "203.0.113.9" },
      { "cf-ray": "abc-LHR" },
      { "tailscale-user-login": "someone@example.com" },
      { "tailscale-funnel-request": "?1" },
    ]) {
      expect(requestLocality(h({ ...LOCAL, ...extra })).local).toBe(false);
    }
  });
  test("a forwarded remote address is not local", () => {
    expect(
      requestLocality(h({ ...LOCAL, "x-forwarded-for": "203.0.113.9, 127.0.0.1" })).local,
    ).toBe(false);
    expect(requestLocality(h({ ...LOCAL, "x-real-ip": "198.51.100.4" })).local).toBe(false);
    expect(
      requestLocality(h({ ...LOCAL, forwarded: "for=203.0.113.9;host=example.com" })).local,
    ).toBe(false);
    expect(
      requestLocality(h({ ...LOCAL, forwarded: 'for="[::1]";host=localhost:4392' })).local,
    ).toBe(true);
  });
  test("another host name is not local, including the files origin and rebinding names", () => {
    for (const host of [
      "harnery-files.localhost:4392",
      "evil.example:4392",
      "192.168.1.20:4392",
      "localhost.evil.example",
    ]) {
      expect(requestLocality(h({ ...LOCAL, host })).local).toBe(false);
    }
    expect(requestLocality(h({})).local).toBe(false);
  });
  test("isLoopbackHost reads ports and IPv6 brackets", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("127.0.0.2:80")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]:4392")).toBe(true);
    expect(isLoopbackHost("[2001:db8::1]:4392")).toBe(false);
  });
});

describe("checkLocalWrite", () => {
  test("the dashboard's own page may change the mode", () => {
    expect(
      checkLocalWrite(
        h({ ...LOCAL, origin: "http://localhost:4392", "sec-fetch-site": "same-origin" }),
      ),
    ).toEqual({ ok: true });
    // A local tool without a browser sends no Origin.
    expect(checkLocalWrite(h(LOCAL))).toEqual({ ok: true });
  });
  test("a remote request is refused in plain words", () => {
    const out = checkLocalWrite(
      h({
        ...LOCAL,
        "x-forwarded-host": "words-here.trycloudflare.com",
        origin: "https://words-here.trycloudflare.com",
      }),
    );
    expect(out).toEqual({
      ok: false,
      message:
        "Not changed: your computer-use mode can be changed only from a browser on this computer.",
    });
  });
  test("another site or another local port is refused", () => {
    for (const extra of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "http://localhost:3000", "sec-fetch-site": "same-site" },
      { origin: "http://localhost:3000" },
      { origin: "http://harnery-files.localhost:4392" },
      { origin: "null" },
    ]) {
      expect(checkLocalWrite(h({ ...LOCAL, ...extra })).ok).toBe(false);
    }
  });
});
