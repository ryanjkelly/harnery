import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createHarneryProgram, type EmitContext } from "../commander.ts";
import { coordRootId } from "../lib/coord-root-id.ts";
import {
  FILES_ORIGIN_HOST,
  mintLocalFileUrl,
  registerFilesCommand,
  verifyDashboardRoot,
} from "./files.ts";

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.stop(true);
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-files-url-"));
  roots.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "page name.html"), "<h1>hello</h1>");
  writeFileSync(join(root, "docs", "notes.md"), "# Notes\n");
  return root;
}

function serveRootIdentity(root: string): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname !== "/api/coord-root") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({ root_id: coordRootId(root) });
    },
  });
  servers.push(server);
  if (server.port === undefined) throw new Error("test identity server did not bind a port");
  return server.port;
}

describe("mintLocalFileUrl", () => {
  test("mints an isolated-origin URL for HTML with encoded path segments", () => {
    const root = fixture();
    expect(FILES_ORIGIN_HOST).toBe("harnery-files.localhost");
    expect(mintLocalFileUrl("docs/page name.html", { coordRoot: root, port: 4276 })).toEqual({
      url: "http://harnery-files.localhost:4276/docs/page%20name.html",
      relPath: "docs/page name.html",
      mode: "raw",
    });
  });

  test("mints the dashboard viewer for non-HTML files", () => {
    const root = fixture();
    expect(mintLocalFileUrl("docs/notes.md", { coordRoot: root, port: 5100 })).toEqual({
      url: "http://localhost:5100/files?path=docs%2Fnotes.md",
      relPath: "docs/notes.md",
      mode: "viewer",
    });
  });

  test("accepts an absolute path inside the coord root", () => {
    const root = fixture();
    const result = mintLocalFileUrl(join(root, "docs", "notes.md"), {
      coordRoot: root,
      port: 4276,
    });
    expect(result.relPath).toBe("docs/notes.md");
  });

  test("supports explicit raw and viewer modes", () => {
    const root = fixture();
    expect(
      mintLocalFileUrl("docs/notes.md", { coordRoot: root, port: 4276, mode: "raw" }).url,
    ).toBe("http://harnery-files.localhost:4276/docs/notes.md");
    expect(
      mintLocalFileUrl("docs/page name.html", {
        coordRoot: root,
        port: 4276,
        mode: "viewer",
      }).url,
    ).toBe("http://localhost:4276/files?path=docs%2Fpage%20name.html");
  });

  test("rejects missing files, directories, and paths outside the coord root", () => {
    const root = fixture();
    const outsideRoot = fixture();
    expect(() => mintLocalFileUrl("docs/missing.html", { coordRoot: root, port: 4276 })).toThrow(
      "file does not exist",
    );
    expect(() => mintLocalFileUrl("docs", { coordRoot: root, port: 4276 })).toThrow(
      "path is not a file",
    );
    expect(() =>
      mintLocalFileUrl(join(outsideRoot, "docs", "notes.md"), { coordRoot: root, port: 4276 }),
    ).toThrow("file is outside the coord root");
  });
});

describe("files url command", () => {
  test("verifies the running dashboard serves the same coord root", async () => {
    const root = fixture();
    const port = serveRootIdentity(root);
    const output = captureEmit();
    const program = createHarneryProgram({
      emit: output.emit,
      context: { repoRoot: root },
      skipCommands: ["web"],
    });

    await program.parseAsync(["files", "url", "docs/notes.md", "--port", String(port)], {
      from: "user",
    });

    expect(output.text).toEqual([`http://localhost:${port}/files?path=docs%2Fnotes.md\n`]);
    expect(output.errors).toEqual([]);
  });

  test("refuses a URL when the port serves a different coord root", async () => {
    const root = fixture();
    const otherRoot = fixture();
    const port = serveRootIdentity(otherRoot);
    const output = captureEmit();
    const program = createHarneryProgram({
      emit: output.emit,
      context: { repoRoot: root },
      skipCommands: ["web"],
    });

    await program.parseAsync(["files", "url", "docs/notes.md", "--port", String(port)], {
      from: "user",
    });

    expect(output.text).toEqual([]);
    expect(output.errors).toEqual([
      {
        code: "dashboard_root_mismatch",
        message: `dashboard at http://localhost:${port} serves a different repository`,
        hint: "Stop that dashboard and start this repository's dashboard, then retry.",
      },
    ]);
    expect(output.exitCodes).toEqual([1]);
  });

  test("reports an unreachable dashboard before handing out a URL", async () => {
    const root = fixture();
    await expect(
      verifyDashboardRoot(root, 4276, async () => {
        throw new Error("connection refused");
      }),
    ).rejects.toMatchObject({ code: "dashboard_unreachable" });
  });

  test("rejects an identity response without a root id", async () => {
    const root = fixture();
    await expect(
      verifyDashboardRoot(root, 4277, async () => Response.json({})),
    ).rejects.toMatchObject({
      code: "dashboard_identity_unavailable",
      message: expect.stringContaining("invalid repository identity"),
    });
  });

  test("survives a host replacing the web command and uses the configured port", async () => {
    const root = fixture();
    mkdirSync(join(root, ".harnery"));
    writeFileSync(join(root, ".harnery", "config.jsonc"), '{ "web": { "port": 5100 } }');

    const output = captureEmit();
    const program = createHarneryProgram({
      emit: output.emit,
      context: { repoRoot: root },
      skipCommands: ["web"],
    });
    expect(program.commands.some((command) => command.name() === "web")).toBe(false);
    await program.parseAsync(["files", "url", "docs/page name.html", "--no-verify"], {
      from: "user",
    });

    expect(output.text).toEqual(["http://harnery-files.localhost:5100/docs/page%20name.html\n"]);
    expect(output.errors).toEqual([]);
  });

  test("rejects conflicting URL modes", async () => {
    const output = captureEmit();
    const program = new Command();
    registerFilesCommand(program, output.emit);
    await program.parseAsync(["files", "url", "README.md", "--raw", "--viewer"], {
      from: "user",
    });
    expect(output.errors).toEqual([
      { code: "conflicting_url_modes", message: "--raw and --viewer cannot be used together" },
    ]);
    expect(output.exitCodes).toEqual([1]);
  });
});

function captureEmit(): {
  emit: EmitContext;
  text: string[];
  errors: unknown[];
  exitCodes: number[];
} {
  const text: string[] = [];
  const errors: unknown[] = [];
  const exitCodes: number[] = [];
  return {
    emit: {
      config: () => {},
      data: () => {},
      rows: () => {},
      text: (value) => text.push(value),
      file: () => {},
      error: (value) => errors.push(value),
      log: () => {},
      setExitCode: (value) => exitCodes.push(value),
    },
    text,
    errors,
    exitCodes,
  };
}
