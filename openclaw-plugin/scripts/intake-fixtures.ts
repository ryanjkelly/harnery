#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCaptureFixtures } from "../src/fixture-intake.ts";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing_argument:${name}`);
  return value;
}

export function runFixtureIntake(): string[] {
  return writeCaptureFixtures(
    resolve(argument("--input")),
    resolve(argument("--output-dir")),
    argument("--openclaw-version"),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const path of runFixtureIntake()) process.stdout.write(`${path}\n`);
}
