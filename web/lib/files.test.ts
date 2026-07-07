/**
 * Phase-0 test matrix for the universal-file-viewer resolution + security
 * layer (expanded by council rounds 1–2 + the 2026-06-11 review notes). The
 * step ORDER is the security property; these tests assert outcomes, the
 * route-layer suite (file-routes.test.ts) asserts the check≠serve-inode
 * property end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ResolveResult,
  __resetFilesCaches,
  __setResolveTestHooks,
  compileGlob,
  evaluateDeny,
  loadFilesConfig,
  resolveFile,
  scanChunk,
  stripJsonComments,
} from "./files.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const PROC_FD = existsSync("/proc/self/fd");

function makeRoot(): string {
  // realpath the temp dir up front (macOS /tmp is a symlink) so assertions
  // compare canonical-to-canonical.
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "harn-files-")));
}

function w(root: string, rel: string, content: string | Buffer): string {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function writeConfig(root: string, files: Record<string, unknown>): void {
  mkdirSync(path.join(root, ".harnery"), { recursive: true });
  writeFileSync(path.join(root, ".harnery", "config.jsonc"), JSON.stringify({ files }));
  __resetFilesCaches();
}

/** Build the standard repo-shaped fixture from the test matrix. */
function buildFixture(): string {
  const root = makeRoot();
  // positive controls across "submodules"
  w(root, "docs/plans/plan.md", "# A plan\n\nbody\n");
  w(root, "README.md", "# readme\n");
  w(root, "app-web/next-app/components/ui/badge.tsx", "export const Badge = () => null;\n");
  w(root, "app-web/src/data.json", '{"a":1}\n');
  w(root, "app-data/models/orders.sql", "select 1\n");
  // nested secrets per submodule
  w(root, "app-web/.credentials/acme.env", "ACME_KEY=topsecret\n");
  w(root, "app-api/.env", "OPENAI_KEY=topsecret\n");
  w(root, "app-store/theme/.env", "SHOPIFY_TOKEN=topsecret\n");
  w(root, ".env", "ROOT_SECRET=1\n");
  w(root, ".env.example", "ROOT_SECRET=fill-me-in\n");
  w(root, ".credentials/gcp-sa-key.json", '{"private_key":"x"}\n');
  // SA-key / oauth family, outside any "credentials"-named dir
  w(root, "app-functions/fn-x/gcp-sa-key.json", '{"k":1}\n');
  w(root, "tools/my-service-account.json", '{"k":1}\n');
  w(root, "tools/refresh-token.json", '{"k":1}\n');
  w(root, "tools/client_secret_123.apps.googleusercontent.com.json", '{"k":1}\n');
  w(root, "tools/oauth_client_thing.json", '{"k":1}\n');
  w(root, "docs/secrets-management.json", '{"doc":true}\n');
  // git family: root .git dir, submodule .git FILE (gitlink), modules config
  w(root, ".git/config", "[core]\n");
  w(root, ".git/modules/app-web/config", "[core]\n");
  w(root, "app-web/.git", "gitdir: ../.git/modules/app-web\n");
  w(root, ".git-credentials", "https://user:pass@github.com\n");
  // media + misc categories
  w(root, "assets/img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
  w(root, "assets/doc.pdf", "%PDF-1.4\n%fake\n");
  w(root, "assets/song.mp3", Buffer.from([0x49, 0x44, 0x33, 3, 0, 0]));
  w(root, "assets/vid.mp4", Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
  w(root, "assets/data.csv", "a,b\n1,2\n");
  w(root, "assets/conf.yaml", "a: 1\n");
  w(root, "assets/page.html", "<html><script>alert(1)</script></html>\n");
  w(root, "assets/pic.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>\n");
  w(root, "assets/blob.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
  w(root, "assets/noext-text", "plain text, no extension\n");
  w(root, "assets/noext-binary", Buffer.from([0, 159, 146, 150]));
  w(root, "assets/liar.ts", Buffer.from([0, 1, 2, 3, 4, 5])); // .ts ext, binary bytes
  return root;
}

function expectReject(r: ResolveResult, code: string, status?: number): void {
  if (r.ok) {
    closeSync(r.fd);
    throw new Error(`expected reject(${code}) but resolved ok: ${r.relPath}`);
  }
  expect(r.code).toBe(code as never);
  if (status !== undefined) expect(r.status).toBe(status as never);
}

function expectOk(r: ResolveResult): asserts r is Extract<ResolveResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok but got ${r.code}: ${r.detail ?? ""}`);
}

function readAllFromFd(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const n = readSync(fd, buf, got, size - got, got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

beforeEach(() => {
  __resetFilesCaches();
});

afterEach(() => {
  __setResolveTestHooks(null);
});

// ---------------------------------------------------------------------------
// Glob matcher
// ---------------------------------------------------------------------------

describe("compileGlob", () => {
  test("accepts **/SEG and **/SEG/** shapes", () => {
    expect(compileGlob("**/.env").scope).toBe("any");
    expect(compileGlob("**/.credentials/**").scope).toBe("non-last");
  });

  test("rejects non-anchored, multi-segment, and unsupported syntax", () => {
    expect(() => compileGlob(".env")).toThrow();
    expect(() => compileGlob("**/a/b")).toThrow();
    expect(() => compileGlob("**/a/b/**")).toThrow();
    expect(() => compileGlob("**/a?b")).toThrow();
    expect(() => compileGlob("**/[ab]")).toThrow();
    expect(() => compileGlob("**/a{b,{c,d}}")).toThrow();
    expect(() => compileGlob("**/")).toThrow();
  });

  test("brace alternation compiles", () => {
    const g = compileGlob("**/*.{pem,key}");
    expect(g.re.test("server.pem")).toBe(true);
    expect(g.re.test("server.key")).toBe(true);
    expect(g.re.test("server.pub")).toBe(false);
  });
});

describe("evaluateDeny (floor semantics)", () => {
  const cfg = { extraDeny: [], extraOverrides: [], droppedOverrides: [] };

  const denied = (p: string) => evaluateDeny(p, cfg).denied;

  test("env family (soft) denies nested at any depth", () => {
    expect(denied(".env")).toBe(true);
    expect(denied("app-api/.env")).toBe(true);
    expect(denied("app-store/theme/.env")).toBe(true);
    expect(denied("a/b/c/d/e/.env.production")).toBe(true);
    expect(denied("x/staging.env")).toBe(true);
  });

  test("floor overrides rescue .env.example/.sample/.template", () => {
    expect(denied(".env.example")).toBe(false);
    expect(denied("deep/sub/.env.sample")).toBe(false);
    expect(denied("deep/sub/.env.template")).toBe(false);
  });

  test("hard families deny regardless of depth or case", () => {
    for (const p of [
      ".credentials/x.env",
      "app-web/.credentials/acme.env",
      "APP-WEB/.CREDENTIALS/ACME.ENV",
      "a/server.pem",
      "a/b/private.KEY",
      "x/.ssh/id_rsa",
      "x/id_ed25519",
      "x/.aws/credentials",
      "x/.gnupg/ring.gpg",
      "gcp-sa-key.json",
      "deep/my-service-account.json",
      "deep/refresh-token.json",
      "deep/oauth_client_thing.json",
      "deep/client_secret_1.apps.googleusercontent.com.json",
      ".git/config",
      "app-web/.git",
      ".git/modules/app-web/config",
      ".git-credentials",
      ".npmrc",
      ".netrc",
      ".pgpass",
      ".htpasswd",
      "infra/prod.tfstate",
      "infra/prod.tfstate.backup",
      "x/release.jks",
      "x/secrets.kdbx",
    ]) {
      expect(denied(p)).toBe(true);
    }
  });

  test("soft *secret*.json denies but is override-rescuable", () => {
    expect(denied("docs/secrets-management.json")).toBe(true);
    const rescued = {
      extraDeny: [],
      extraOverrides: [compileGlob("**/secrets-management.json")],
      droppedOverrides: [],
    };
    expect(evaluateDeny("docs/secrets-management.json", rescued).denied).toBe(false);
  });

  test("hard tier is never overridable (runtime tiering)", () => {
    const cfgWithBadOverride = {
      extraDeny: [],
      // Pretend the canary check was somehow bypassed; runtime must still deny.
      extraOverrides: [compileGlob("**/gcp-sa-key.json")],
      droppedOverrides: [],
    };
    expect(evaluateDeny("x/gcp-sa-key.json", cfgWithBadOverride).denied).toBe(true);
  });

  test("trailing dots/spaces are stripped per segment before matching", () => {
    expect(denied(".env.")).toBe(true);
    expect(denied(".env ")).toBe(true);
    expect(denied("a/.credentials./x")).toBe(true);
  });

  test("widened segment semantics: a DIRECTORY named like a secret denies its contents", () => {
    expect(denied("weird/.env/readme.txt")).toBe(true);
    expect(denied("weird/topsecret.json/readme.txt")).toBe(true);
  });

  test("positive controls stay allowed", () => {
    for (const p of [
      "docs/plans/plan.md",
      "app-web/next-app/components/ui/badge.tsx",
      "app-web/src/data.json",
      "app-data/models/orders.sql",
      "README.md",
      "assets/img.png",
      "environment.md", // contains "env" but doesn't match *.env / .env*
      "x/envelope.txt",
      "x/tokens.md", // *-token.json must not catch non-json
    ]) {
      expect(denied(p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// scanChunk
// ---------------------------------------------------------------------------

describe("scanChunk", () => {
  test("NUL byte → binary", () => {
    expect(scanChunk(Buffer.from([65, 0, 66])).binary).toBe(true);
  });

  test("plain text → not binary, no secret", () => {
    const r = scanChunk(Buffer.from("hello world\nline two\n"));
    expect(r.binary).toBe(false);
    expect(r.secret).toBe(false);
  });

  test("UTF-8 multibyte is not binary", () => {
    expect(scanChunk(Buffer.from("café résumé — naïve\n")).binary).toBe(false);
  });

  test("secret signatures detected", () => {
    for (const s of [
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3B...",
      "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      "key: sk-ant-api03-abcdefghijklmnopqrstuvwx",
      "token = ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
      "SLACK_BOT_TOKEN=xoxb-1234567890-abcdef",
      "maps key AIzaSyA-abcdefghijklmnopqrstuvwxyz123456",
    ]) {
      expect(scanChunk(Buffer.from(s)).secret).toBe(true);
    }
  });

  test("token-shaped FP guards: prose containing sk-/AKIA-ish text stays clean", () => {
    for (const s of [
      "see the task-list for details", // "sk-" substring inside a word
      "the risk-based approach", // ditto
      "AKIA is the AWS key prefix", // bare prefix, no 16-char tail
      "-----BEGIN CERTIFICATE-----\nMIIC...", // public material
      "sk-' is how OpenAI keys start",
    ]) {
      expect(scanChunk(Buffer.from(s)).secret).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// stripJsonComments + loadFilesConfig
// ---------------------------------------------------------------------------

describe("stripJsonComments", () => {
  test("strips // and /* */ but not inside strings", () => {
    const src = `{
  // line comment
  "a": "http://example.com", /* block */ "b": "has // inside",
  "c": "esc\\"aped // still string"
}`;
    const parsed = JSON.parse(stripJsonComments(src));
    expect(parsed.a).toBe("http://example.com");
    expect(parsed.b).toBe("has // inside");
    expect(parsed.c).toBe('esc"aped // still string');
  });
});

describe("loadFilesConfig", () => {
  test("missing file → empty additive config", () => {
    const root = makeRoot();
    const cfg = loadFilesConfig(root);
    expect(cfg.extraDeny).toHaveLength(0);
    expect(cfg.extraOverrides).toHaveLength(0);
  });

  test("valid deny + override load; JSONC comments fine", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, ".harnery"), { recursive: true });
    writeFileSync(
      path.join(root, ".harnery", "config.jsonc"),
      `{
  // viewer policy
  "files": {
    "deny_globs": ["**/internal-notes.md"],
    "allow_overrides": ["**/secrets-management.json"]
  }
}`,
    );
    const cfg = loadFilesConfig(root);
    expect(cfg.extraDeny).toHaveLength(1);
    expect(cfg.extraOverrides).toHaveLength(1);
    expect(cfg.droppedOverrides).toHaveLength(0);
  });

  test("override naming a hard family is loudly dropped", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, ".harnery"), { recursive: true });
    writeFileSync(
      path.join(root, ".harnery", "config.jsonc"),
      JSON.stringify({
        files: {
          allow_overrides: ["**/gcp-sa-key.json", "**/.credentials/**", "**/*.json"],
        },
      }),
    );
    const cfg = loadFilesConfig(root);
    expect(cfg.extraOverrides).toHaveLength(0);
    expect(cfg.droppedOverrides).toHaveLength(3);
  });

  test("unparseable config throws; malformed deny glob throws (fail-closed)", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, ".harnery"), { recursive: true });
    writeFileSync(path.join(root, ".harnery", "config.jsonc"), "{ not json");
    expect(() => loadFilesConfig(root)).toThrow();
    writeFileSync(
      path.join(root, ".harnery", "config.jsonc"),
      JSON.stringify({ files: { deny_globs: ["not-anchored.md"] } }),
    );
    expect(() => loadFilesConfig(root)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveFile: input canonicalization (step 0)
// ---------------------------------------------------------------------------

describe("resolveFile input canonicalization", () => {
  const root = buildFixture();

  test("empty / root-itself / overlong", () => {
    expectReject(resolveFile("", { root }), "invalid_path", 400);
    expectReject(resolveFile(".", { root }), "invalid_path", 400);
    expectReject(resolveFile(root, { root }), "invalid_path", 400);
    expectReject(resolveFile(`docs/${"x".repeat(5000)}`, { root }), "invalid_path", 400);
  });

  test("residual percent-encoding rejected (double-encode laundering)", () => {
    expectReject(resolveFile("docs%2Fplans%2Fplan.md", { root }), "invalid_path", 400);
    expectReject(resolveFile("%252e%252e/.env", { root }), "invalid_path", 400);
    expectReject(resolveFile("docs/%2e%2e/.env", { root }), "invalid_path", 400);
  });

  test("NUL / control bytes / backslash / ~ rejected", () => {
    expectReject(resolveFile("docs/\u0000.env", { root }), "invalid_path", 400);
    expectReject(resolveFile("docs/\u0001x.md", { root }), "invalid_path", 400);
    expectReject(resolveFile("docs\\plans\\plan.md", { root }), "invalid_path", 400);
    expectReject(resolveFile("~/secrets", { root }), "invalid_path", 400);
    expectReject(resolveFile("~", { root }), "invalid_path", 400);
  });

  test("`..` segments rejected outright, decoded or not", () => {
    expectReject(resolveFile("docs/../.env", { root }), "invalid_path", 400);
    expectReject(resolveFile("../outside.txt", { root }), "invalid_path", 400);
    expectReject(resolveFile(`${root}/docs/../.env`, { root }), "invalid_path", 400);
  });

  test("NFD input resolves to NFC-named file", () => {
    const nfc = "docs/caf\u00e9.md"; // precomposed e-acute
    const nfd = "docs/cafe\u0301.md"; // e + combining acute - same glyph, different code points
    expect(nfd).not.toBe(nfc);
    expect(nfd.normalize("NFC")).toBe(nfc);
    w(root, nfc, "# accents\n");
    const r = resolveFile(nfd, { root });
    expectOk(r);
    expect(r.relPath).toBe(nfc);
    closeSync(r.fd);
  });
});

// ---------------------------------------------------------------------------
// resolveFile: classification (step 1)
// ---------------------------------------------------------------------------

describe("resolveFile classification", () => {
  const root = buildFixture();

  test("submodule-relative path rejects ambiguous_path, even when a unique match exists", () => {
    // app-web/next-app/... exists, but bare next-app/... must NOT be probed for.
    expectReject(resolveFile("next-app/components/ui/badge.tsx", { root }), "ambiguous_path", 400);
    expectReject(resolveFile("src/data.json", { root }), "ambiguous_path", 400);
  });

  test("known first segment accepted (dirs and root files)", () => {
    const a = resolveFile("docs/plans/plan.md", { root });
    expectOk(a);
    closeSync(a.fd);
    const b = resolveFile("README.md", { root });
    expectOk(b);
    closeSync(b.fd);
  });

  test("absolute in-root path accepted", () => {
    const r = resolveFile(`${root}/docs/plans/plan.md`, { root });
    expectOk(r);
    expect(r.relPath).toBe("docs/plans/plan.md");
    closeSync(r.fd);
  });
});

// ---------------------------------------------------------------------------
// resolveFile: containment (steps 2.5/3)
// ---------------------------------------------------------------------------

describe("resolveFile containment", () => {
  test("absolute outside-root path rejects without touching the filesystem", () => {
    const root = buildFixture();
    expectReject(resolveFile("/etc/passwd", { root }), "unresolvable", 400);
    expectReject(resolveFile("/etc/definitely-not-a-real-file-xyz", { root }), "unresolvable", 400);
    expectReject(resolveFile("/dev/null", { root }), "unresolvable", 400);
  });

  test("sibling worktree sharing the root's literal prefix is rejected (+path.sep proof)", () => {
    const root = buildFixture();
    const sibling = `${root}-task`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, "leak.txt"), "outside\n");
    try {
      expectReject(resolveFile(`${sibling}/leak.txt`, { root }), "unresolvable", 400);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("symlinked root: containment anchors on the realpath'd root", () => {
    const root = buildFixture();
    const link = `${root}-link`;
    symlinkSync(root, link);
    try {
      const r = resolveFile("docs/plans/plan.md", { root: link });
      expectOk(r);
      expect(r.relPath).toBe("docs/plans/plan.md");
      closeSync(r.fd);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("in-root symlink pointing outside the root is rejected", () => {
    const root = buildFixture();
    const outside = w(makeRoot(), "outside.md", "# outside\n");
    symlinkSync(outside, path.join(root, "docs", "innocent.md"));
    expectReject(resolveFile("docs/innocent.md", { root }), "unresolvable", 400);
  });

  test("in-root symlink laundering a denied file is caught by the canonical denylist", () => {
    const root = buildFixture();
    symlinkSync(path.join(root, ".env"), path.join(root, "docs", "totally-fine.md"));
    expectReject(resolveFile("docs/totally-fine.md", { root }), "denied", 403);
  });
});

// ---------------------------------------------------------------------------
// resolveFile: denylist integration + the 403/404 oracle (steps 2.5/5)
// ---------------------------------------------------------------------------

describe("resolveFile denylist + oracle closure", () => {
  const root = buildFixture();

  test("nested secrets per submodule are denied", () => {
    for (const p of [
      "app-web/.credentials/acme.env",
      "app-api/.env",
      "app-store/theme/.env",
      ".env",
      ".credentials/gcp-sa-key.json",
      "app-functions/fn-x/gcp-sa-key.json",
      "tools/my-service-account.json",
      "tools/refresh-token.json",
      "tools/client_secret_123.apps.googleusercontent.com.json",
      "tools/oauth_client_thing.json",
      ".git/config",
      ".git/modules/app-web/config",
      "app-web/.git",
      ".git-credentials",
    ]) {
      expectReject(resolveFile(p, { root }), "denied", 403);
    }
  });

  test("oracle closed: nonexistent path inside a denied tree is 403, not 404", () => {
    expectReject(resolveFile(".credentials/nope.env", { root }), "denied", 403);
    expectReject(resolveFile("app-web/.credentials/does-not-exist.env", { root }), "denied", 403);
    expectReject(resolveFile(".git/no-such-file", { root }), "denied", 403);
  });

  test("oracle closed against classification too: denied name with a NONEXISTENT first segment is 403, not ambiguous_path", () => {
    // No top-level `.ssh` / `secrets.env` / `no-such-submodule` exists in the
    // fixture: a denied name must reject identically either way, or
    // ambiguous-vs-denied leaks top-level existence of secret dirs.
    expectReject(resolveFile(".ssh/id_rsa", { root }), "denied", 403);
    expectReject(resolveFile("secrets.env", { root }), "denied", 403);
    expectReject(resolveFile("no-such-submodule/.env", { root }), "denied", 403);
  });

  test("case variants + trailing dots/spaces are denied (lexically, pre-FS)", () => {
    // A literally-uppercase secret on a case-sensitive FS:
    w(root, ".ENV", "UPPER=1\n");
    expectReject(resolveFile(".ENV", { root }), "denied", 403);
    // Nonexistent case/trailing variants still deny via the lexical pre-check:
    expectReject(resolveFile(".env.", { root }), "denied", 403);
    expectReject(resolveFile(".env ", { root }), "denied", 403);
  });

  test(".env.example is rescued by the floor allow-override", () => {
    const r = resolveFile(".env.example", { root });
    expectOk(r);
    closeSync(r.fd);
  });

  test("soft *secret*.json denied by default", () => {
    expectReject(resolveFile("docs/secrets-management.json", { root }), "denied", 403);
  });
});

// ---------------------------------------------------------------------------
// resolveFile: is-file gates (step 7)
// ---------------------------------------------------------------------------

describe("resolveFile is-file gates", () => {
  const root = buildFixture();

  test("directory rejects not_file", () => {
    expectReject(resolveFile("docs", { root }), "not_file", 404);
    expectReject(resolveFile("docs/plans", { root }), "not_file", 404);
  });

  test("missing file rejects not_found", () => {
    expectReject(resolveFile("docs/never-written.md", { root }), "not_found", 404);
  });

  test("FIFO rejects quickly without hanging (O_NONBLOCK proof)", () => {
    const fifo = path.join(root, "docs", "pipe.fifo");
    try {
      execSync(`mkfifo "${fifo}"`);
    } catch {
      return; // platform without mkfifo; the gate is still covered by the dir test
    }
    const started = Date.now();
    expectReject(resolveFile("docs/pipe.fifo", { root }), "not_file", 404);
    // A blocking open on a writer-less FIFO would hang forever; generous bound.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// resolveFile: categories, magic bytes, secret signatures (steps 6/8/9)
// ---------------------------------------------------------------------------

describe("resolveFile categories + content scan", () => {
  const root = buildFixture();

  function cat(p: string): string {
    const r = resolveFile(p, { root });
    expectOk(r);
    closeSync(r.fd);
    return r.category;
  }

  test("extension map", () => {
    expect(cat("docs/plans/plan.md")).toBe("markdown");
    expect(cat("app-web/next-app/components/ui/badge.tsx")).toBe("code");
    expect(cat("app-data/models/orders.sql")).toBe("code");
    expect(cat("app-web/src/data.json")).toBe("json");
    expect(cat("assets/conf.yaml")).toBe("yaml");
    expect(cat("assets/page.html")).toBe("html");
    expect(cat("assets/data.csv")).toBe("csv");
    expect(cat("assets/img.png")).toBe("image");
    expect(cat("assets/pic.svg")).toBe("svg");
    expect(cat("assets/doc.pdf")).toBe("pdf");
    expect(cat("assets/song.mp3")).toBe("audio");
    expect(cat("assets/vid.mp4")).toBe("video");
  });

  test("unknown extension sniffs to text or binary", () => {
    expect(cat("assets/noext-text")).toBe("text");
    expect(cat("assets/noext-binary")).toBe("binary");
    expect(cat("assets/blob.bin")).toBe("binary");
  });

  test("text-family extension with binary bytes demotes to binary (extension lied)", () => {
    expect(cat("assets/liar.ts")).toBe("binary");
  });

  test("mime + html never navigable", () => {
    const r = resolveFile("assets/page.html", { root });
    expectOk(r);
    expect(r.mime.startsWith("text/plain")).toBe(true);
    closeSync(r.fd);
    const s = resolveFile("assets/pic.svg", { root });
    expectOk(s);
    expect(s.mime).toBe("image/svg+xml");
    closeSync(s.fd);
  });

  test("secret signature in an allowed text file refuses inline", () => {
    w(root, "docs/notes-with-key.txt", "context\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n");
    expectReject(resolveFile("docs/notes-with-key.txt", { root }), "secret_signature", 403);
    w(root, "docs/aws-example.md", "use AKIAIOSFODNN7EXAMPLE as the example key\n");
    expectReject(resolveFile("docs/aws-example.md", { root }), "secret_signature", 403);
  });

  test("secret-signature FP guards hold at the pipeline level", () => {
    w(root, "docs/task-list.md", "the task-list mentions risk-based work\n");
    const r = resolveFile("docs/task-list.md", { root });
    expectOk(r);
    closeSync(r.fd);
  });

  test("resolved fd serves the file's actual bytes", () => {
    const r = resolveFile("docs/plans/plan.md", { root });
    expectOk(r);
    const body = readAllFromFd(r.fd, r.size).toString("utf-8");
    expect(body).toBe("# A plan\n\nbody\n");
    closeSync(r.fd);
  });
});

// ---------------------------------------------------------------------------
// resolveFile: TOCTOU races (steps 7/8; check≠serve-inode)
// ---------------------------------------------------------------------------

describe("resolveFile TOCTOU", () => {
  test("final component swapped to a symlink between realpath and open → denied (O_NOFOLLOW)", () => {
    const root = buildFixture();
    const outside = w(makeRoot(), "evil.md", "outside bytes\n");
    const target = path.join(root, "docs", "swap-me.md");
    writeFileSync(target, "inside bytes\n");
    __setResolveTestHooks({
      afterRealpath: () => {
        rmSync(target);
        symlinkSync(outside, target);
      },
    });
    expectReject(resolveFile("docs/swap-me.md", { root }), "denied", 403);
  });

  test("intermediate dir swapped between stat and open → denied (dev/ino re-verify)", () => {
    const root = buildFixture();
    const outsideRoot = makeRoot();
    mkdirSync(path.join(outsideRoot, "swapdir"), { recursive: true });
    writeFileSync(path.join(outsideRoot, "swapdir", "target.md"), "outside bytes\n");
    mkdirSync(path.join(root, "swapdir"), { recursive: true });
    writeFileSync(path.join(root, "swapdir", "target.md"), "inside bytes\n");
    __setResolveTestHooks({
      afterCheckStat: () => {
        renameSync(path.join(root, "swapdir"), path.join(root, "swapdir-moved"));
        symlinkSync(path.join(outsideRoot, "swapdir"), path.join(root, "swapdir"));
      },
    });
    expectReject(resolveFile("swapdir/target.md", { root }), "denied", 403);
  });

  test.if(PROC_FD)(
    "intermediate dir swapped after open → denied (fd re-verify derives from /proc/self/fd)",
    () => {
      const root = buildFixture();
      const outsideRoot = makeRoot();
      mkdirSync(path.join(outsideRoot, "swapdir"), { recursive: true });
      writeFileSync(path.join(outsideRoot, "swapdir", "target.md"), "outside bytes\n");
      mkdirSync(path.join(root, "swapdir"), { recursive: true });
      writeFileSync(path.join(root, "swapdir", "target.md"), "inside bytes\n");
      __setResolveTestHooks({
        afterRealpath: () => {
          // Swap BEFORE the check-time stat: stat + open both see the outside
          // file, so {dev,ino} agree; only the fd-derived re-verify catches it.
          renameSync(path.join(root, "swapdir"), path.join(root, "swapdir-moved"));
          symlinkSync(path.join(outsideRoot, "swapdir"), path.join(root, "swapdir"));
        },
      });
      expectReject(resolveFile("swapdir/target.md", { root }), "denied", 403);
    },
  );

  test("check≠serve inode: bytes always come from the opened inode, not the live path", () => {
    const root = buildFixture();
    const secret = path.join(root, ".env"); // exists in fixture, denied by path
    const target = path.join(root, "docs", "race.md");
    writeFileSync(target, "original contents\n");
    const r = resolveFile("docs/race.md", { root });
    expectOk(r);
    // After resolve, swap the path out from under the fd.
    rmSync(target);
    symlinkSync(secret, target);
    const served = readAllFromFd(r.fd, r.size).toString("utf-8");
    expect(served).toBe("original contents\n");
    closeSync(r.fd);
  });
});

// ---------------------------------------------------------------------------
// resolveFile: host config integration
// ---------------------------------------------------------------------------

describe("resolveFile host config", () => {
  test("additive deny_globs extend the floor", () => {
    const root = buildFixture();
    w(root, "docs/internal-notes.md", "private\n");
    writeConfig(root, { deny_globs: ["**/internal-notes.md"] });
    expectReject(resolveFile("docs/internal-notes.md", { root }), "denied", 403);
    // Floor still intact alongside:
    expectReject(resolveFile(".env", { root }), "denied", 403);
  });

  test("allow_overrides rescue soft denies through the full pipeline", () => {
    const root = buildFixture();
    writeConfig(root, { allow_overrides: ["**/secrets-management.json"] });
    const r = resolveFile("docs/secrets-management.json", { root });
    expectOk(r);
    closeSync(r.fd);
  });

  test("hard-family override is dropped at load, file stays denied", () => {
    const root = buildFixture();
    writeConfig(root, { allow_overrides: ["**/gcp-sa-key.json"] });
    expectReject(resolveFile("app-functions/fn-x/gcp-sa-key.json", { root }), "denied", 403);
  });

  test("unparseable config fails closed: every request rejects config_error", () => {
    const root = buildFixture();
    mkdirSync(path.join(root, ".harnery"), { recursive: true });
    writeFileSync(path.join(root, ".harnery", "config.jsonc"), "{ broken");
    __resetFilesCaches();
    expectReject(resolveFile("docs/plans/plan.md", { root }), "config_error", 500);
  });

  test("malformed deny glob fails closed: every request rejects config_error", () => {
    const root = buildFixture();
    writeConfig(root, { deny_globs: ["unanchored.md"] });
    expectReject(resolveFile("docs/plans/plan.md", { root }), "config_error", 500);
  });
});

// ---------------------------------------------------------------------------
// Fuzz: seeded property loop ("zero escapes under the Phase 0 fuzz suite")
// ---------------------------------------------------------------------------

describe("fuzz", () => {
  test("2,000 hostile inputs: every ok-result is contained, non-denied, and fd-verified", () => {
    const root = buildFixture();
    const cfg = loadFilesConfig(root);
    // Deterministic LCG so failures reproduce (no Math.random).
    let seed = 0xdecafbad;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
    const components = [
      "..",
      ".",
      "docs",
      "plans",
      "plan.md",
      "app-web",
      ".env",
      ".ENV",
      ".env.example",
      ".credentials",
      "gcp-sa-key.json",
      ".git",
      "config",
      "id_rsa",
      "caf\u00e9.md",
      "cafe\u0301.md",
      "%2e%2e",
      "%252e",
      "~",
      "~root",
      "a b c",
      ".env.",
      ".env ",
      "server.pem",
      "secrets.json",
      "README.md",
      "next-app",
      "assets",
      "img.png",
      "noext-text",
      "x".repeat(120),
      "\x00",
      "\x01",
      "\\windows\\style",
      "node_modules",
      "package.json",
      ".harnery",
      "events.ndjson",
    ];
    for (let i = 0; i < 2000; i++) {
      const depth = 1 + Math.floor(rand() * 5);
      const segs: string[] = [];
      for (let d = 0; d < depth; d++) segs.push(pick(components));
      let input = segs.join("/");
      const mode = rand();
      if (mode < 0.15) input = `/${input}`;
      else if (mode < 0.3) input = `${root}/${input}`;
      else if (mode < 0.35) input = `${root}-task/${input}`;
      const r = resolveFile(input, { root });
      if (!r.ok) continue;
      try {
        // Invariant 1: canonical relPath stays inside the root and is clean.
        expect(r.relPath.split("/").includes("..")).toBe(false);
        expect(path.isAbsolute(r.relPath)).toBe(false);
        // Invariant 2: the canonical relPath is not denylisted.
        expect(evaluateDeny(r.relPath, cfg).denied).toBe(false);
        // Invariant 3: the fd itself resolves inside the root (Linux).
        if (PROC_FD) {
          const fdPath = realpathSync(`/proc/self/fd/${r.fd}`);
          expect(fdPath.startsWith(root + path.sep)).toBe(true);
        }
      } finally {
        closeSync(r.fd);
      }
    }
  });
});
