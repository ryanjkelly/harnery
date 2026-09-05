import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwrightPackage = require.resolve("playwright/package.json");
// Package managers may keep transitive dependencies outside node_modules' top level.
const browserPackages = [
  playwrightPackage,
  createRequire(playwrightPackage).resolve("playwright-core/package.json"),
].map(
  (manifest) => `${path.relative(dirname, path.dirname(manifest)).split(path.sep).join("/")}/**/*`,
);

const nextConfig: NextConfig = {
  // A supervising host can build into a staging directory while the previous
  // bundle keeps serving, then swap directories. Default stays Next's `.next`.
  ...(process.env.HARNERY_WEB_DIST_DIR ? { distDir: process.env.HARNERY_WEB_DIST_DIR } : {}),
  // The web UI imports readers from harnery's src/ (one level up). Pin
  // the tracing root so Next includes those files when building.
  outputFileTracingRoot: path.resolve(dirname, ".."),
  outputFileTracingIncludes: {
    "/api/file/thumbnail": [
      "./lib/thumbnail-renderers/*.mjs",
      "./lib/thumbnail-renderers/*.py",
      ...browserPackages,
    ],
  },
  // bun:sqlite is a Bun builtin. The dashboard runs under Node; leave it
  // external so a reader that optionally probes Codex state can fail closed
  // instead of crashing the whole app at import time.
  serverExternalPackages: ["bun:sqlite"],

  // harnery source uses ESM-style `.js`-suffixed imports inside `.ts` files
  // (e.g. `export * from "./coord-client.js"`). Bun resolves that natively;
  // webpack (Next.js dev) needs to be told to try `.ts` first when the
  // import says `.js`. extensionAlias is the canonical webpack 5 hook for
  // this; see https://webpack.js.org/configuration/resolve/#resolveextensionalias.
  webpack(config, { nextRuntime }) {
    config.module = config.module ?? {};
    config.module.parser = config.module.parser ?? {};
    config.module.parser.javascript = config.module.parser.javascript ?? {};
    config.module.parser.javascript.worker = ["...", "Worker from node:worker_threads"];
    if (nextRuntime === "nodejs") {
      // Node workers load beside server chunks, not from the browser asset URL.
      config.output.workerPublicPath = "./";
    }
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
};

export default nextConfig;
