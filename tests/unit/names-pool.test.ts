/**
 * Name-pool + assignment tests for src/core/agents/state/names.ts:
 * COORD_NAMES layout invariants, plus assign / loopback / idempotency /
 * resolve behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assignName,
  COORD_NAMES,
  readForkParent,
  recordNameAssumption,
  resolveForkAncestry,
  resolveName,
} from "../../src/core/agents/state/names.ts";

describe("COORD_NAMES layout invariants", () => {
  test("exactly 260 entries", () => {
    expect(COORD_NAMES.length).toBe(260);
  });

  test("all unique", () => {
    expect(new Set(COORD_NAMES).size).toBe(260);
  });

  test("all ASCII (no diacritics / non-printable bytes)", () => {
    for (const name of COORD_NAMES) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting absence of control + non-ASCII bytes is the point
      expect(name).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  test("all single-token title-case (first upper, rest lower letters)", () => {
    for (const name of COORD_NAMES) {
      expect(name).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  test("exactly 10 names per starting letter A..Z", () => {
    const byLetter = new Map<string, number>();
    for (const name of COORD_NAMES) {
      const c = name[0]!;
      byLetter.set(c, (byLetter.get(c) ?? 0) + 1);
    }
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      expect(byLetter.get(letter)).toBe(10);
    }
  });

  test("COORD_NAMES[i] starts with letter (i % 26)", () => {
    for (let i = 0; i < COORD_NAMES.length; i++) {
      const expectedLetter = String.fromCharCode(65 + (i % 26));
      expect(COORD_NAMES[i]![0]).toBe(expectedLetter);
    }
  });
});

/**
 * The 130 names labeled female. Pinned here so a reorder or substitution that
 * breaks the alternating-gender layout fails loudly instead of silently
 * unbalancing the pool. Labels are presentation-only; nothing reads them at
 * runtime.
 */
const FEMALE_NAMES = new Set<string>([
  "Adelaide", "Amelia", "Anita", "Anna", "Astrid", "Beatrice", "Bertha", "Bianca", "Bonnie",
  "Brenda", "Calliope", "Carmen", "Cassidy", "Celeste", "Cora", "Dahlia", "Dalia", "Daphne",
  "Delia", "Dolores", "Edith", "Edna", "Erika", "Esme", "Estelle", "Felicity", "Fern", "Fiona",
  "Florence", "Francine", "Gemma", "Genevieve", "Gloria", "Greer", "Greta", "Harriet", "Hazel",
  "Helene", "Hester", "Holly", "Imelda", "Imogen", "Ines", "Irene", "Iris", "Jenna", "Josephine",
  "Jovi", "Joyce", "Juno", "Kaia", "Karen", "Kestrel", "Kira", "Klara", "Lainey", "Lila",
  "Linda", "Lucia", "Lyric", "Margot", "Mavis", "Maxine", "Maya", "Mindy", "Nadine", "Naomi",
  "Nila", "Noor", "Nora", "Oakley", "Odette", "Olga", "Olive", "Ophelia", "Patty", "Paulette",
  "Pearl", "Petra", "Phoebe", "Quenby", "Querida", "Quetzal", "Quinn", "Quito", "Rebekah",
  "Renee", "Rosa", "Rosalind", "Rylie", "Sage", "Sara", "Scout", "Sienna", "Stella", "Talia",
  "Tammy", "Tatum", "Tessa", "Theresa", "Uma", "Una", "Undine", "Unity", "Ursula", "Valerie",
  "Vera", "Vesper", "Violet", "Vivian", "Whitney", "Willow", "Winifred", "Wren", "Wynne",
  "Xanthe", "Xena", "Ximena", "Xiomara", "Xuxa", "Yael", "Yara", "Yolanda", "Yvette", "Yvonne",
  "Zara", "Zelda", "Zinnia", "Zoe", "Zora"
]);

