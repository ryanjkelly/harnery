import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function writeBootRow(row: Record<string, unknown>, path: string): void {
  appendJsonLine(path, { observed_at: new Date().toISOString(), ...row });
}

export function appendJsonLine(path: string, row: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    process.stderr.write(`[harnery] log write failed: ${String(error)}\n`);
  }
}
