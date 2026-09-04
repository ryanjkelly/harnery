import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ARTIFACT_MANIFEST } from "./constants.ts";
import { resolveArtifactRef, showArtifact } from "./index.ts";

export const ARTIFACT_DELIVERY_MANIFEST = ".harnery-delivery.json";
export const ARTIFACT_DELIVERY_SCHEMA_VERSION = 1 as const;
export const ARTIFACT_DELIVERY_AUTO_ITEM_LIMIT = 100;

export interface ArtifactDeliveryUrl {
  kind: "url";
  label: string;
  target: string;
}

export interface ArtifactDeliveryPath {
  kind: "path";
  label: string;
  path: string;
}

export type ArtifactDeliveryItem = ArtifactDeliveryUrl | ArtifactDeliveryPath;

export interface ArtifactDeliveryManifest {
  schema_version: typeof ARTIFACT_DELIVERY_SCHEMA_VERSION;
  title: string;
  items: ArtifactDeliveryItem[];
}

export interface ArtifactDeliveryCard {
  artifact_path: string;
  manifest_path: string;
  markdown: string;
  auto_items: number;
  omitted_auto_items: number;
}

interface DisplayEnvironment {
  platform?: NodeJS.Platform;
  wslDistroName?: string;
}

export function writeArtifactDeliveryManifest(
  repoRoot: string,
  ref: string,
  input: Omit<ArtifactDeliveryManifest, "schema_version">,
): ArtifactDeliveryManifest {
  const artifactPath = managedArtifactPath(repoRoot, ref);
  const manifest = validateManifest(artifactPath, {
    schema_version: ARTIFACT_DELIVERY_SCHEMA_VERSION,
    ...input,
  });
  const target = resolve(artifactPath, ARTIFACT_DELIVERY_MANIFEST);
  const tmp = `${target}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return manifest;
}

export function readArtifactDeliveryManifest(
  repoRoot: string,
  ref: string,
): ArtifactDeliveryManifest {
  const artifactPath = managedArtifactPath(repoRoot, ref);
  const path = resolve(artifactPath, ARTIFACT_DELIVERY_MANIFEST);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read ${ARTIFACT_DELIVERY_MANIFEST}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateManifest(artifactPath, parsed);
}

export function resolveArtifactDeliveryManifest(
  repoRoot: string,
  ref: string,
): ArtifactDeliveryManifest {
  const artifactPath = managedArtifactPath(repoRoot, ref);
  if (!existsSync(resolve(artifactPath, ARTIFACT_DELIVERY_MANIFEST))) {
    return {
      schema_version: ARTIFACT_DELIVERY_SCHEMA_VERSION,
      title: "Artifact delivery",
      items: [],
    };
  }
  return readArtifactDeliveryManifest(repoRoot, ref);
}

export function renderArtifactDeliveryCard(
  repoRoot: string,
  ref: string,
  manifest = resolveArtifactDeliveryManifest(repoRoot, ref),
  environment: DisplayEnvironment = {},
): ArtifactDeliveryCard {
  const artifactPath = managedArtifactPath(repoRoot, ref);
  const valid = validateManifest(artifactPath, manifest);
  const rows: Array<{ label: string; target: string; icon: string }> = [];
  const explicitPaths = new Set<string>();

  for (const item of valid.items.filter((candidate) => candidate.kind === "url")) {
    rows.push({ label: item.label, target: item.target, icon: "🌐" });
  }

  rows.push({
    label: "Artifact folder",
    target: displayPath(artifactPath, environment),
    icon: "📁",
  });

  for (const item of valid.items.filter((candidate) => candidate.kind === "path")) {
    const absolute = resolveArtifactItem(artifactPath, item.path);
    explicitPaths.add(absolute);
    rows.push({
      label: item.label,
      target: displayPath(absolute, environment),
      icon: iconForPath(absolute),
    });
  }

  const discovered = discoverArtifactRootItems(artifactPath).filter(
    (item) => !explicitPaths.has(item.path),
  );
  const autoItems = discovered.slice(0, ARTIFACT_DELIVERY_AUTO_ITEM_LIMIT);
  for (const item of autoItems) {
    rows.push({
      label: item.name,
      target: displayPath(item.path, environment),
      icon: iconForPath(item.path),
    });
  }
  const omittedAutoItems = discovered.length - autoItems.length;

  let links = rows
    .map(
      (row) =>
        `- ${row.icon} **${escapeMarkdown(row.label)}:** [${escapeMarkdown(row.target)}](<${linkTarget(row.target)}>)`,
    )
    .join("\n");
  if (omittedAutoItems > 0) {
    links += `\n- 📁 **More root items:** ${omittedAutoItems} additional ${omittedAutoItems === 1 ? "entry" : "entries"}; open the artifact folder.`;
  }
  const plain = rows.map((row) => `${row.label.toUpperCase()}\n${row.target}`).join("\n\n");

  return {
    artifact_path: artifactPath,
    manifest_path: resolve(artifactPath, ARTIFACT_DELIVERY_MANIFEST),
    markdown: `### ${escapeMarkdown(valid.title)}\n\n${links}\n\n\`\`\`text\n${plain}\n\`\`\``,
    auto_items: autoItems.length,
    omitted_auto_items: omittedAutoItems,
  };
}

