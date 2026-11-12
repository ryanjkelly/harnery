/**
 * Text-preserving edits to one path-list entry in a JSON settings document.
 *
 * Claude Code settings files are written by people and by other tools, and they
 * can hold tokens. Harnery changes exactly one entry, `env.<name>`, and leaves
 * every other byte as it was: indentation, key order, line endings and the
 * final newline. A small scanner finds the spans to change; it only has to work
 * on a document that already parsed as a JSON object.
 *
 * Every edit is checked before it is returned: the new text is parsed and
 * compared with the parsed original plus the one intended change. When they
 * differ, or the scanner cannot place the edit, the result is an error and the
 * caller writes nothing.
 */

interface Span {
  start: number;
  end: number;
}

interface Member {
  key: string;
  /** Just after the `{` or `,` that precedes this member. */
  leadStart: number;
  keyStart: number;
  keyEnd: number;
  value: JsonNode;
}

type JsonNode =
  | (Span & { kind: "object"; members: Member[] })
  | (Span & { kind: "string" })
  | (Span & { kind: "other" });

type ObjectNode = Extract<JsonNode, { kind: "object" }>;

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Locate the spans of a JSON document. Null when the text is not plain JSON. */
export function scanJson(text: string): JsonNode | null {
  let pos = 0;

  const skip = () => {
    while (pos < text.length && isSpace(text[pos])) pos++;
  };

  const scanString = (): Span | null => {
    if (text[pos] !== '"') return null;
    const start = pos++;
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === "\\") pos += 2;
      else if (ch === '"') return { start, end: ++pos };
      else pos++;
    }
    return null;
  };

  const scanValue = (depth: number): JsonNode | null => {
    if (depth > 512) return null;
    skip();
    const ch = text[pos];
    if (ch === '"') {
      const span = scanString();
      return span ? { ...span, kind: "string" } : null;
    }
    if (ch === "{") {
      const start = pos++;
      const members: Member[] = [];
      let leadStart = pos;
      skip();
      if (text[pos] === "}") return { start, end: ++pos, kind: "object", members };
      for (;;) {
        skip();
        const keySpan = scanString();
        if (!keySpan) return null;
        let key: string;
        try {
          key = JSON.parse(text.slice(keySpan.start, keySpan.end));
        } catch {
          return null;
        }
        skip();
        if (text[pos] !== ":") return null;
        pos++;
        const value = scanValue(depth + 1);
        if (!value) return null;
        members.push({ key, leadStart, keyStart: keySpan.start, keyEnd: keySpan.end, value });
        skip();
        if (text[pos] === ",") {
          leadStart = ++pos;
          continue;
        }
        if (text[pos] === "}") return { start, end: ++pos, kind: "object", members };
        return null;
      }
    }
    if (ch === "[") {
      const start = pos++;
      skip();
      if (text[pos] === "]") return { start, end: ++pos, kind: "other" };
      for (;;) {
        if (!scanValue(depth + 1)) return null;
        skip();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "]") return { start, end: ++pos, kind: "other" };
        return null;
      }
    }
    const start = pos;
    while (pos < text.length && /[-+.0-9A-Za-z]/.test(text[pos] as string)) pos++;
    return pos > start ? { start, end: pos, kind: "other" } : null;
  };

  const root = scanValue(0);
  if (!root) return null;
  skip();
  return pos === text.length ? root : null;
}

interface Edit {
  start: number;
  end: number;
  insert: string;
}

function apply(text: string, edit: Edit): string {
  return text.slice(0, edit.start) + edit.insert + text.slice(edit.end);
}

function firstMember(node: ObjectNode, key: string): Member | undefined {
  return node.members.find((m) => m.key === key);
}

/** A string's JSON body without its quotes, as `JSON.stringify` writes it. */
function escaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function newlineOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Append `"key"<colon><value>` as the last member of `node`, matching how its
 * existing members are laid out. `nested` builds the value text from the
 * member's indentation, or null when the member sits on the object's own line.
 */
