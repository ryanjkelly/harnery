import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Replacing `process.env` with a plain object makes it case-sensitive on
// Windows, and every later `git` spawn in the same Bun process then fails
// (see tests/helpers/restore-env.ts). Restore a snapshot with
// `restoreProcessEnv` instead.
test("no source or test file replaces process.env with a plain object", () => {
  const root = join(import.meta.dir, "..", "..");
  const assignment = /\bprocess\.env\s*=(?!=)/;
  const offenders: string[] = [];
  for (const dir of ["src", "tests", "web", "scripts"]) {
    for (const file of new Bun.Glob("**/*.{ts,tsx,mts,mjs,js}").scanSync({ cwd: join(root, dir) })) {
      if (/(^|[\\/])(node_modules|\.next)[\\/]/.test(file)) continue;
      const lines = readFileSync(join(root, dir, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (assignment.test(line) && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*")) {
          offenders.push(`${dir}/${file.replaceAll("\\", "/")}:${index + 1}`);
        }
      });
    }
  }
  expect(offenders).toEqual([]);
});
