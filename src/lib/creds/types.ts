/**
 * Contracts for the credential toolkit (`harnery/lib/creds`).
 *
 * A host keeps a registry of pull scripts, each of which reads secrets from
 * 1Password and writes machine-local files. The toolkit runs those scripts,
 * checks that their files exist and hold usable values, re-pulls files whose
 * registered revision moved, and backs off a script that keeps failing so a
 * session start does not prompt for it every time. The host supplies every
 * name, path, and script; the toolkit names none.
 */

/** A file a pull script writes. */
export interface CredentialFileSpec {
  /**
   * Path relative to the repository that owns it, or to the home directory
   * when it starts with `~/`.
   */
  path: string;
  /**
   * Owning repository when the host spans several (for example, a submodule
   * name). Null or absent means the host repository itself.
   */
  repo?: string | null;
  /** Keys that must be present with a usable value (dotenv, YAML, or JSON files). */
  requiredKeys?: string[];
  /**
   * At least one of these keys must hold a usable value, for a file that may
   * carry either of two shapes (an OAuth client's "installed" or "web" form).
   */
  anyOfKeys?: string[];
  /** What the file holds; defaults to its source's description. */
  description?: string;
  /**
   * Bump after the secret in this file is rotated, so every clone re-pulls it.
   * Overrides the source's revision for this file. Absent means the source's.
   */
  revision?: number;
}

/** One pull script and the files it produces. */
export interface CredentialSource {
  /** Stable key used on the command line, such as `pull <key>`. */
  key: string;
  /** Script path relative to the owning repository. */
  script: string;
  /** Owning repository; see `CredentialFileSpec.repo`. */
  repo?: string | null;
  description: string;
  /**
   * Every file the script writes. Heal reads this to decide whether the
   * credential is present on this clone, so an under-listed script looks
   * healthy while part of its output is missing.
   */
  files: CredentialFileSpec[];
  /**
   * Bump after the secret behind this source is rotated or moved, so every
   * clone re-pulls it on its next heal. Absent means 1.
   */
  revision?: number;
  /**
   * Wired but not provisioned yet. A bulk pull and heal skip it; an explicit
   * `pull <key>` still runs it.
   */
  pending?: boolean;
}

/**
 * A credential file that no pull script can recreate, such as one a setup
 * command writes. Check reports it; heal does not pretend to repair it.
 */
export interface StandaloneCredentialFile extends CredentialFileSpec {
  description: string;
}

/** One 1Password item a pull script reads, for `verify`. */
export interface CredManifestEntry {
  vault: string;
  item: string;
  /** Field labels or IDs expected on the item. Empty for `kind: "document"`. */
  fields: string[];
  /** Keys of the sources that read this item. */
  scripts: string[];
  /** `"fields"` (default) checks each field; `"document"` checks that the item resolves. */
  kind?: "fields" | "document";
  /** Not provisioned yet; verify reports it as pending instead of missing. */
  pending?: boolean;
}

/** Manifest entries for one item, merged so verify makes one `op` call per item. */
export interface ItemGroup {
  vault: string;
  item: string;
  fields: string[];
  scripts: string[];
  /**
   * Fields referenced only by pending entries. Pending is per field because a
   * field that is not provisioned yet can share an item with live fields.
   */
  pendingFields: string[];
  /** Every entry naming this item is pending (an unprovisioned document, for example). */
  pending: boolean;
  kind: "fields" | "document";
}

export type ProbeStatus = "live" | "dead" | "skipped";

export interface ProbeResult {
  status: ProbeStatus;
  /** One line, safe to print: never the secret itself. */
  detail: string;
}

/**
 * A live authentication check for one source, run by `check` unless the
 * caller asks for a file-only check. Probes are host code: the toolkit only
 * runs them and reports their results.
 */
export type Probe = () => Promise<ProbeResult>;

/** Points where a host adds behavior the toolkit does not own. */
export interface CredHooks {
  /** Live probes keyed by source key. */
  probes?: Record<string, Probe>;
  /** Runs after a successful pull, for example to rebuild a derived cache. */
  afterPull?: (keys: string[]) => Promise<void>;
}

/** Everything host-specific the credential toolkit needs. */
export interface CredsHostConfig {
  /** CLI name used in messages that tell someone what to run. */
  binName: string;
  /** Absolute path of the host repository. */
  repoRoot: string;
  /** Name recorded for the host repository in revision keys. */
  repoName: string;
  /** Absolute paths of other repositories named by `repo` fields. */
  repoPaths?: Record<string, string>;
  /** Default 1Password account for `verify`. */
  defaultAccount?: string;
  sources: CredentialSource[];
  standaloneFiles?: StandaloneCredentialFile[];
  manifest: CredManifestEntry[];
  /** File that records which revision of each credential was last pulled. */
  revisionStatePath: string;
  /** File that records failing sources and when each may be retried. */
  backoffStatePath: string;
  /** Environment variable that overrides the retry delay in hours. */
  backoffHoursEnv: string;
  hooks?: CredHooks;
}
