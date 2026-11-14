/**
 * Browser guard for `harn computer` (ADR 0250): remembers which browser
 * windows each agent opened for itself and what the last snapshot of each
 * tab showed, and decides whether one browser call may be sent.
 *
 * Every computer call is its own short-lived process, so the guard keeps no
 * state in memory: each operation re-reads `<dir>/browser.json`, and each
 * change writes it back atomically (temporary file in the same directory,
 * then rename). A missing or malformed file reads as empty state. Entries
 * older than 24 hours are dropped on every read and write.
 *
 * Internal module: not exported from package.json.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserCall, BrowserObservation, WindowRef } from "./types.ts";

/** Who is calling: the desktop-lease owner. */
export interface GuardOwner {
  id: string;
  label: string;
}

export type GuardDecision =
  | { ok: true }
  | { ok: false; code: string; message: string; hint: string };

export interface GuardWindow extends WindowRef {
  owner_id: string;
  owner_label: string;
  session: string;
  opened_at: string;
}

export interface BrowserGuard {
  /** Record a window the owner opened for itself. */
  recordWindow(owner: GuardOwner, window: WindowRef & { session: string }): void;
  /** Decide one call before it is sent. `personWindow` is the caller's explicit override. */
  check(owner: GuardOwner, call: BrowserCall, options?: { personWindow?: boolean }): GuardDecision;
  /** Fold one call's result into the store after it returned. */
  observe(
    owner: GuardOwner,
    call: BrowserCall,
    observation: BrowserObservation,
    options?: { personWindow?: boolean },
  ): void;
  /** The owner's browser work: driver sessions to end and windows to close. */
  work(owner: GuardOwner): { sessions: string[]; windows: WindowRef[] };
  /** Forget the owner's browser work, after it was ended and closed. */
  clear(owner: GuardOwner): void;
  /** Every recorded window, for status. */
  list(): GuardWindow[];
}

const STORE_FILE = "browser.json";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface TabState {
  sensitive_refs: string[];
  password_offer: boolean;
  typed: boolean;
}

interface GuardTarget {
  owner_id: string;
  target_id: string;
  pid?: number;
  window_id?: number;
  session: string;
  person_window: boolean;
  at: string;
  tabs: Record<string, TabState>;
}

interface AttachedPid {
  pid: number;
  at: string;
}

interface GuardStore {
  windows: GuardWindow[];
  attached_pids: AttachedPid[];
  targets: GuardTarget[];
}

const OK: GuardDecision = { ok: true };

