import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { __resetCoordRootCache } from "@/lib/coord-reader";
import { helperLimitReportFixture } from "@/lib/helper-limit-fixture";
import { POST } from "./route";

/** What Next hands a route for a plain request from a browser on this computer. */
const LOCAL = {
  host: "localhost:4392",
  "x-forwarded-host": "localhost:4392",
  "x-forwarded-for": "::1",
  "content-type": "application/json",
};

function post(body: unknown, headers: Record<string, string> = LOCAL): Request {
  return new Request("http://localhost:4392/api/devtools/helper-limit", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe.skipIf(process.platform === "win32")("POST /api/devtools/helper-limit", () => {
  let root = "";
  let previousRoot: string | undefined;
  const argsFile = () => path.join(root, "args.txt");
  const harn = (body: string) => {
    const file = path.join(root, "bin", "harn");
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile()}"\n${body}\n`);
    chmodSync(file, 0o755);
  };
  const recordedArgs = () => readFileSync(argsFile(), "utf8").trimEnd().split("\n");

  beforeEach(() => {
    previousRoot = process.env.HARNERY_COORD_ROOT;
    root = mkdtempSync(path.join(tmpdir(), "helper-limit-route-"));
    mkdirSync(path.join(root, ".harnery"));
    mkdirSync(path.join(root, "bin"));
    process.env.HARNERY_COORD_ROOT = root;
    __resetCoordRootCache();
    writeFileSync(path.join(root, "report.json"), JSON.stringify(helperLimitReportFixture()));
    harn(`cat "${path.join(root, "report.json")}"`);
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
    else process.env.HARNERY_COORD_ROOT = previousRoot;
    __resetCoordRootCache();
    rmSync(root, { recursive: true, force: true });
  });

  test("sets the pair as separate arguments and returns the fresh report", async () => {
    const res = await POST(post({ limit: { max_model: "opus", max_effort: "medium" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(helperLimitReportFixture());
    expect(recordedArgs()).toEqual(["devtools", "helpers", "opus", "medium", "--format", "json"]);
  });

  test("an empty pair is an explicit no limit", async () => {
    const res = await POST(post({ limit: {} }));
    expect(res.status).toBe(200);
    expect(recordedArgs()).toEqual(["devtools", "helpers", "none", "--format", "json"]);
  });

  test("null clears the person's choice", async () => {
    const res = await POST(post({ limit: null }));
    expect(res.status).toBe(200);
    expect(recordedArgs()).toEqual(["devtools", "helpers", "--clear", "--format", "json"]);
  });

  test("refuses a malformed or unexpected body without running the command", async () => {
    for (const body of [
      "not json",
      { limit: { max_model: "opus medium" } },
      { limit: { max_model: "--clear" } },
      { limit: { max_effort: "High" } },
      { limit: {}, tool: "codex" },
      {},
    ]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toStartWith("Not changed:");
    }
    expect(existsSync(argsFile())).toBe(false);
  });

  test("refuses a request from another computer or another site", async () => {
    const remote = await POST(
      post(
        { limit: {} },
        {
          ...LOCAL,
          "x-forwarded-host": "words.trycloudflare.com",
          origin: "https://words.trycloudflare.com",
        },
      ),
    );
    expect(remote.status).toBe(403);
    expect(((await remote.json()) as { error: string }).error).toContain("this computer");
    const crossSite = await POST(
      post(
        { limit: {} },
        { ...LOCAL, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      ),
    );
    expect(crossSite.status).toBe(403);
    expect(existsSync(argsFile())).toBe(false);
  });

  test("reports a failed command in plain words", async () => {
    harn('echo "the preferences file is not writable" >&2; exit 1');
    const res = await POST(post({ limit: { max_model: "sonnet" } }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      ok: false,
      error: "Not changed: the preferences file is not writable",
    });
  });

  test("a saved change whose echo is unreadable still succeeds", async () => {
    harn('echo "Helpers now run on Sonnet."');
    const res = await POST(post({ limit: { max_model: "sonnet" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
