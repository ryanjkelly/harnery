// Visual-regression primitive for `harn browse --baseline / --diff`. Captures
// the screenshot under a name + later pixel-diffs against it. Catches the
// class of regressions where every per-element check (visibility, console
// errors, network) passes but the rendered UI shifted/lost styling/regressed
// a hover state: the kind of thing a single human screenshot would have
// flagged immediately.
//
// pixelmatch (with pngjs decoding) is the pixel-diff workhorse: small, no
// native deps, ships an alpha-blended diff PNG and a mismatched-pixel count
// in one pass.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const BASELINE_DIR = resolve(homedir(), ".cache", "harnery", "visual-baselines");

export interface SaveBaselineResult {
  name: string;
  path: string;
  bytes: number;
}

export interface DiffResult {
  name: string;
  baselinePath: string;
  currentPath: string;
  diffPath: string;
  matched: boolean;
  /** Pixels that differ between baseline and current beyond the threshold. */
  mismatchedPixels: number;
  totalPixels: number;
  /** mismatchedPixels / totalPixels. Lower = more similar. 0 = identical. */
  mismatchRatio: number;
  similarity: number; // 1 - mismatchRatio
  baselineDims: { width: number; height: number };
  currentDims: { width: number; height: number };
  /** True when baseline + current have different dimensions (auto-fail). */
  sizeMismatch: boolean;
}

function baselinePath(name: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error(
      `Invalid baseline name '${name}'. Use alphanumeric + _ . - only (file-system-safe).`,
    );
  }
  return resolve(BASELINE_DIR, `${name}.png`);
}

export function saveBaseline(currentPngPath: string, name: string): SaveBaselineResult {
  const dest = baselinePath(name);
  mkdirSync(dirname(dest), { recursive: true });
  const bytes = readFileSync(currentPngPath);
  writeFileSync(dest, bytes);
  return { name, path: dest, bytes: bytes.length };
}

export function diffAgainstBaseline(
  currentPngPath: string,
  name: string,
  opts: { threshold?: number; diffOutputPath?: string } = {},
): DiffResult {
  const basePath = baselinePath(name);
  if (!existsSync(basePath)) {
    throw new Error(
      `No baseline named '${name}' at ${basePath}. Save one first with --baseline ${name}.`,
    );
  }

  const baselineBuf = readFileSync(basePath);
  const currentBuf = readFileSync(currentPngPath);
  const baseline = PNG.sync.read(baselineBuf);
  const current = PNG.sync.read(currentBuf);

  const sizeMismatch = baseline.width !== current.width || baseline.height !== current.height;
  const diffPath = opts.diffOutputPath ?? `${currentPngPath.replace(/\.png$/i, "")}-diff.png`;
  mkdirSync(dirname(diffPath), { recursive: true });

  if (sizeMismatch) {
    // Different dimensions: pixelmatch can't compare directly. Write a
    // placeholder diff that's just the current image with a banner; report
    // the size delta in the result so the caller knows what's up.
    writeFileSync(diffPath, currentBuf);
    return {
      name,
      baselinePath: basePath,
      currentPath: currentPngPath,
      diffPath,
      matched: false,
      mismatchedPixels: current.width * current.height,
      totalPixels: current.width * current.height,
      mismatchRatio: 1,
      similarity: 0,
      baselineDims: { width: baseline.width, height: baseline.height },
      currentDims: { width: current.width, height: current.height },
      sizeMismatch: true,
    };
  }

  const { width, height } = baseline;
  const diff = new PNG({ width, height });
  const mismatchedPixels = pixelmatch(baseline.data, current.data, diff.data, width, height, {
    threshold: opts.threshold ?? 0.1, // pixelmatch's per-pixel tolerance (YIQ color delta)
    includeAA: false,
  });
  writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = width * height;
  const mismatchRatio = mismatchedPixels / totalPixels;

  return {
    name,
    baselinePath: basePath,
    currentPath: currentPngPath,
    diffPath,
    matched: mismatchedPixels === 0,
    mismatchedPixels,
    totalPixels,
    mismatchRatio,
    similarity: 1 - mismatchRatio,
    baselineDims: { width, height },
    currentDims: { width: current.width, height: current.height },
    sizeMismatch: false,
  };
}

export function baselineExists(name: string): boolean {
  try {
    return existsSync(baselinePath(name));
  } catch {
    return false;
  }
}

export function listBaselines(): string[] {
  if (!existsSync(BASELINE_DIR)) return [];
  try {
    return readdirSync(BASELINE_DIR)
      .filter((f) => f.endsWith(".png"))
      .map((f) => f.replace(/\.png$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export { BASELINE_DIR };
