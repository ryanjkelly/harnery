#!/usr/bin/env node
/**
 * Published-package smoke test: the gate that the 0.2.0 launch lacked.
 *
 * tests/lint/typecheck/build all pass against the SOURCE under Bun, but they
 * never exercise what an end user actually gets: the built `dist/` installed
 * from a tarball, run by plain `node`, with production deps only (no dev deps).
 * Three separate startup/runtime crashes shipped to npm because nothing ran
 * `npm pack` -> install --omit=dev -> `node dist/cli.js`. This script is that
 * missing step.
 *
 * What it does:
 *   1. build dist/  (the Node target)
 *   2. npm pack      (the exact tarball npm would publish)
 *   3. install the tarball into a throwaway dir with --omit=dev
 *   4. run the CLI via `node dist/cli.js` (NOT bin/harn, which prefers Bun and
 *      would mask Node-only failures) and assert each command behaves
 *
 * Runs on Node only. Exits non-zero on the first failure with a clear message.
 */

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

const log = (m) => process.stdout.write(`smoke: ${m}\n`);
const fail = (m) => {
  process.stderr.write(`smoke: FAIL - ${m}\n`);
  process.exit(1);
};

let workdir;
let tarball;
try {
  // 1. Build dist/
  log("building dist/ ...");
  execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });

  // 2. Pack the tarball npm would publish
  log("packing tarball ...");
  tarball = execSync("npm pack", { cwd: repoRoot, encoding: "utf8" }).trim().split("\n").pop();
  const tarballPath = join(repoRoot, tarball);
  log(`packed ${tarball}`);

  // 3. Install into a throwaway dir, production deps only
  workdir = mkdtempSync(join(tmpdir(), "harnery-smoke-"));
  writeFileSync(
    join(workdir, "package.json"),
    JSON.stringify({ name: "harnery-smoke", version: "1.0.0", private: true }, null, 2),
  );
  log("installing tarball with --omit=dev ...");
  execSync(`npm install "${tarballPath}" --omit=dev --no-audit --no-fund`, {
    cwd: workdir,
    stdio: "inherit",
  });

  const cli = join(workdir, "node_modules", "harnery", "dist", "cli.js");

  // Run `node dist/cli.js <args>` with Bun scrubbed from PATH so we exercise
  // the Node path (bin/harn would prefer Bun and mask Node-only failures).
  const nodePath = process.execPath;
  const run = (args, input) =>
    execFileSync(nodePath, [cli, ...args], {
      cwd: workdir,
      encoding: "utf8",
      input,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });

  // 4. Assertions

  // --version: must print the real package version, not a scaffold placeholder.
  log("checking `--version` ...");
  const versionOut = run(["--version"]).trim();
  if (versionOut !== pkgVersion) {
    fail(`--version printed "${versionOut}", expected "${pkgVersion}"`);
  }
  log(`--version -> ${versionOut} OK`);

  // --help: must boot and list commands (this crashed in 0.2.0).
  log("checking `--help` boots ...");
  const helpOut = run(["--help"]);
  if (!/Usage:/.test(helpOut) || !/outline/.test(helpOut)) {
    fail("--help did not render the expected command listing");
  }
  log("--help OK");

  // outline on PHP: works without the `typescript` dep.
  log("checking `outline` on a PHP file ...");
  const phpFile = join(workdir, "sample.php");
  writeFileSync(phpFile, "<?php\nfunction greet($n) { return $n; }\n");
  const outlineOut = run(["outline", phpFile]);
  if (!/greet/.test(outlineOut)) {
    fail("outline did not list the PHP function");
  }
  log("outline (php) OK");

  // read: HTML -> markdown on plain Node (this was the jsdom ERR_REQUIRE_ESM
  // crash, fixed by the linkedom swap).
  log("checking `read` (HTML to markdown) ...");
  const htmlFile = join(workdir, "sample.html");
  writeFileSync(
    htmlFile,
    "<html><body><article><h1>Smoke Test</h1><p>This is article body content, long enough that readability extracts it as the main page content for the conversion.</p></article></body></html>",
  );
  const readOut = run(["read", htmlFile]);
  if (!/## Smoke Test/.test(readOut) || !/article body content/.test(readOut)) {
    fail(`read did not produce the expected markdown. Got:\n${readOut}`);
  }
  log("read OK");

  log("ALL CHECKS PASSED");
} finally {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  if (tarball) rmSync(join(repoRoot, tarball), { force: true });
}