export function parseArtifactDeliverySpec(
  kind: "url" | "path",
  spec: string,
): ArtifactDeliveryItem {
  const delimiter = spec.indexOf("=");
  if (delimiter < 1 || delimiter === spec.length - 1) {
    throw new Error(`${kind} entries must use LABEL=VALUE`);
  }
  const label = spec.slice(0, delimiter).trim();
  const value = spec.slice(delimiter + 1).trim();
  return kind === "url" ? { kind, label, target: value } : { kind, label, path: value };
}

function managedArtifactPath(repoRoot: string, ref: string): string {
  showArtifact(repoRoot, ref);
  return realpathSync(resolveArtifactRef(repoRoot, ref));
}

function validateManifest(artifactPath: string, value: unknown): ArtifactDeliveryManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("delivery manifest must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schema_version !== ARTIFACT_DELIVERY_SCHEMA_VERSION) {
    throw new Error(`delivery manifest schema_version must be ${ARTIFACT_DELIVERY_SCHEMA_VERSION}`);
  }
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  if (!title) throw new Error("delivery title must not be empty");
  if (!Array.isArray(candidate.items)) throw new Error("delivery manifest items must be an array");

  const labels = new Set<string>();
  const items = candidate.items.map((raw): ArtifactDeliveryItem => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("each delivery item must be an object");
    }
    const item = raw as Record<string, unknown>;
    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (!label) throw new Error("delivery item labels must not be empty");
    const normalizedLabel = label.toLowerCase();
    if (normalizedLabel === "artifact folder") {
      throw new Error('"Artifact folder" is reserved and included automatically');
    }
    if (labels.has(normalizedLabel)) throw new Error(`duplicate delivery label: ${label}`);
    labels.add(normalizedLabel);

    if (item.kind === "url") {
      const target = typeof item.target === "string" ? item.target.trim() : "";
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        throw new Error(`invalid delivery URL for ${label}`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`delivery URL for ${label} must use http or https`);
      }
      return { kind: "url", label, target: url.toString() };
    }

    if (item.kind === "path") {
      const path = typeof item.path === "string" ? item.path.trim() : "";
      if (!path || isAbsolute(path)) {
        throw new Error(`delivery path for ${label} must be relative to the artifact folder`);
      }
      const absolute = resolveArtifactItem(artifactPath, path);
      const normalized = relative(artifactPath, absolute).split(sep).join("/");
      return { kind: "path", label, path: normalized };
    }

    throw new Error(`delivery item ${label} has an unsupported kind`);
  });

  return {
    schema_version: ARTIFACT_DELIVERY_SCHEMA_VERSION,
    title,
    items,
  };
}

function resolveArtifactItem(artifactPath: string, itemPath: string): string {
  const root = realpathSync(artifactPath);
  const lexical = resolve(root, itemPath);
  if (lexical === root || !lexical.startsWith(`${root}${sep}`)) {
    throw new Error(`delivery path escapes the artifact folder: ${itemPath}`);
  }
  let target: string;
  try {
    target = realpathSync(lexical);
  } catch (error) {
    throw new Error(
      `delivery path does not exist: ${itemPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`delivery path escapes the artifact folder through a symlink: ${itemPath}`);
  }
  const stat = lstatSync(target);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`delivery path must be a file or directory: ${itemPath}`);
  }
  return target;
}

function discoverArtifactRootItems(
  artifactPath: string,
): Array<{ name: string; path: string; directory: boolean }> {
  return readdirSync(artifactPath, { withFileTypes: true })
    .filter(
      (entry) =>
        !entry.name.startsWith(".") &&
        entry.name !== ARTIFACT_MANIFEST &&
        entry.name !== ARTIFACT_DELIVERY_MANIFEST &&
        (entry.isFile() || entry.isDirectory()),
    )
    .map((entry) => ({
      name: entry.name,
      path: resolveArtifactItem(artifactPath, entry.name),
      directory: entry.isDirectory(),
    }))
    .sort((left, right) => {
      if (left.directory !== right.directory) return left.directory ? -1 : 1;
      return left.name.localeCompare(right.name, "en");
    });
}

function displayPath(path: string, environment: DisplayEnvironment): string {
  const distro = environment.wslDistroName ?? process.env.WSL_DISTRO_NAME;
  const platform = environment.platform ?? process.platform;
  if (platform === "linux" && distro) {
    const suffix = resolve(path).replaceAll("/", "\\");
    return `\\\\wsl.localhost\\${distro}${suffix}`;
  }
  if (
    platform === "linux" &&
    (process.env.WSL_INTEROP || process.env.HARNERY_AGENT_COORD_BRIDGE === "codex-wsl")
  ) {
    try {
      return execFileSync("wslpath", ["-w", resolve(path)], { encoding: "utf8" }).trim();
    } catch {
      // Fall through to the native path when wslpath is unavailable.
    }
  }
  return resolve(path);
}

function linkTarget(target: string): string {
  if (target.startsWith("http://") || target.startsWith("https://")) return target;
  if (target.startsWith("\\\\wsl.localhost\\")) {
    return `//${target.slice(2).replaceAll("\\", "/")}`;
  }
  return target.replaceAll("\\", "/");
}

function iconForPath(path: string): string {
  if (lstatSync(path).isDirectory()) return "📁";
  if (imagePath(path)) return "🖼️";
  if (/\.(?:m4v|mkv|mov|mp4|webm)$/i.test(path)) return "🎬";
  if (/\.(?:aac|flac|m4a|mp3|ogg|wav)$/i.test(path)) return "🎵";
  return "📄";
}

function imagePath(path: string): boolean {
  return /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(path);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}
