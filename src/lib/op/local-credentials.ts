/**
 * Machine-local mirrors of 1Password items, so ordinary reads do not open a
 * live 1Password session.
 *
 * A host registers which items it mirrors and where. A registered mirror that
 * is missing or malformed fails closed with the command that repairs it, so an
 * ordinary read never falls through to an unexpected approval prompt. Writes
 * validate the new content first and replace the file atomically, so a failed
 * pull keeps the last good copy.
 */

import { createPrivateKey, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { readStdinText } from "./process.ts";
import type { LocalCredentialFile, LocalCredentialSource, OpTarget } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LocalCredentialsConfig {
  binName: string;
  repoRoot: string;
  sources: LocalCredentialSource[];
}

/** Bind local-mirror reads and writes to one host's registry. */
export function createLocalCredentials(config: LocalCredentialsConfig) {
  const { binName, repoRoot, sources } = config;

  function matchingSource(target: OpTarget): LocalCredentialSource | undefined {
    return sources.find(
      (source) =>
        target.account === source.account &&
        target.item === source.item &&
        (target.vault === undefined || target.vault === source.vault),
    );
  }

  function invalidCache(source: LocalCredentialSource, detail: string): never {
    throw new Error(
      `Local credential cache ${source.path} ${detail}. ` +
        `Run \`${binName} creds pull --refresh ${source.pullKey}\` to replace it, or pass --live for an intentional 1Password read.`,
    );
  }

  function parseCredentialFile(source: LocalCredentialSource, raw: string): LocalCredentialFile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalidCache(source, "is not valid JSON");
    }
    if (!isRecord(parsed)) invalidCache(source, "must contain a JSON object");
    if (
      parsed.version !== 1 ||
      parsed.account !== source.account ||
      parsed.vault !== source.vault ||
      parsed.item !== source.item
    ) {
      invalidCache(source, "does not match its registered 1Password source");
    }
    if (!isRecord(parsed.fields)) invalidCache(source, "has no fields object");
    const fields: Record<string, string> = {};
    for (const [label, value] of Object.entries(parsed.fields)) {
      if (typeof value !== "string") invalidCache(source, `has a non-string value for ${label}`);
      if (value.includes("<REDACTED:"))
        invalidCache(source, `has a redaction placeholder for ${label}`);
      fields[label] = value;
    }
    for (const label of source.privateKeyFields ?? []) {
      try {
        if (createPrivateKey(fields[label] ?? "").asymmetricKeyType !== "rsa")
          throw new Error("not rsa");
      } catch {
        invalidCache(source, `has an invalid RSA private key for ${label}`);
      }
    }
    if (
      !Array.isArray(parsed.concealed_fields) ||
      !parsed.concealed_fields.every((value) => typeof value === "string")
    ) {
      invalidCache(source, "has an invalid concealed_fields list");
    }
    return {
      version: 1,
      account: source.account,
      vault: source.vault,
      item: source.item,
      category: typeof parsed.category === "string" ? parsed.category : undefined,
      fields,
      concealed_fields: parsed.concealed_fields as string[],
    };
  }

  /**
   * Load a registered mirror. Returns null only when the item has no local
   * mapping; a missing or malformed registered mirror throws.
   */
  function getLocalOpItem(target: OpTarget): LocalCredentialFile | null {
    const source = matchingSource(target);
    if (!source) return null;
    const path = resolve(repoRoot, source.path);
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch {
      invalidCache(
        source,
        `is missing; run \`${binName} creds pull ${source.pullKey}\` once to create it`,
      );
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      invalidCache(source, "must be a non-empty regular file");
    }
    return parseCredentialFile(source, readFileSync(path, "utf8"));
  }

  /** The named fields from a registered mirror, or null when the item has none. */
  function getLocalOpFields(target: OpTarget, labels: string[]): Record<string, string> | null {
    const source = matchingSource(target);
    const item = getLocalOpItem(target);
    if (!item || !source) return null;
    const values: Record<string, string> = {};
    for (const label of labels) {
      const value = item.fields[label];
      if (value === undefined || value === "")
        invalidCache(source, `does not contain a non-empty ${label} field`);
      values[label] = value;
    }
    return values;
  }

  /** Validate, then atomically replace a mirror with mode 600 in a non-symlinked directory. */
  function writeLocalOpCredential(
    source: LocalCredentialSource,
    fields: Record<string, string>,
  ): void {
    for (const label of source.fields) {
      if (!fields[label]) invalidCache(source, `has no non-empty ${label} field`);
    }
    const raw = JSON.stringify({
      version: 1,
      account: source.account,
      vault: source.vault,
      item: source.item,
      fields,
      concealed_fields: source.fields,
    });
    parseCredentialFile(source, raw);
    const path = resolve(repoRoot, source.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink())
      invalidCache(source, "directory must not be a symbolic link");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${raw}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** The registered source for a pull key, or undefined. */
  function sourceForPullKey(pullKey: string): LocalCredentialSource | undefined {
    return sources.find((source) => source.pullKey === pullKey);
  }

  /**
   * Write a single-field mirror from stdin. Pull scripts pipe a value in so it
   * never appears in argv. Returns the mirror's repository-relative path.
   */
  async function cacheFromStdin(
    pullKey: string,
    stream: NodeJS.ReadableStream = process.stdin,
  ): Promise<string> {
    const source = sourceForPullKey(pullKey);
    const field = source?.fields.length === 1 ? source.fields[0] : undefined;
    if (!source || field === undefined)
      throw new Error("a single-field registered cache is required");
    writeLocalOpCredential(source, { [field]: await readStdinText(stream) });
    return source.path;
  }

  return {
    sources,
    getLocalOpItem,
    getLocalOpFields,
    writeLocalOpCredential,
    sourceForPullKey,
    cacheFromStdin,
  };
}

export type LocalCredentials = ReturnType<typeof createLocalCredentials>;