function appendMember(
  text: string,
  node: ObjectNode,
  key: string,
  nested: (layout: { indent: string; newline: string } | null, colon: string) => string,
): Edit {
  const last = node.members.at(-1);
  const keyText = JSON.stringify(key);
  if (last) {
    const lead = text.slice(last.leadStart, last.keyStart);
    const colon = text.slice(last.keyEnd, last.value.start);
    const nl = lead.lastIndexOf("\n");
    const layout =
      nl >= 0
        ? { indent: lead.slice(nl + 1), newline: lead.includes("\r\n") ? "\r\n" : "\n" }
        : null;
    return {
      start: last.value.end,
      end: last.value.end,
      insert: `,${lead}${keyText}${colon}${nested(layout, colon)}`,
    };
  }
  const open = node.start + 1;
  if (open === node.end - 1) {
    // `{}`: lay the member out on its own line, two spaces in.
    const newline = newlineOf(text);
    const layout = { indent: "  ", newline };
    return {
      start: open,
      end: open,
      insert: `${newline}  ${keyText}: ${nested(layout, ": ")}${newline}`,
    };
  }
  // `{ }` or `{\n}`: keep the inner whitespace after the new member.
  return { start: open, end: open, insert: `${keyText}: ${nested(null, ": ")}` };
}

/** Remove the member at `index`, with the comma that separates it. */
function removeMember(text: string, node: ObjectNode, index: number): Edit {
  const member = node.members[index] as Member;
  if (node.members.length === 1) {
    const lead = text.slice(member.leadStart, member.keyStart);
    // A member on its own line leaves `{}`; one on the brace's line keeps the
    // whitespace around it, which is how `appendMember` found the object.
    return lead.includes("\n")
      ? { start: node.start + 1, end: node.end - 1, insert: "" }
      : { start: member.keyStart, end: member.value.end, insert: "" };
  }
  if (index > 0) {
    const prev = node.members[index - 1] as Member;
    return { start: prev.value.end, end: member.value.end, insert: "" };
  }
  const next = node.members[1] as Member;
  return { start: member.keyStart, end: next.keyStart, insert: "" };
}

/** Order-sensitive structural equality of two parsed JSON values. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type PathListEdit =
  | { ok: true; text: string; createdEnv: boolean; createdMember: boolean }
  | { ok: false; error: string };

export interface PathListOptions {
  /** The `env` member that holds the list, such as `CLAUDE_CODE_PLUGIN_DIRS`. */
  name: string;
  /** The path-list separator (`:` or `;`). */
  delimiter: string;
}

/** Check the edit by parsing it and comparing with the intended value. */
function verified(next: string, intended: unknown): boolean {
  try {
    return sameJson(JSON.parse(next), intended);
  } catch {
    return false;
  }
}

const UNPLACED = "Harnery could not place the change without touching other settings";

/**
 * Add `dir` to the end of `env.<name>` in `text`, creating the entry or the
 * `env` object when missing. `text` must parse as a JSON object.
 */
export function addPathListEntry(
  text: string,
  dir: string,
  options: PathListOptions,
): PathListEdit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "it is not valid JSON" };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "it is not a JSON object" };
  const root = scanJson(text);
  if (root?.kind !== "object") return { ok: false, error: UNPLACED };

  const env = parsed.env;
  const envMember = firstMember(root, "env");
  let edit: Edit;
  let intended: Record<string, unknown>;
  let createdEnv = false;
  let createdMember = false;

  if (env === undefined) {
    if (envMember) return { ok: false, error: UNPLACED };
    const entry = JSON.stringify(options.name);
    edit = appendMember(text, root, "env", (layout, colon) =>
      layout
        ? `{${layout.newline}${layout.indent}${layout.indent}${entry}${colon}${JSON.stringify(dir)}${layout.newline}${layout.indent}}`
        : `{${entry}${colon}${JSON.stringify(dir)}}`,
    );
    intended = { ...parsed, env: { [options.name]: dir } };
    createdEnv = true;
    createdMember = true;
  } else {
    if (!isPlainObject(env)) return { ok: false, error: "its env setting is not an object" };
    if (envMember?.value.kind !== "object") return { ok: false, error: UNPLACED };
    const current = env[options.name];
    const member = firstMember(envMember.value, options.name);
    if (current === undefined) {
      if (member) return { ok: false, error: UNPLACED };
      edit = appendMember(text, envMember.value, options.name, () => JSON.stringify(dir));
      intended = { ...parsed, env: { ...env, [options.name]: dir } };
      createdMember = true;
    } else {
      if (typeof current !== "string") {
        return { ok: false, error: `its ${options.name} setting is not a string` };
      }
      if (member?.value.kind !== "string") return { ok: false, error: UNPLACED };
      const added = current === "" ? dir : `${options.delimiter}${dir}`;
      const closing = member.value.end - 1;
      edit = { start: closing, end: closing, insert: escaped(added) };
      intended = { ...parsed, env: { ...env, [options.name]: current + added } };
    }
  }

  const next = apply(text, edit);
  if (!verified(next, intended)) return { ok: false, error: UNPLACED };
  return { ok: true, text: next, createdEnv, createdMember };
}

