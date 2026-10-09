import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  connectProbe,
  findPidsByCommandLine,
  listeningPorts,
  parseLsofPorts,
  parseNetstatPorts,
  parseProcessRows,
  parseSsPorts,
} from "./processes.ts";

type Reply = { status: number | null; stdout: string; missing: boolean };
const ok = (stdout: string): Reply => ({ status: 0, stdout, missing: false });
const absent: Reply = { status: null, stdout: "", missing: true };
const failed: Reply = { status: 1, stdout: "", missing: false };

/** A fake tool runner keyed by command name. */
function runner(tools: Record<string, Reply>) {
  const calls: string[] = [];
  return {
    calls,
    run: (command: string) => {
      calls.push(command);
      return tools[command] ?? absent;
    },
  };
}

const PS = [
  "  101 /usr/bin/bun run /opt/h/src/lib/tunnel/gate.ts --name a --port 9001",
  "  102 /Users/m/.bun/bin/bun /kit/bpc.mjs tunnel gate --name preview --port 9002",
  "  103 cloudflared tunnel --protocol http2 --url http://localhost:9002",
  "  104 /Users/m/.bun/bin/bun /kit/bpc.mjs tunnel gate --name other --port 90021",
].join("\n");

describe("output parsers", () => {
  test("parses ps rows", () => {
    expect(parseProcessRows(PS)).toHaveLength(4);
    expect(parseProcessRows("junk\n 7 cmd arg\r\n")).toEqual([{ pid: 7, command: "cmd arg" }]);
  });

  test("reads listening ports from ss, lsof, and netstat output", () => {
    expect(
      parseSsPorts("LISTEN 0 4096 127.0.0.1:9001 0.0.0.0:*\nLISTEN 0 4096 [::]:22 [::]:*\n"),
    ).toEqual([9001, 22]);
    expect(
      parseLsofPorts(
        "bun 123 u 4u IPv4 0x1 0t0 TCP 127.0.0.1:58055 (LISTEN)\nbun 9 u 5u IPv6 0x2 0t0 TCP *:8080 (LISTEN)\nx 1 u 6u IPv4 0x3 0t0 TCP 1.2.3.4:80->5.6.7.8:9 (ESTABLISHED)\n",
      ),
    ).toEqual([58055, 8080]);
    expect(
      parseNetstatPorts(
        "  TCP    0.0.0.0:9001           0.0.0.0:0              LISTENING       4\r\n  TCP    [::]:445               [::]:0                 LISTENING       4\r\n  TCP    10.0.0.2:5000          1.1.1.1:443            ESTABLISHED     8\r\n",
      ),
    ).toEqual([9001, 445]);
  });
});

describe("findPidsByCommandLine", () => {
  const pattern = "(gate\\.ts|tunnel gate) .*--port 9002( |$)";

  test("uses pgrep where it exists", () => {
    const { run, calls } = runner({ pgrep: ok("102\n") });
    expect(findPidsByCommandLine(pattern, "darwin", run)).toEqual([102]);
    expect(calls).toEqual(["pgrep"]);
  });

  test("pgrep finding nothing is an empty answer, not a reason to try another tool", () => {
    const { run, calls } = runner({ pgrep: failed });
    expect(findPidsByCommandLine(pattern, "linux", run)).toEqual([]);
    expect(calls).toEqual(["pgrep"]);
  });

  test("falls back to ps when pgrep is missing", () => {
    const { run } = runner({ ps: ok(PS) });
    expect(findPidsByCommandLine(pattern, "linux", run)).toEqual([102]);
  });

  test("matches both gate launch forms and respects the port boundary", () => {
    const { run } = runner({ ps: ok(PS) });
    expect(
      findPidsByCommandLine("(gate\\.ts|tunnel gate) .*--port 9001( |$)", "linux", run),
    ).toEqual([101]);
    expect(
      findPidsByCommandLine("(gate\\.ts|tunnel gate) .*--port 9002( |$)", "linux", run),
    ).toEqual([102]);
  });

  test("reads Windows command lines through PowerShell, never pgrep", () => {
    const { run, calls } = runner({ "powershell.exe": ok(PS) });
    expect(findPidsByCommandLine("--url http://localhost:9002( |$)", "win32", run)).toEqual([103]);
    expect(calls).toEqual(["powershell.exe"]);
  });

  test("returns nothing when no tool can list processes", () => {
    expect(findPidsByCommandLine(pattern, "linux", runner({}).run)).toEqual([]);
    expect(findPidsByCommandLine(pattern, "win32", runner({}).run)).toEqual([]);
  });
});

describe("listeningPorts", () => {
  test("Linux prefers ss, then lsof", () => {
    expect(
      listeningPorts("linux", runner({ ss: ok("LISTEN 0 1 127.0.0.1:9001 0.0.0.0:*\n") }).run),
    ).toEqual(new Set([9001]));
    expect(
      listeningPorts(
        "linux",
        runner({ lsof: ok("bun 1 u 4u IPv4 0x1 0t0 TCP 127.0.0.1:9003 (LISTEN)\n") }).run,
      ),
    ).toEqual(new Set([9003]));
  });

  test("macOS uses lsof and never calls ss", () => {
    const { run, calls } = runner({ lsof: ok("bun 1 u 4u IPv4 0x1 0t0 TCP *:9004 (LISTEN)\n") });
    expect(listeningPorts("darwin", run)).toEqual(new Set([9004]));
    expect(calls).toEqual(["lsof"]);
  });

  test("Windows uses netstat", () => {
    const { run, calls } = runner({
      netstat: ok("  TCP    0.0.0.0:9005    0.0.0.0:0    LISTENING    4\r\n"),
    });
    expect(listeningPorts("win32", run)).toEqual(new Set([9005]));
    expect(calls).toEqual(["netstat"]);
  });

  test("no tool means no answer (null), never an empty 'all ports free' set", () => {
    expect(listeningPorts("linux", runner({}).run)).toBeNull();
    expect(listeningPorts("darwin", runner({}).run)).toBeNull();
    expect(listeningPorts("win32", runner({}).run)).toBeNull();
  });
});

describe("connectProbe", () => {
  test("sees a listener and its absence", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    expect(await connectProbe(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await connectProbe(port)).toBe(false);
  });
});