describe("COORD_NAMES gender layout", () => {
  const genderAt = (i: number) => (FEMALE_NAMES.has(COORD_NAMES[i]!) ? "female" : "male");

  test("every name carries a gender label", () => {
    const male = COORD_NAMES.filter((n) => !FEMALE_NAMES.has(n));
    expect(FEMALE_NAMES.size).toBe(130);
    expect(male.length).toBe(130);
  });

  test("gender alternates letter by letter within every pass", () => {
    for (let i = 0; i < COORD_NAMES.length; i++) {
      if (i % 26 === 25) continue; // pass boundary: parity flips, so skip the seam
      expect(genderAt(i)).not.toBe(genderAt(i + 1));
    }
  });

  test("every pass is 13 female and 13 male", () => {
    for (let p = 0; p < 10; p++) {
      let female = 0;
      for (let i = p * 26; i < (p + 1) * 26; i++) if (genderAt(i) === "female") female++;
      expect(female).toBe(13);
    }
  });

  test("passes 1,3,5,7,9 start female at A and 2,4,6,8,10 start male", () => {
    for (let p = 0; p < 10; p++) {
      expect(genderAt(p * 26)).toBe(p % 2 === 0 ? "female" : "male");
    }
  });

  test("each letter has exactly 5 female and 5 male names", () => {
    for (let l = 0; l < 26; l++) {
      const letter = String.fromCharCode(65 + l);
      const names = COORD_NAMES.filter((n) => n[0] === letter);
      expect(names.filter((n) => FEMALE_NAMES.has(n)).length).toBe(5);
    }
  });

  test("gender is derivable from index alone", () => {
    for (let i = 0; i < COORD_NAMES.length; i++) {
      const expected = (i % 26) % 2 === Math.floor(i / 26) % 2 ? "female" : "male";
      expect(genderAt(i)).toBe(expected);
    }
  });
});

