/**
 * Hurricane-style name pool for the agent coordination layer. The name-pool
 * assignment + resolution helpers.
 *
 * Layout invariant: 260 entries (10 per starting letter A..Z). Counter N
 * picks COORD_NAMES[N % 260]; wraps to A at N=260.
 *
 * Gender invariant: within each 26-name pass the names alternate female/male
 * letter by letter, so every pass is 13 female and 13 male. Five passes start
 * female at A (1, 3, 5, 7, 9) and five start male (2, 4, 6, 8, 10), which gives
 * each letter exactly five names of each gender and the pool 130/130 overall.
 * This exists so a fixed set of 13 female and 13 male portraits can dress one
 * whole pass. Adding or reordering a name must preserve it; the expected
 * pattern is pinned in tests/unit/names-pool.test.ts.
 *
 * Durable persistence: `.harnery/.name-history` (JSONL, one row per assignment)
 * + `.harnery/.name-counter` (current counter, atomic temp+rename).
 *
 * Recreation rule:
 *   1. Own instance_id in name-history → latest (name, kind, agent_id)
 *   2. session_id in name-history (owner != session) → latest parent's
 *      (name, agent_id) with kind="transient"
 *
 * Multiple rows for one instance are intentional. `identity assume` appends a
 * new binding instead of rewriting history; readers therefore resolve from the
 * end of the file. Older one-row histories retain their original behavior.
 *   3. Else: new assignment, consume a counter slot.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** All 260 names. */
export const COORD_NAMES = [
  // Pass 1 — female-first (A=female), alternating to Z
  "Anna",
  "Bob",
  "Carmen",
  "Dorian",
  "Erika",
  "Fred",
  "Gemma",
  "Hank",
  "Imelda",
  "Jerry",
  "Karen",
  "Lorenzo",
  "Mindy",
  "Nate",
  "Odette",
  "Peter",
  "Quinn",
  "Rafael",
  "Sara",
  "Tony",
  "Ursula",
  "Vinson",
  "Whitney",
  "Xander",
  "Yara",
  "Zane",
  // Pass 2 — male-first (A=male), alternating to Z
  "Alex",
  "Bertha",
  "Carlos",
  "Dalia",
  "Ernesto",
  "Francine",
  "Gordon",
  "Helene",
  "Isaias",
  "Joyce",
  "Kirk",
  "Lucia",
  "Milton",
  "Nadine",
  "Oscar",
  "Patty",
  "Quentin",
  "Rebekah",
  "Sean",
  "Tammy",
  "Ulrik",
  "Valerie",
  "Wallace",
  "Xanthe",
  "Yusuf",
  "Zara",
  // Pass 3 — female-first (A=female), alternating to Z
  "Adelaide",
  "Bruno",
  "Cora",
  "Damon",
  "Edna",
  "Felix",
  "Greta",
  "Hugo",
  "Ines",
  "Jasper",
  "Kaia",
  "Larry",
  "Maxine",
  "Nicholas",
  "Olive",
  "Paxton",
  "Querida",
  "Roman",
  "Stella",
  "Tobias",
  "Una",
  "Virgil",
  "Willow",
  "Xavier",
  "Yolanda",
  "Zephyr",
  // Pass 4 — male-first (A=male), alternating to Z
  "Aaron",
  "Beatrice",
  "Cyrus",
  "Delia",
  "Elias",
  "Florence",
  "Galileo",
  "Hester",
  "Ian",
  "Jenna",
  "Klaus",
  "Linda",
  "Marco",
  "Nora",
  "Otto",
  "Paulette",
  "Quill",
  "Renee",
  "Sebastian",
  "Theresa",
  "Umberto",
  "Vera",
  "Walter",
  "Xena",
  "Yves",
  "Zoe",
  // Pass 5 — female-first (A=female), alternating to Z
  "Anita",
  "Beau",
  "Celeste",
  "Dexter",
  "Edith",
  "Fitz",
  "Gloria",
  "Hadley",
  "Iris",
  "Jude",
  "Kira",
  "Leo",
  "Maya",
  "Nash",
  "Olga",
  "Phillip",
  "Quetzal",
  "Royce",
  "Sage",
  "Trent",
  "Uma",
  "Vincent",
  "Wynne",
  "Xerxes",
  "Yvette",
  "Zoltan",
  // Pass 6 — male-first (A=male), alternating to Z
  "Andre",
  "Bonnie",
  "Caleb",
  "Daphne",
  "Ezra",
  "Fiona",
  "Gibson",
  "Holly",
  "Ivan",
  "Juno",
  "Knox",
  "Lila",
  "Mason",
  "Nila",
  "Owen",
  "Petra",
  "Quincy",
  "Rosa",
  "Sterling",
  "Talia",
  "Uri",
  "Violet",
  "Wesley",
  "Ximena",
  "Yuri",
  "Zelda",
  // Pass 7 — female-first (A=female), alternating to Z
  "Astrid",
  "Boris",
  "Cassidy",
  "Davis",
  "Esme",
  "Forrest",
  "Genevieve",
  "Henry",
  "Imogen",
  "Joaquin",
  "Kestrel",
  "Luther",
  "Margot",
  "Nigel",
  "Ophelia",
  "Percy",
  "Quenby",
  "Reagan",
  "Sienna",
  "Truman",
  "Undine",
  "Voss",
  "Wren",
  "Xan",
  "Yael",
  "Zia",
  // Pass 8 — male-first (A=male), alternating to Z
  "Arthur",
  "Bianca",
  "Cody",
  "Dahlia",
  "Evander",
  "Fern",
  "Gustavo",
  "Harriet",
  "Ira",
  "Josephine",
  "Kendrick",
  "Lainey",
  "Miles",
  "Naomi",
  "Orion",
  "Pearl",
  "Quark",
  "Rylie",
  "Saul",
  "Tessa",
  "Ulysses",
  "Vesper",
  "Wyatt",
  "Xiomara",
  "Yancy",
  "Zinnia",
  // Pass 9 — female-first (A=female), alternating to Z
  "Amelia",
  "Barnaby",
  "Calliope",
  "Drake",
  "Estelle",
  "Foster",
  "Greer",
  "Hollis",
  "Irene",
  "Jericho",
  "Klara",
  "Logan",
  "Mavis",
  "Nico",
  "Oakley",
  "Pascal",
  "Quito",
  "Rhett",
  "Scout",
  "Theron",
  "Unity",
  "Vance",
  "Winifred",
  "Xola",
  "Yvonne",
  "Zev",
  // Pass 10 — male-first (A=male), alternating to Z
  "Atticus",
  "Brenda",
  "Crispin",
  "Dolores",
  "Eustace",
  "Felicity",
  "Granger",
  "Hazel",
  "Idris",
  "Jovi",
  "Kasper",
  "Lyric",
  "Magnus",
  "Noor",
  "Otis",
  "Phoebe",
  "Querubin",
  "Rosalind",
  "Silas",
  "Tatum",
  "Upton",
  "Vivian",
  "Wendell",
  "Xuxa",
  "Yann",
  "Zora",
] as const;