export interface RemoveOptions extends PathListOptions {
  /** True when `dir` matches an entry in the list. */
  matches: (entry: string) => boolean;
  /** The add created the `env` object: remove it if it ends up empty. */
  createdEnv: boolean;
  /** The add created the entry: remove it when the list ends up empty. */
  createdMember: boolean;
}

export type PathListRemoval = { ok: true; text: string } | { ok: false; error: string };

function splitList(value: string, delimiter: string): string[] {
  return value.split(delimiter).filter((p) => p.trim());
}

/**
 * Take `dir` out of `env.<name>`. An entry this install created goes when the
 * list is empty, and the `env` object goes too when this install created it and
 * nothing else is in it. `text` must parse as a JSON object.
 */
export function removePathListEntry(
  text: string,
  dir: string,
  options: RemoveOptions,
): PathListRemoval {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "it is not valid JSON" };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "it is not a JSON object" };
  const env = parsed.env;
  const current = isPlainObject(env) ? env[options.name] : undefined;
  if (!isPlainObject(env) || typeof current !== "string") {
    return { ok: true, text };
  }
  const entries = splitList(current, options.delimiter);
  const kept = entries.filter((p) => !options.matches(p));
  if (kept.length === entries.length) return { ok: true, text };

  const root = scanJson(text);
  if (root?.kind !== "object") return { ok: false, error: UNPLACED };
  const envIndex = root.members.findIndex((m) => m.key === "env");
  const envMember = root.members[envIndex];
  if (envMember?.value.kind !== "object") return { ok: false, error: UNPLACED };
  const envNode = envMember.value;
  const index = envNode.members.findIndex((m) => m.key === options.name);
  const member = envNode.members[index];
  if (member?.value.kind !== "string") return { ok: false, error: UNPLACED };

  const raw = text.slice(member.value.start + 1, member.value.end - 1);
  let edit: Edit;
  let intended: Record<string, unknown>;

  if (kept.length === 0 && options.createdMember) {
    const restEnv = { ...env };
    delete restEnv[options.name];
    if (options.createdEnv && Object.keys(restEnv).length === 0) {
      edit = removeMember(text, root, envIndex);
      intended = { ...parsed };
      delete intended.env;
    } else {
      edit = removeMember(text, envNode, index);
      intended = { ...parsed, env: restEnv };
    }
  } else {
    // Cut exactly what the add appended when it is still at the end, so the
    // literal returns to its original spelling; otherwise rewrite the list.
    const suffix = escaped(`${options.delimiter}${dir}`);
    const alone = escaped(dir);
    let value: string;
    const wanted = kept.join(options.delimiter);
    const withoutSuffix =
      kept.length > 0 && raw.endsWith(suffix)
        ? (JSON.parse(`"${raw.slice(0, -suffix.length)}"`) as string)
        : null;
    // The shortcut is only right when cutting the tail removes every matching
    // entry; an earlier duplicate has to go too, so the list is rewritten.
    if (withoutSuffix !== null && withoutSuffix === wanted) {
      const cut = member.value.end - 1 - suffix.length;
      edit = { start: cut, end: member.value.end - 1, insert: "" };
      value = withoutSuffix;
    } else if (kept.length === 0 && raw === alone) {
      edit = { start: member.value.start + 1, end: member.value.end - 1, insert: "" };
      value = "";
    } else {
      value = wanted;
      edit = { start: member.value.start, end: member.value.end, insert: JSON.stringify(value) };
    }
    intended = { ...parsed, env: { ...env, [options.name]: value } };
  }

  const next = apply(text, edit);
  if (!verified(next, intended)) return { ok: false, error: UNPLACED };
  return { ok: true, text: next };
}