describe("assignName / resolveName", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-names-"));
    mkdirSync(path.join(root, ".harnery"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("advances the alphabet across new sessions (counter slots 0,1,2)", () => {
    expect(assignName(root, "sess-a", "session")).toBe(COORD_NAMES[0]); // Anna
    expect(assignName(root, "sess-b", "session")).toBe(COORD_NAMES[1]); // Bob
    expect(assignName(root, "sess-c", "session")).toBe(COORD_NAMES[2]); // Carlos
    // counter advanced exactly 3 slots
    expect(readFileSync(path.join(root, ".harnery", ".name-counter"), "utf8").trim()).toBe("3");
  });

  test("counter loops back at index 260 (260 % 260 = 0 → Anna)", () => {
    writeFileSync(path.join(root, ".harnery", ".name-counter"), "259");
    expect(assignName(root, "sess-259", "session")).toBe(COORD_NAMES[259]); // Zora
    // counter now 260; next assign wraps to index 0
    expect(assignName(root, "sess-260", "session")).toBe(COORD_NAMES[0]); // Anna
  });

  test("resume idempotency: same instance reuses its name, no counter burn", () => {
    const first = assignName(root, "sess-x", "session");
    const counterAfterFirst = readFileSync(
      path.join(root, ".harnery", ".name-counter"),
      "utf8",
    ).trim();
    const second = assignName(root, "sess-x", "session");
    expect(second).toBe(first);
    // counter unchanged on the idempotent re-assign
    expect(readFileSync(path.join(root, ".harnery", ".name-counter"), "utf8").trim()).toBe(
      counterAfterFirst,
    );
  });

  test("durable name-history resolves independent of any heartbeat", () => {
    const name = assignName(root, "sess-durable", "session");
    // No heartbeat file exists; resolveName reads only .name-history.
    expect(resolveName(root, "sess-durable")?.name).toBe(name);
    expect(resolveName(root, "sess-durable")?.kind).toBe("session");
  });

  test("resolveName 3 paths: own id, session inherit→transient, unknown→null", () => {
    assignName(root, "parent-sess", "session");
    // path 1: own instance_id → original (name, kind)
    expect(resolveName(root, "parent-sess")).toEqual({
      name: COORD_NAMES[0]!,
      kind: "session",
    });
    // path 2: a subagent whose session_id is the parent → parent's name, kind transient
    expect(resolveName(root, "subagent-id", "parent-sess")).toEqual({
      name: COORD_NAMES[0]!,
      kind: "transient",
    });
    // path 3: unknown owner, no session match → null
    expect(resolveName(root, "ghost-id")).toBeNull();
  });

  test("explicit identity assumption appends history and latest binding wins", () => {
    expect(assignName(root, "sess-role", "session")).toBe("Anna");
    const first = recordNameAssumption(
      root,
      "sess-role",
      "Yann",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(first.changed).toBe(true);
    expect(first.previous?.name).toBe("Anna");
    expect(resolveName(root, "sess-role")).toEqual({
      name: "Yann",
      kind: "session",
      agent_id: "11111111-1111-4111-8111-111111111111",
    });

    const historyPath = path.join(root, ".harnery", ".name-history");
    const rowsAfterFirst = readFileSync(historyPath, "utf8").trim().split("\n");
    expect(rowsAfterFirst).toHaveLength(2);
    expect(JSON.parse(rowsAfterFirst[0]!).name).toBe("Anna");
    expect(JSON.parse(rowsAfterFirst[1]!).source).toBe("identity.assume");

    const retry = recordNameAssumption(
      root,
      "sess-role",
      "Yann",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(retry.changed).toBe(false);
    expect(readFileSync(historyPath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("transient resolution inherits the parent's assumed persona id", () => {
    assignName(root, "parent-role", "session");
    recordNameAssumption(root, "parent-role", "Beatrice", "22222222-2222-4222-8222-222222222222");
    expect(resolveName(root, "transient", "parent-role")).toEqual({
      name: "Beatrice",
      kind: "transient",
      agent_id: "22222222-2222-4222-8222-222222222222",
    });
  });
});

describe("recorded fork lineage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-forklineage-"));
    mkdirSync(path.join(root, ".harnery"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("assignName stamps forked_from on the first row only", () => {
    assignName(root, "parent-1", "session");
    assignName(root, "fork-1", "session", { forkedFrom: "parent-1" });
    // Resume: idempotent, no second row, lineage intact.
    assignName(root, "fork-1", "session", { forkedFrom: "parent-1" });

    const rows = readFileSync(path.join(root, ".harnery", ".name-history"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows.filter((r) => r.instance_id === "fork-1")).toHaveLength(1);
    expect(rows.find((r) => r.instance_id === "fork-1").forked_from).toBe("parent-1");
    expect(rows.find((r) => r.instance_id === "parent-1").forked_from).toBeUndefined();
  });

  test("self-parent is refused at stamp time", () => {
    assignName(root, "loop-1", "session", { forkedFrom: "loop-1" });
    const rows = readFileSync(path.join(root, ".harnery", ".name-history"), "utf8");
    expect(rows).not.toContain("forked_from");
  });

  test("readForkParent resolves the parent's latest name", () => {
    const parentName = assignName(root, "parent-1", "session");
    assignName(root, "fork-1", "session", { forkedFrom: "parent-1" });
    expect(readForkParent(root, "fork-1")).toEqual({
      instance_id: "parent-1",
      name: parentName,
    });
    expect(readForkParent(root, "parent-1")).toBeNull();
    // Parent later assumes a persona: lineage follows latest-row-wins.
    recordNameAssumption(root, "parent-1", "Yann", "agent-uuid-1");
    expect(readForkParent(root, "fork-1")?.name).toBe("Yann");
  });

  test("resolveForkAncestry walks the chain nearest-first with depth + cycle guards", () => {
    const gName = assignName(root, "gp-1", "session");
    const pName = assignName(root, "parent-1", "session", { forkedFrom: "gp-1" });
    assignName(root, "fork-1", "session", { forkedFrom: "parent-1" });
    expect(resolveForkAncestry(root, "fork-1")).toEqual([
      { instance_id: "parent-1", name: pName },
      { instance_id: "gp-1", name: gName },
    ]);
    // Cycle: hand-write a corrupt loop; the walk must terminate.
    writeFileSync(
      path.join(root, ".harnery", ".name-history"),
      [
        JSON.stringify({ instance_id: "a", name: "Anna", kind: "session", forked_from: "b", ts: "2026-01-01T00:00:00Z" }),
        JSON.stringify({ instance_id: "b", name: "Bob", kind: "session", forked_from: "a", ts: "2026-01-01T00:00:00Z" }),
      ].join("\n") + "\n",
    );
    expect(resolveForkAncestry(root, "a")).toEqual([{ instance_id: "b", name: "Bob" }]);
  });
});
