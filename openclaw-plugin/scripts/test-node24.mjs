#!/usr/bin/env node

import { spawnSync } from "node:child_process";

if (process.versions.node.split(".")[0] !== "24") {
  process.stderr.write(
    `OpenClaw plugin acceptance requires Node 24; received ${process.version}.\n`,
  );
  process.exit(1);
}

const result = spawnSync(
  "bun",
  ["test", "openclaw-plugin/test/build-load.test.ts", "--timeout", "30000"],
  {
    cwd: new URL("../..", import.meta.url),
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