function refuse(code: string, message: string, hint: string): GuardDecision {
  return { ok: false, code, message, hint };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseTab(value: unknown): TabState | null {
  if (!isRecord(value)) return null;
  const refs = Array.isArray(value.sensitive_refs)
    ? value.sensitive_refs.filter((ref): ref is string => typeof ref === "string")
    : [];
  return {
    sensitive_refs: refs,
    password_offer: value.password_offer === true,
    typed: value.typed === true,
  };
}

function parseStore(raw: unknown): GuardStore {
  const store: GuardStore = { windows: [], attached_pids: [], targets: [] };
  if (!isRecord(raw)) return store;
  if (Array.isArray(raw.windows)) {
    for (const w of raw.windows) {
      if (!isRecord(w) || !isFiniteNumber(w.pid) || !isFiniteNumber(w.window_id)) continue;
      if (typeof w.owner_id !== "string" || typeof w.opened_at !== "string") continue;
      store.windows.push({
        owner_id: w.owner_id,
        owner_label: typeof w.owner_label === "string" ? w.owner_label : w.owner_id,
        pid: w.pid,
        window_id: w.window_id,
        session: typeof w.session === "string" ? w.session : "",
        opened_at: w.opened_at,
      });
    }
  }
  if (Array.isArray(raw.attached_pids)) {
    for (const a of raw.attached_pids) {
      if (!isRecord(a) || !isFiniteNumber(a.pid) || typeof a.at !== "string") continue;
      store.attached_pids.push({ pid: a.pid, at: a.at });
    }
  }
  if (Array.isArray(raw.targets)) {
    for (const t of raw.targets) {
      if (!isRecord(t) || typeof t.owner_id !== "string" || typeof t.target_id !== "string") {
        continue;
      }
      if (typeof t.at !== "string") continue;
      const tabs: Record<string, TabState> = {};
      if (isRecord(t.tabs)) {
        for (const [tabId, tab] of Object.entries(t.tabs)) {
          const parsed = parseTab(tab);
          if (parsed) tabs[tabId] = parsed;
        }
      }
      store.targets.push({
        owner_id: t.owner_id,
        target_id: t.target_id,
        pid: isFiniteNumber(t.pid) ? t.pid : undefined,
        window_id: isFiniteNumber(t.window_id) ? t.window_id : undefined,
        session: typeof t.session === "string" ? t.session : "",
        person_window: t.person_window === true,
        at: t.at,
        tabs,
      });
    }
  }
  return store;
}

function fresh(at: string, nowMs: number): boolean {
  const ms = Date.parse(at);
  return Number.isFinite(ms) && nowMs - ms < MAX_AGE_MS;
}

function prune(store: GuardStore, nowMs: number): GuardStore {
  return {
    windows: store.windows.filter((w) => fresh(w.opened_at, nowMs)),
    attached_pids: store.attached_pids.filter((a) => fresh(a.at, nowMs)),
    targets: store.targets.filter((t) => fresh(t.at, nowMs)),
  };
}

const NOT_YOURS_HINT =
  "Open your own window with the computer browser open command, or pass --person-window only when the person asked you to work in that window.";

export function createBrowserGuard(options: { dir: string; now?: () => number }): BrowserGuard {
  const dir = options.dir;
  const now = options.now ?? Date.now;
  const file = join(dir, STORE_FILE);

  function load(): GuardStore {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return { windows: [], attached_pids: [], targets: [] };
    }
    return prune(parseStore(raw), now());
  }

  function save(store: GuardStore): void {
    mkdirSync(dir, { recursive: true });
    const pruned = prune(store, now());
    const tmp = join(dir, `${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(pruned, null, 2)}\n`);
    try {
      renameSync(tmp, file);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // best effort
      }
      throw error;
    }
  }

  function stamp(): string {
    return new Date(now()).toISOString();
  }

  function ownsWindow(store: GuardStore, owner: GuardOwner, pid: number, windowId: number) {
    return store.windows.some(
      (w) => w.owner_id === owner.id && w.pid === pid && w.window_id === windowId,
    );
  }

  function windowRule(
    store: GuardStore,
    owner: GuardOwner,
    call: BrowserCall,
    personWindow: boolean,
  ): GuardDecision {
    const { pid, window_id } = call;
    if (pid === undefined || window_id === undefined) return OK;
    if (personWindow || ownsWindow(store, owner, pid, window_id)) return OK;
    return refuse(
      "browser_window_not_yours",
      `The browser window ${window_id} of process ${pid} is not one you opened, so ${call.tool} was not sent.`,
      NOT_YOURS_HINT,
    );
  }

  function findTarget(store: GuardStore, owner: GuardOwner, targetId: string) {
    return store.targets.find((t) => t.owner_id === owner.id && t.target_id === targetId);
  }

  return {
    recordWindow(owner, window) {
      const store = load();
      store.windows = store.windows.filter(
        (w) => !(w.pid === window.pid && w.window_id === window.window_id),
      );
      store.windows.push({
        owner_id: owner.id,
        owner_label: owner.label,
        pid: window.pid,
        window_id: window.window_id,
        session: window.session,
        opened_at: stamp(),
      });
      save(store);
    },

    check(owner, call, opts) {
      const personWindow = opts?.personWindow === true;
      switch (call.kind) {
        case "launch":
          return OK;
        case "opaque":
          return refuse(
            "browser_script_not_checked",
            `${call.tool} runs a program that names browser tools, and the browser guard cannot check its steps one by one, so it was not sent.`,
            "Make each browser call as its own call so each one can be checked.",
          );
        case "attach":
          return windowRule(load(), owner, call, personWindow);
        case "bind": {
          if (call.pid === undefined || call.window_id === undefined) return OK;
          const store = load();
          const pid = call.pid;
          if (!store.attached_pids.some((a) => a.pid === pid)) return OK;
          return windowRule(store, owner, call, personWindow);
        }
        case "read":
        case "type":
        case "point":
        case "act": {
          if (call.target_id === undefined) return OK;
          const target = findTarget(load(), owner, call.target_id);
          if (!target) {
            return refuse(
              "browser_target_unknown",
              `The browser target ${call.target_id} is not one you bound, so ${call.tool} was not sent.`,
              "Bind the window again with get_browser_state and its pid and window_id; target ids change on every bind.",
            );
          }
          const tab = call.tab_id === undefined ? undefined : target.tabs[call.tab_id];
          if (call.kind === "type" && tab && call.ref !== undefined) {
            if (tab.sensitive_refs.includes(call.ref)) {
              return refuse(
                "browser_sensitive_field",
                `The field ${call.ref} takes a password, passcode or one-time code, so ${call.tool} was not sent. Never type a password, passcode or one-time code.`,
                "A sign-in goes through the person's password manager, or to the person.",
              );
            }
          }
          if (call.kind === "point" && tab) {
            if (tab.typed) {
              return refuse(
                "browser_read_back_required",
                `You typed in this tab since its last snapshot, so ${call.tool} was not sent.`,
                "Read the tab again with get_browser_state first, because a password manager offer or a suggestion list may now cover the control.",
              );
            }
            if (tab.password_offer) {
              return refuse(
                "browser_password_offer",
                `A password manager offer is showing in this tab, so ${call.tool} was not sent.`,
                "Do not click through a password manager offer; tell the person instead.",
              );
            }
          }
          return OK;
        }
        default:
          return OK;
      }
    },

    observe(owner, call, observation, opts) {
      const store = load();
      let changed = false;
      const at = stamp();

      if (call.kind === "attach" && call.pid !== undefined) {
        const pid = call.pid;
        store.attached_pids = store.attached_pids.filter((a) => a.pid !== pid);
        store.attached_pids.push({ pid, at });
        changed = true;
      }

      if (observation.bound) {
        const pid = observation.bound.pid ?? call.pid;
        const windowId = observation.bound.window_id ?? call.window_id;
        const targetId = observation.bound.target_id;
        store.targets = store.targets.filter(
          (t) =>
            !(
              t.owner_id === owner.id &&
              (t.target_id === targetId ||
                (pid !== undefined &&
                  windowId !== undefined &&
                  t.pid === pid &&
                  t.window_id === windowId))
            ),
        );
        store.targets.push({
          owner_id: owner.id,
          target_id: targetId,
          pid,
          window_id: windowId,
          session: call.session ?? "",
          person_window: opts?.personWindow === true,
          at,
          tabs: {},
        });
        changed = true;
      }

      if (observation.snapshot) {
        const snap = observation.snapshot;
        const target = findTarget(store, owner, snap.target_id);
        if (target) {
          target.tabs[snap.tab_id] = {
            sensitive_refs: [...snap.sensitive_refs],
            password_offer: snap.password_offer,
            typed: false,
          };
          target.at = at;
          changed = true;
        }
      }

      if (observation.delivered && call.target_id !== undefined && call.tab_id !== undefined) {
        const target = findTarget(store, owner, call.target_id);
        if (target) {
          if (call.navigates) {
            delete target.tabs[call.tab_id];
            target.at = at;
            changed = true;
          } else if (call.kind === "type") {
            const tab = target.tabs[call.tab_id] ?? {
              sensitive_refs: [],
              password_offer: false,
              typed: false,
            };
            tab.typed = true;
            target.tabs[call.tab_id] = tab;
            target.at = at;
            changed = true;
          }
        }
      }

      if (changed) save(store);
    },

    work(owner) {
      const store = load();
      const sessions = new Set<string>();
      for (const w of store.windows) {
        if (w.owner_id === owner.id && w.session) sessions.add(w.session);
      }
      for (const t of store.targets) {
        if (t.owner_id === owner.id && t.session) sessions.add(t.session);
      }
      const windows = store.windows
        .filter((w) => w.owner_id === owner.id)
        .map((w) => ({ pid: w.pid, window_id: w.window_id }));
      return { sessions: [...sessions], windows };
    },

    clear(owner) {
      const store = load();
      store.windows = store.windows.filter((w) => w.owner_id !== owner.id);
      store.targets = store.targets.filter((t) => t.owner_id !== owner.id);
      save(store);
    },

    list() {
      return load().windows;
    },
  };
}
