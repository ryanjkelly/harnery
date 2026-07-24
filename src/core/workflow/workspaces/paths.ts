import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { FilesystemIdentity, ValidatedFilesystemRoot } from "./types.ts";

const WINDOWS_AMBIGUOUS = /[<>:"|?*]|[ .]$/;

export type ValidatedRoot = ValidatedFilesystemRoot;

export interface OpenContainedDirectory {
  path: string;
  descriptor_path: string;
  fd: number;
  identity: FilesystemIdentity;
  close(): void;
}

export function filesystemIdentity(path: string): FilesystemIdentity {
  const stat = statSync(path, { bigint: true });
  if (stat.dev < 0n || stat.ino <= 0n) {
    throw new Error(`filesystem identity is unavailable for ${path}`);
  }
  return {
    platform: process.platform,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
}

export function sameFilesystemIdentity(
  left: FilesystemIdentity,
  right: FilesystemIdentity,
): boolean {
  return (
    left.platform === right.platform && left.device === right.device && left.inode === right.inode
  );
}

export function validateConfiguredRoot(root: string): ValidatedRoot {
  assertAbsoluteUnambiguous(root, "writable root");
  if (!existsSync(root)) throw new Error(`writable root does not exist: ${root}`);
  if (lstatSync(root).isSymbolicLink())
    throw new Error(`writable root must not be a symlink: ${root}`);
  if (!lstatSync(root).isDirectory()) throw new Error(`writable root is not a directory: ${root}`);
  const realpath = realpathSync(root);
  if (realpath !== root) {
    throw new Error(`writable root must not contain symlink components: ${root}`);
  }
  return { configured: root, realpath, identity: filesystemIdentity(realpath) };
}

export function revalidateRoot(root: ValidatedRoot): void {
  const current = validateConfiguredRoot(root.configured);
  if (
    current.realpath !== root.realpath ||
    !sameFilesystemIdentity(current.identity, root.identity)
  ) {
    throw new Error(`writable root identity changed: ${root.configured}`);
  }
}

export function assertSafeRelativeSegment(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be set`);
  if (containsControl(value)) throw new Error(`${field} contains control characters`);
  if (value !== value.normalize("NFC"))
    throw new Error(`${field} has ambiguous Unicode normalization`);
  if (
    isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`${field} must be one safe relative segment`);
  }
  if (process.platform === "win32" && WINDOWS_AMBIGUOUS.test(value)) {
    throw new Error(`${field} is ambiguous on this platform`);
  }
}

export function containsPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${separator()}`) && !isAbsolute(rel));
}

export function assertContainedExisting(
  root: ValidatedRoot,
  candidate: string,
  label: string,
): string {
  revalidateRoot(root);
  assertAbsoluteUnambiguous(candidate, label);
  if (!existsSync(candidate)) throw new Error(`${label} does not exist: ${candidate}`);
  if (lstatSync(candidate).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = realpathSync(candidate);
  if (!containsPath(root.realpath, real)) {
    throw new Error(
      `${label} ${JSON.stringify(candidate)} escapes ${JSON.stringify(root.configured)}`,
    );
  }
  return real;
}

export function createContainedDirectories(
  root: ValidatedRoot,
  segments: readonly string[],
): string {
  const opened = openContainedDirectory(root, segments);
  try {
    return opened.path;
  } finally {
    opened.close();
  }
}

export function openContainedDirectory(
  root: ValidatedRoot,
  segments: readonly string[],
): OpenContainedDirectory {
  if (segments.length === 0) throw new Error("contained directory requires at least one segment");
  if (!descriptorBackedPathsSupported()) {
    throw new Error("descriptor-backed workspace paths are unavailable");
  }
  const fds: number[] = [];
  try {
    revalidateRoot(root);
    let cursor = root.realpath;
    let parentFd = openSync(
      cursor,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    fds.push(parentFd);
    if (!sameFilesystemIdentity(filesystemIdentity(descriptorPath(parentFd)), root.identity)) {
      throw new Error("writable root descriptor identity changed");
    }
    for (const [index, segment] of segments.entries()) {
      assertSafeRelativeSegment(segment, `path segment ${index + 1}`);
      const candidate = join(descriptorPath(parentFd), segment);
      if (existsSync(candidate)) {
        const stat = lstatSync(candidate);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(
            `contained path component is not an owned directory: ${join(cursor, segment)}`,
          );
        }
      } else {
        mkdirSync(candidate, { mode: 0o700 });
      }
      const childFd = openSync(
        candidate,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      fds.push(childFd);
      const real = realpathSync(descriptorPath(childFd));
      if (!containsPath(root.realpath, real)) {
        throw new Error(`contained path escaped root: ${join(cursor, segment)}`);
      }
      cursor = real;
      parentFd = childFd;
    }
    revalidateRoot(root);
    let closed = false;
    return {
      path: cursor,
      descriptor_path: descriptorPath(parentFd),
      fd: parentFd,
      identity: filesystemIdentity(descriptorPath(parentFd)),
      close() {
        if (closed) return;
        for (const fd of [...fds].reverse()) closeSync(fd);
        closed = true;
      },
    };
  } catch (error) {
    for (const fd of [...fds].reverse()) closeSync(fd);
    throw error;
  }
}

export function candidateUnderRoot(root: ValidatedRoot, segments: readonly string[]): string {
  revalidateRoot(root);
  for (const [index, segment] of segments.entries()) {
    assertSafeRelativeSegment(segment, `path segment ${index + 1}`);
  }
  const candidate = join(root.realpath, ...segments);
  if (!containsPath(root.realpath, candidate)) throw new Error("workspace candidate escapes root");
  return candidate;
}

export function assertPathIdentity(
  path: string,
  expected: FilesystemIdentity,
  label: string,
): void {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
    throw new Error(`${label} is missing or is a symlink`);
  }
  if (!sameFilesystemIdentity(filesystemIdentity(path), expected)) {
    throw new Error(`${label} identity changed`);
  }
}

function assertAbsoluteUnambiguous(value: string, field: string): void {
  if (!value || containsControl(value)) throw new Error(`${field} contains control characters`);
  if (!isAbsolute(value)) throw new Error(`${field} must be an absolute path`);
  if (value !== value.normalize("NFC")) {
    throw new Error(`${field} has ambiguous Unicode normalization`);
  }
  if (resolve(value) !== value) {
    throw new Error(`${field} contains parent traversal or ambiguous path normalization`);
  }
}

function separator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function descriptorBackedPathsSupported(): boolean {
  return (
    process.platform !== "win32" &&
    constants.O_DIRECTORY !== undefined &&
    constants.O_NOFOLLOW !== undefined &&
    existsSync("/proc/self/fd")
  );
}

export function descriptorPath(fd: number): string {
  if (!descriptorBackedPathsSupported() || !Number.isSafeInteger(fd) || fd < 0) {
    throw new Error("descriptor-backed workspace paths are unavailable");
  }
  return `/proc/self/fd/${fd}`;
}
