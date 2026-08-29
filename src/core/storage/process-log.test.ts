import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotatingTextSink } from "./process-log.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("rotating text sink", () => {
  test("bounds the active process log and rotates backups", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-text-"));
    roots.push(root);
    const path = join(root, "service.log");
    const sink = new RotatingTextSink({ path, max_bytes: 5, backups: 2 });
    sink.append("12345");
    sink.append("abc");
    sink.close();
    expect(readFileSync(path, "utf8")).toBe("abc");
    expect(existsSync(`${path}.1`)).toBeTrue();
  });
});
