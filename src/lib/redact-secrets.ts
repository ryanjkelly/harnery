/**
 * Masks anything that looks like a secret in command text and prompts before
 * the text is stored or shown. One implementation, so every surface that
 * shows another program's commands or prompts masks the same things.
 *
 * What it masks (each value is replaced by `REDACTED_MARKER`):
 *
 * - PEM private-key blocks, whole.
 * - Credentials in a URL (`scheme://user:pass@host`): the `user:pass` part.
 * - `Authorization:` header values and `Bearer` / `Basic` / `Token` values.
 * - The value of a flag whose last name part is a secret word
 *   (`--password`, `--token`, `--api-key`, `--client-secret`, `-p` is not
 *   one): in argv form the next argument, in text form `--flag value` or
 *   `--flag=value`. `--key-file path` is not masked: its last part is "file".
 * - `NAME=value`, `NAME: value` and `"name": "value"` pairs whose name
 *   contains PASS, SECRET, TOKEN, KEY, AUTH (not AUTHOR), CREDENTIAL, COOKIE,
 *   PRIVATE or SESSION, and URL query parameters with those names or `sig`,
 *   `signature` or `code`. A value that only refers to a variable (`$TOKEN`,
 *   `${TOKEN}`, `%TOKEN%`) is kept: it is not the secret itself.
 * - Well-known token shapes: `sk-…` / `sk-ant-…`, GitHub `ghp_` `gho_` `ghu_`
 *   `ghs_` `ghr_` `github_pat_`, Slack `xox[abposr]-`, AWS `AKIA…`, Google
 *   `AIza…` and `ya29.…`, and JWTs (`eyJ….eyJ….…`).
 * - Any other unbroken run of 32 or more base64/hex-like characters that has
 *   both a letter and a digit and a stretch of 16 or more characters without
 *   a `-` or `_`.
 *
 * What it deliberately keeps (false-positive choices):
 *
 * - File paths: a long run is judged one `/` segment at a time, so a path is
 *   kept unless one of its segments is itself secret-shaped.
 * - UUIDs (and runs made only of UUIDs): ids, never secrets on their own.
 * - A 40-character lowercase hex string: treated as a git commit SHA. Hex of
 *   any other length 32+ (MD5-length keys, 64-hex keys) is masked, except
 *   right after a `sha1:`, `sha256:` or `sha512:` prefix, which marks a
 *   content digest.
 * - Long identifiers made of words (`my-very-long-script-name-for-backups`)
 *   and letter-only runs: no digit, or no 16-character stretch between
 *   separators.
 *
 * Masking is best effort. It reduces what a shared screen or link shows; it
 * is not a guarantee that no secret remains.
 */

/** The fixed text that replaces a masked value. */
export const REDACTED_MARKER = "‹redacted›";

export interface RedactedText {
  text: string;
  /** True when anything was masked. */
  redacted: boolean;
}

export interface RedactedArgv {
  argv: string[];
  /** True when anything was masked. */
  redacted: boolean;
}

const M = REDACTED_MARKER;

/** Words that make a flag a secret flag when they are its last name part. */
const SECRET_FLAG_WORDS =
  "password|passwd|passphrase|pass|pwd|token|secret|key|apikey|auth|credential|credentials|cookie";

/** `--api-key`, `--client_secret`, `--token`; the secret word must end the name. */
const SECRET_FLAG_NAME = new RegExp(`^--?(?:[A-Za-z0-9]+[-_])*(?:${SECRET_FLAG_WORDS})$`, "i");

/** A name (env var, query parameter, JSON key) that holds a secret. */
const SECRET_NAME_WORDS = /PASS|PWD|SECRET|TOKEN|KEY|AUTH|CREDENTIAL|COOKIE|PRIVATE|SESSION/i;

/** Query-parameter names that are secret only inside a URL. */
const SECRET_QUERY_NAMES = /^(?:sig|signature|code|x-amz-signature|x-goog-signature)$/i;

function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (!SECRET_NAME_WORDS.test(upper)) return false;
  // AUTHOR / AUTHORS / GIT_AUTHOR_NAME are names, not credentials.
  const withoutAuthor = upper.replace(/AUTHORS?/g, "");
  return SECRET_NAME_WORDS.test(withoutAuthor);
}

