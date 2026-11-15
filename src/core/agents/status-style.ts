/**
 * Which end-of-turn status style this machine prints (ADR 0259).
 *
 * `agents.statusStyle` is `"box"` (default) or `"plain"`. It may live in the
 * user file, the project file, or the machine-local
 * `.harnery/config.local.jsonc`, later layers winning, so one person's
 * computer can differ from the project. `HARNERY_STATUS_STYLE` overrides per
 * process. An unrecognized value falls back to `"box"`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { coordEnv } from "../../lib/env.ts";
import { localConfigPath, stripJsonComments } from "../config.ts";

export type StatusStyle = "box" | "plain";

export const STATUS_STYLES: readonly StatusStyle[] = ["box", "plain"];

export function parseStatusStyle(value: unknown): StatusStyle | null {
  return value === "box" || value === "plain" ? value : null;
}

function layerStyle(path: string): StatusStyle | null {
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as {
      agents?: { statusStyle?: unknown };
    } | null;
    return parseStatusStyle(parsed?.agents?.statusStyle);
  } catch {
    return null;
  }
}

function userConfigFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg?.trim() ? xdg : join(homedir(), ".config");
  return join(base, "harnery", "config.jsonc");
}

/** The style for `root`: env, then local, project, and user files. */
export function resolveStatusStyle(root: string | null | undefined): StatusStyle {
  const env = parseStatusStyle(coordEnv("STATUS_STYLE")?.trim());
  if (env) return env;
  if (root) {
    const local = layerStyle(localConfigPath(root));
    if (local) return local;
    const project = layerStyle(join(root, ".harnery", "config.jsonc"));
    if (project) return project;
  }
  return layerStyle(userConfigFile()) ?? "box";
}
