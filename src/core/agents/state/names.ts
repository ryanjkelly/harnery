/**
 * Hurricane-style name pool for the agent coordination layer. The name-pool
 * assignment + resolution helpers.
 *
 * Layout invariant: 260 entries (10 per starting letter A..Z). Counter N
 * picks COORD_NAMES[N % 260]; wraps to A at N=260.
 *
 * Durable persistence: `.harnery/.name-history` (JSONL, one row per assignment)
 * + `.harnery/.name-counter` (current counter, atomic temp+rename).
 *
 * Recreation rule (mirrors v1):
 *   1. Own instance_id in name-history → (original name, original kind)
 *   2. session_id in name-history (owner != session) → (parent's name, "transient")
 *   3. Else: new assignment, consume a counter slot.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** All 260 names. */
export const COORD_NAMES = [
  // Pass 1
  "Anna",
  "Bob",
  "Carlos",
  "Dalia",
  "Erika",
  "Fred",
  "Gemma",
  "Hank",
  "Imelda",
  "Jerry",
  "Kirk",
  "Lee",
  "Milton",
  "Nate",
  "Oscar",
  "Patty",
  "Quentin",
  "Rafael",
  "Sara",
  "Tony",
  "Ulrik",
  "Valerie",
  "Whitney",
  "Xander",
  "Yara",
  "Zara",
  // Pass 2
  "Adelaide",
  "Bertha",
  "Carmen",
  "Dorian",
  "Edna",
  "Francine",
  "Greta",
  "Helene",
  "Ines",
  "Joyce",
  "Karen",
  "Lorenzo",
  "Mindy",
  "Nadine",
  "Odette",
  "Paulette",
  "Quinn",
  "Rebekah",
  "Sean",
  "Tammy",
  "Ursula",
  "Vinson",
  "Wallace",
  "Xanthe",
  "Yusuf",
  "Zoe",
  // Pass 3
  "Alex",
  "Beatrice",
  "Cyrus",
  "Delia",
  "Ernesto",
  "Florence",
  "Gordon",
  "Hester",
  "Isaias",
  "Jenna",
  "Klaus",
  "Larry",
  "Maxine",
  "Nicholas",
  "Otto",
  "Peter",
  "Quill",
  "Renee",
  "Stella",
  "Theresa",
  "Umberto",
  "Virgil",
  "Willow",
  "Xavier",
  "Yolanda",
  "Zane",
  // Pass 4
  "Anita",
  "Bruno",
  "Cora",
  "Damon",
  "Edith",
  "Felix",
  "Gloria",
  "Holly",
  "Iris",
  "Jasper",
  "Kaia",
  "Linda",
  "Marco",
  "Nora",
  "Olive",
  "Petra",
  "Querida",
  "Roman",
  "Sebastian",
  "Tobias",
  "Una",
  "Vera",
  "Walter",
  "Xena",
  "Yusra",
  "Zelda",
  // Pass 5
  "Aaron",
  "Bonnie",
  "Caleb",
  "Daphne",
  "Elias",
  "Fiona",
  "Galileo",
  "Hugo",
  "Ian",
  "Jude",
  "Knox",
  "Leo",
  "Maya",
  "Nash",
  "Owen",
  "Paxton",
  "Quetzal",
  "Rosa",
  "Sage",
  "Talia",
  "Uri",
  "Vincent",
  "Wesley",
  "Ximena",
  "Yvette",
  "Zephyr",
  // Pass 6
  "Astrid",
  "Beau",
  "Celeste",
  "Dexter",
  "Ezra",
  "Fitz",
  "Genevieve",
  "Hadley",
  "Imogen",
  "Joaquin",
  "Kira",
  "Lila",
  "Mason",
  "Nila",
  "Olga",
  "Pearl",
  "Quincy",
  "Royce",
  "Sterling",
  "Trent",
  "Ulysses",
  "Violet",
  "Wynne",
  "Xerxes",
  "Yael",
  "Zinnia",
  // Pass 7
  "Amelia",
  "Bianca",
  "Cody",
  "Dahlia",
  "Esme",
  "Fern",
  "Greer",
  "Harriet",
  "Ivan",
  "Juno",
  "Kendrick",
  "Luther",
  "Margot",
  "Nigel",
  "Orion",
  "Phillip",
  "Quenby",
  "Reagan",
  "Sienna",
  "Tessa",
  "Uma",
  "Vesper",
  "Watson",
  "Xiomara",
  "Yuri",
  "Zoltan",
  // Pass 8
  "Andre",
  "Boris",
  "Cassidy",
  "Davis",
  "Evander",
  "Forrest",
  "Gibson",
  "Henry",
  "Irene",
  "Justus",
  "Kasper",
  "Lainey",
  "Miles",
  "Naomi",
  "Ophelia",
  "Phoebe",
  "Quark",
  "Rylie",
  "Saul",
  "Truman",
  "Ulrich",
  "Voss",
  "Winifred",
  "Xuxa",
  "Yvonne",
  "Zia",
  // Pass 9
  "Aria",
  "Brenda",
  "Crispin",
  "Dolores",
  "Estelle",
  "Felicity",
  "Goldie",
  "Hazel",
  "Ira",
  "Jovi",
  "Kestrel",
  "Lyric",
  "Mavis",
  "Nico",
  "Otis",
  "Percy",
  "Querubin",
  "Rhett",
  "Scout",
  "Tatum",
  "Unity",
  "Vivian",
  "Wyatt",
  "Xan",
  "Yancy",
  "Zev",
  // Pass 10
  "Atticus",
  "Barnaby",
  "Calliope",
  "Drake",
  "Eustace",
  "Foster",
  "Granger",
  "Hollis",
  "Indira",
  "Jericho",
  "Kaleb",
  "Logan",
  "Magnus",
  "Noor",
  "Oakley",
  "Posy",
  "Quito",
  "Rosalind",
  "Sloane",
  "Theron",
  "Upton",
  "Vance",
  "Wendell",
  "Xola",
  "Yann",
  "Zora",
] as const;

if (COORD_NAMES.length !== 260) {
  throw new Error(`COORD_NAMES table corrupt: expected 260 entries, got ${COORD_NAMES.length}`);
}

export type NameKind = "session" | "subagent" | "transient";

interface NameHistoryRow {
  instance_id: string;
  name: string;
  kind: NameKind;
  ts: string;
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
): { name: string; kind: NameKind } | null {
  const history = readHistory(coordRoot);

  for (const row of history) {
    if (row.instance_id === instanceId) {
      return { name: row.name, kind: row.kind };
    }
  }

  if (sessionId && sessionId !== instanceId) {
    for (const row of history) {
      if (row.instance_id === sessionId) {
        return { name: row.name, kind: "transient" };
      }
    }
  }

  return null;
}

/**
 * Assign a name to <instanceId> with the given <kind>. Counter-consuming when
 * the owner is new. Idempotent: returns existing name on resume.
 */
export function assignName(coordRoot: string, instanceId: string, kind: NameKind): string {
  // Check 1: existing history row → original name.
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
  appendHistory(coordRoot, {
    instance_id: instanceId,
    name,
    kind,
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  return name;
}