/** A value that only names a variable, so it is not the secret itself. */
function isVariableReference(value: string): boolean {
  const v = value.replace(/^["']|["']$/g, "");
  return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v) || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(v);
}

/** Mask a value but keep its quotes, so the line still reads as written. */
function maskValue(value: string): string {
  if (value.length === 0 || isVariableReference(value) || value === M) return value;
  const q = value[0];
  if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) return `${q}${M}${q}`;
  return M;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ONLY_UUIDS = new RegExp(`^${UUID}(?:[-_.:]${UUID})*$`);

/** Whether one `/`-free stretch of a long run looks like a random secret. */
function isRandomLooking(segment: string): boolean {
  if (segment.length < 32) return false;
  if (ONLY_UUIDS.test(segment)) return false;
  if (/^[0-9a-f]{40}$/.test(segment)) return false; // a git commit SHA
  if (!/[A-Za-z]/.test(segment) || !/[0-9]/.test(segment)) return false;
  const longest = Math.max(...segment.split(/[-_]/).map((p) => p.length));
  return longest >= 16;
}

/** Mask secret-shaped `/` segments of one long run; paths keep their other segments. */
function maskLongRun(run: string, before: string): string {
  if (/(?:sha1|sha256|sha512)[:=]$/i.test(before)) return run;
  return run
    .split("/")
    .map((segment) => {
      // Trailing `=` padding belongs to base64, so judge the run without it.
      const core = segment.replace(/=+$/, "");
      return isRandomLooking(core) ? M : segment;
    })
    .join("/");
}

/** Text-level rules, applied in order. Each returns the new text. */
type Rule = (text: string) => string;

const VALUE = `("[^"]*"|'[^']*'|[^\\s"'&;,)]+)`;

const RULES: Rule[] = [
  // PEM private-key blocks.
  (t) =>
    t.replace(/-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g, M),
  // Credentials in a URL.
  (t) => t.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, `$1${M}@`),
  // Authorization header values, then bare Bearer/Basic/Token values.
  (t) =>
    t.replace(
      /\b(Authorization\s*[:=]\s*)(?:(Bearer|Basic|Token|Digest)\s+)?("[^"]*"|'[^']*'|[^\s"',;]+)/gi,
      (_m, head: string, scheme: string | undefined, value: string) =>
        `${head}${scheme ? `${scheme} ` : ""}${maskValue(value)}`,
    ),
  (t) =>
    t.replace(
      /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/g,
      (_m, scheme: string, value: string) => `${scheme} ${maskValue(value)}`,
    ),
  // Secret flags with a value: `--token abc`, `--token=abc`.
  (t) =>
    t.replace(
      new RegExp(
        `(^|[\\s"'(])(--?(?:[A-Za-z0-9]+[-_])*(?:${SECRET_FLAG_WORDS}))(=|\\s+)${VALUE}`,
        "gi",
      ),
      (m, lead: string, flag: string, sep: string, value: string) => {
        if (value.startsWith("-")) return m; // the next flag, not a value
        return `${lead}${flag}${sep}${maskValue(value)}`;
      },
    ),
  // URL query parameters: `?access_token=…&sig=…`.
  (t) =>
    t.replace(
      /([?&])([A-Za-z0-9_.-]+)=([^&\s#"']*)/g,
      (m, lead: string, name: string, value: string) =>
        (isSecretName(name) || SECRET_QUERY_NAMES.test(name)) && value.length > 0
          ? `${lead}${name}=${maskValue(value)}`
          : m,
    ),
  // `"api_key": "…"` in JSON-like text.
  (t) =>
    t.replace(
      /("([A-Za-z0-9_.-]+)"\s*:\s*)("(?:[^"\\]|\\.)*")/g,
      (m, head: string, name: string, value: string) =>
        isSecretName(name) && value.length > 2 ? `${head}${maskValue(value)}` : m,
    ),
  // `NAME=value` and `NAME: value` pairs.
  (t) =>
    t.replace(
      new RegExp(`(^|[\\s"'(;,{])([A-Za-z_][A-Za-z0-9_.-]*)(=|:[ \\t]*)${VALUE}`, "g"),
      (m, lead: string, name: string, sep: string, value: string) => {
        if (!isSecretName(name)) return m;
        // `key: value` prose ("Key: the backups") only counts in NAME_STYLE form.
        if (sep.startsWith(":") && !/^[A-Z0-9_]+$/.test(name) && !/[-_]/.test(name)) return m;
        if (value.startsWith("//")) return m; // `http://` and the like
        return `${lead}${name}${sep}${maskValue(value)}`;
      },
    ),
  // Well-known token shapes.
  (t) =>
    t.replace(
      /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
      M,
    ),
  // Any other long base64/hex-like run.
  (t) =>
    t.replace(/[A-Za-z0-9+/=_-]{32,}/g, (run: string, offset: number, whole: string) =>
      maskLongRun(run, whole.slice(Math.max(0, offset - 8), offset)),
    ),
];

/** Mask secret-looking values in free text (a prompt, a shell line). */
export function redactSecretText(text: string): RedactedText {
  let out = text;
  for (const rule of RULES) out = rule(out);
  return { text: out, redacted: out !== text };
}

/**
 * Mask secret-looking values in an argument list. A secret flag's next
 * argument is masked whole; every argument also goes through the text rules.
 */
export function redactSecretArgv(argv: readonly string[]): RedactedArgv {
  const out: string[] = [];
  let redacted = false;
  let maskNext = false;
  for (const arg of argv) {
    if (maskNext) {
      maskNext = false;
      if (!arg.startsWith("-") && !isVariableReference(arg)) {
        out.push(M);
        redacted = true;
        continue;
      }
    }
    if (SECRET_FLAG_NAME.test(arg)) maskNext = true;
    const r = redactSecretText(arg);
    if (r.redacted) redacted = true;
    out.push(r.text);
  }
  return { argv: out, redacted };
}