if (COORD_NAMES.length !== 260) {
  throw new Error(`COORD_NAMES table corrupt: expected 260 entries, got ${COORD_NAMES.length}`);
}

export type NameKind = "session" | "subagent" | "transient" | "workflow-child";

export interface NameHistoryRow {
  instance_id: string;
  name: string;
  kind: NameKind;
  ts: string;
  /** Durable persona UUID. Present after `agents identity assume`. */
  agent_id?: string;
  /** Audit marker distinguishing an explicit role adoption from pool assignment. */
  source?: "pool" | "identity.assume";
  previous_name?: string;
  /** Instance this session was forked/branched from (recorded fork lineage).
   * Stamped only on the row that first assigns this instance, when the adapter
   * layer detected or supplied a parent conversation. */
  forked_from?: string;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function counterPath(coordRoot: string): string {
  return join(coordRoot, ".harnery", ".name-counter");
}

function historyPath(coordRoot: string): string {
  return join(coordRoot, ".harnery", ".name-history");
}

function readHistory(coordRoot: string): NameHistoryRow[] {
  const p = historyPath(coordRoot);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as NameHistoryRow);
  } catch {
    return [];
  }
}

function appendHistory(coordRoot: string, row: NameHistoryRow): void {
  const p = historyPath(coordRoot);
  mkdirSync(dirname(p), { recursive: true });
  const line = `${JSON.stringify(row)}\n`;
  // Append is naturally atomic for lines <PIPE_BUF (4096 on Linux).
  writeFileSync(p, line, { encoding: "utf8", flag: "a" });
}

/**
 * Resolve (name, kind) for an existing owner without consuming a counter
 * slot. Returns null if no history match found.
 *
 *   1. Own instance_id → original (name, kind)
 *   2. session_id (owner != session) → (parent's name, "transient")
 */
