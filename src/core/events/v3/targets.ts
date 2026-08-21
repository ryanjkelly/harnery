import { isAbsolute, relative, resolve, sep } from "node:path";
import { type FingerprintContextV3, fingerprintV3 } from "./canonical.ts";
import type { EventPayloadV3 } from "./contract.ts";

export type TargetDescriptorV3 = EventPayloadV3<"tool.requested">["targets"][number];

export interface ExtractTargetsV3Input {
  coordRoot: string;
  toolNamespace: string;
  toolName: string;
  toolInput: unknown;
  fingerprintContext: FingerprintContextV3;
}

export interface DescribePathTargetV3Input {
  coordRoot: string;
  value: string;
  access: TargetDescriptorV3["access"];
  fingerprintContext: FingerprintContextV3;
  extractorVersion: string;
}

/** Describe one known path without exposing values outside the coordination root. */
export function describePathTargetV3(input: DescribePathTargetV3Input): TargetDescriptorV3 {
  return pathTarget(
    {
      coordRoot: input.coordRoot,
      fingerprintContext: input.fingerprintContext,
    },
    input.value,
    input.access,
    input.extractorVersion,
  );
}

/** Versioned, tool-specific target extraction. Unknown tools deliberately emit no guessed target. */
export function extractTargetsV3(input: ExtractTargetsV3Input): TargetDescriptorV3[] {
  const record = plainRecord(input.toolInput);
  if (!record) return [];
  const name = input.toolName.toLowerCase();
  const descriptors: TargetDescriptorV3[] = [];
  const addPath = (value: unknown, access: TargetDescriptorV3["access"], version: string) => {
    if (typeof value !== "string" || value.length === 0) return;
    descriptors.push(pathTarget(input, value, access, version));
  };
  const addOpaque = (
    kind: TargetDescriptorV3["kind"],
    value: unknown,
    access: TargetDescriptorV3["access"],
    version: string,
  ) => {
    if (typeof value !== "string" || value.length === 0) return;
    descriptors.push({
      kind,
      access,
      fingerprint: fingerprintV3(
        input.fingerprintContext,
        `semantic-target.${kind}`,
        value,
        "root",
      ),
      extractor_version: version,
    });
  };

  if (["read", "write", "edit", "multiedit", "notebookedit", "notebook_edit"].includes(name)) {
    const access = name === "read" ? "read" : "write";
    for (const field of ["file_path", "path", "notebook_path"]) {
      addPath(record[field], access, "file-tool-v1");
    }
    if (Array.isArray(record.paths)) {
      for (const path of record.paths) addPath(path, access, "file-tool-v1");
    }
  } else if (["grep", "search", "rg"].includes(name)) {
    addPath(record.path, "read", "search-tool-v1");
    addOpaque("pattern", record.pattern ?? record.query, "read", "search-tool-v1");
  } else if (["glob", "find"].includes(name)) {
    addPath(record.path, "read", "glob-tool-v1");
    addOpaque("pattern", record.pattern ?? record.glob, "read", "glob-tool-v1");
  } else if (["webfetch", "web_fetch", "fetch", "open"].includes(name)) {
    addOpaque("url", record.url ?? record.ref_id, "read", "web-tool-v1");
  } else if (["websearch", "web_search", "search_query"].includes(name)) {
    addOpaque("query", record.query ?? record.q, "read", "web-search-v1");
  } else if (["bash", "shell", "exec_command"].includes(name)) {
    addPath(record.workdir ?? record.cwd, "execute", "command-tool-v1");
  } else if (["artifact", "view_image", "image"].includes(name)) {
    addPath(record.path ?? record.file_path, "read", "artifact-tool-v1");
    addOpaque("artifact", record.artifact_id, "read", "artifact-tool-v1");
  } else if (["apply_patch", "patch"].includes(name)) {
    if (typeof record.patch === "string") {
      for (const path of extractPatchPaths(record.patch)) addPath(path, "write", "patch-tool-v1");
    }
  }
  return deduplicateTargets(descriptors);
}

export function exactToolInputFingerprintV3(
  context: FingerprintContextV3,
  toolNamespace: string,
  toolName: string,
  toolInput: unknown,
) {
  return fingerprintV3(context, "exact-input", {
    tool_namespace: toolNamespace,
    tool_name: toolName,
    input: toolInput,
  });
}

function pathTarget(
  input: Pick<ExtractTargetsV3Input, "coordRoot" | "fingerprintContext">,
  value: string,
  access: TargetDescriptorV3["access"],
  version: string,
): TargetDescriptorV3 {
  const root = resolve(input.coordRoot);
  const valueUsesWindowsRoot = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value);
  const coordRootUsesWindowsRoot = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(input.coordRoot);
  const valueUsesPosixRoot = value.startsWith("/");
  const foreignAbsolute =
    (valueUsesWindowsRoot && !coordRootUsesWindowsRoot) ||
    (valueUsesPosixRoot && coordRootUsesWindowsRoot);
  const resolved = resolve(root, value);
  const relativePath = relative(root, resolved);
  const contained =
    !foreignAbsolute &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
  if (contained) {
    const portable = relativePath.length === 0 ? "." : relativePath.split(sep).join("/");
    return {
      kind: "workspace_path",
      access,
      display: portable,
      fingerprint: fingerprintV3(
        input.fingerprintContext,
        "semantic-target.workspace-path",
        portable,
        "root",
      ),
      extractor_version: version,
    };
  }
  return {
    kind: "external_path",
    access,
    fingerprint: fingerprintV3(
      input.fingerprintContext,
      "semantic-target.external-path",
      value.normalize("NFC").replaceAll("\\", "/"),
      "root",
    ),
    extractor_version: version,
  };
}

function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match?.[1]) paths.push(match[1]);
  }
  return paths;
}

function deduplicateTargets(targets: TargetDescriptorV3[]): TargetDescriptorV3[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}\0${target.access}\0${target.fingerprint.digest}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}