export function resolveName(
  coordRoot: string,
  instanceId: string,
  sessionId?: string,
): { name: string; kind: NameKind; agent_id?: string } | null {
  const history = readHistory(coordRoot);

  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i]!;
    if (row.instance_id === instanceId) {
      return {
        name: row.name,
        kind: row.kind,
        ...(row.agent_id ? { agent_id: row.agent_id } : {}),
      };
    }
  }

  if (sessionId && sessionId !== instanceId) {
    for (let i = history.length - 1; i >= 0; i--) {
      const row = history[i]!;
      if (row.instance_id === sessionId) {
        return {
          name: row.name,
          kind: "transient",
          ...(row.agent_id ? { agent_id: row.agent_id } : {}),
        };
      }
    }
  }

  return null;
}

export interface NameAssumptionResult {
  changed: boolean;
  previous: { name: string; kind: NameKind; agent_id?: string } | null;
  current: { name: string; kind: NameKind; agent_id: string };
}

/**
 * Append an explicit instance → durable-persona binding. Latest-row-wins makes
 * this auditable and retry-safe without mutating prior assignment history.
 */
export function recordNameAssumption(
  coordRoot: string,
  instanceId: string,
  name: string,
  agentId: string,
  kind: NameKind = "session",
): NameAssumptionResult {
  const previous = resolveName(coordRoot, instanceId);
  const current = { name, kind, agent_id: agentId };
  if (
    previous?.name === current.name &&
    previous.kind === current.kind &&
    previous.agent_id === current.agent_id
  ) {
    return { changed: false, previous, current };
  }
  appendHistory(coordRoot, {
    instance_id: instanceId,
    name,
    kind,
    agent_id: agentId,
    source: "identity.assume",
    previous_name: previous?.name,
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  return { changed: true, previous, current };
}

/**
 * Assign a name to <instanceId> with the given <kind>. Counter-consuming when
 * the owner is new. Idempotent: returns existing name on resume.
 */
export function assignName(
  coordRoot: string,
  instanceId: string,
  kind: NameKind,
  opts?: { forkedFrom?: string },
): string {
  // Check 1: existing history row → original name. A resume re-enters here,
  // which also makes fork stamping naturally idempotent: lineage lands only on
  // the row that first assigns the instance.
  const existing = resolveName(coordRoot, instanceId);
  if (existing) return existing.name;

  // New owner: consume a counter slot.
  const cPath = counterPath(coordRoot);
  let counter = 0;
  if (existsSync(cPath)) {
    const raw = readFileSync(cPath, "utf8").trim();
    if (/^\d+$/.test(raw)) counter = Number.parseInt(raw, 10);
  }
  const name = COORD_NAMES[counter % 260]!;
  atomicWrite(cPath, String(counter + 1));
  const forkedFrom = opts?.forkedFrom;
  appendHistory(coordRoot, {
    instance_id: instanceId,
    name,
    kind,
    source: "pool",
    ...(forkedFrom && forkedFrom !== instanceId ? { forked_from: forkedFrom } : {}),
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  return name;
}

/** One step of recorded fork lineage: the latest row for <instanceId> that
 * carries `forked_from` (latest-row-wins, matching resolveName). */
export function readForkParent(
  coordRoot: string,
  instanceId: string,
): { instance_id: string; name: string | null } | null {
  const history = readHistory(coordRoot);
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i]!;
    if (row.instance_id !== instanceId) continue;
    if (!row.forked_from) return null;
    const parent = resolveName(coordRoot, row.forked_from);
    return { instance_id: row.forked_from, name: parent?.name ?? null };
  }
  return null;
}

/**
 * Full recorded fork ancestry for <instanceId>, nearest ancestor first, each
 * with its latest resolved name. Depth-capped and cycle-guarded: lineage is
 * append-only operational data, not something to trust unboundedly.
 */
export function resolveForkAncestry(
  coordRoot: string,
  instanceId: string,
): Array<{ instance_id: string; name: string | null }> {
  const out: Array<{ instance_id: string; name: string | null }> = [];
  const seen = new Set<string>([instanceId]);
  let cursor = instanceId;
  for (let depth = 0; depth < 20; depth++) {
    const parent = readForkParent(coordRoot, cursor);
    if (!parent || seen.has(parent.instance_id)) break;
    out.push(parent);
    seen.add(parent.instance_id);
    cursor = parent.instance_id;
  }
  return out;
}
