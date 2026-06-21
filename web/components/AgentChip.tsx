"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import type { AgentSummary } from "@/lib/agent-summary";
import { harnessLabel } from "@/lib/harness";
import {
  Activity,
  Check,
  Copy,
  Cpu,
  ExternalLink,
  FileWarning,
  HeartCrack,
  History,
  Skull,
  Wrench,
} from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { createPortal } from "react-dom";

/**
 * Per-page name → AgentSummary map. Server components compute the map via
 * `buildAgentSummaryMap()` and wrap the tree in `<AgentChipProvider>`.
 * Chips inside read by name.
 */
const AgentSummaryContext = createContext<Record<string, AgentSummary>>({});

export function AgentChipProvider({
  summaries,
  children,
}: {
  summaries: Record<string, AgentSummary>;
  children: React.ReactNode;
}) {
  return <AgentSummaryContext.Provider value={summaries}>{children}</AgentSummaryContext.Provider>;
}

function useAgentSummary(name: string): AgentSummary | null {
  const map = useContext(AgentSummaryContext);
  const bare = (name.startsWith("agent-") ? name.slice("agent-".length) : name).toLowerCase();
  return map[bare] ?? null;
}

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 220;

/**
 * Hover-triggered hover-card with agent-id, mint date, last activity, task,
 * aliases, and action buttons. 150ms open delay + 220ms close delay so the
 * card doesn't flash on accidental hover and the operator can navigate from
 * the trigger to the card body without it disappearing under the cursor.
 *
 * Falls back to plain monospace text when the surrounding tree has no
 * provider, so the chip stays a drop-in `{name}` replacement.
 */
export function AgentChip({
  name,
  className,
  prefix = "agent-",
}: {
  name: string;
  prefix?: string;
  className?: string;
}) {
  const router = useRouter();
  const summary = useAgentSummary(name);
  const bare = name.startsWith("agent-") ? name.slice("agent-".length) : name;
  const display = `${prefix}${bare}`;
  const labelCls = className ?? "font-mono";

  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The hover card renders in a portal at the document body with fixed
  // positioning so it escapes any `overflow: hidden/auto` ancestor (thumbnail
  // cards, scroll containers, the lightbox) that would otherwise clip it.
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: "top" | "bottom" } | null>(
    null,
  );

  // Kill-dialog state lives at the AgentChip level, NOT inside the hover
  // popup body, so the modal survives the hover popup auto-closing on
  // pointer-leave. Hosting it here keeps the Dialog mounted independently of
  // the AgentActions panel.
  const [killOpen, setKillOpen] = useState(false);
  const [killPending, startKillTransition] = useTransition();
  const [killError, setKillError] = useState<string | null>(null);

  const cancelTimers = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const onEnter = useCallback(() => {
    cancelTimers();
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  }, [cancelTimers]);

  const onLeave = useCallback(() => {
    cancelTimers();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelTimers]);

  // Cancel pending timers on unmount.
  useEffect(() => cancelTimers, [cancelTimers]);

  // Close on Escape when focused.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Compute the portal position from the trigger's viewport rect when opening.
  // Clamp horizontally to the viewport and flip above the trigger when there's
  // more room up than down. A scroll/resize while open closes the card rather
  // than tracking a now-stale rect (matches typical hover-card behavior).
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const GAP = 6;
    const CARD_W = 416; // matches max-w-104 on the card body
    const CARD_EST_H = 360;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.left;
    if (left + CARD_W > vw - 8) left = Math.max(8, vw - CARD_W - 8);
    const below = vh - r.bottom;
    const placement: "top" | "bottom" = below < CARD_EST_H && r.top > below ? "top" : "bottom";
    const top = placement === "bottom" ? r.bottom + GAP : r.top - GAP;
    setPos({ top, left, placement });
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  if (!summary || summary.state === "unknown") {
    return <span className={labelCls}>{display}</span>;
  }

  const confirmKill = () => {
    const instanceId = summary.instance_id;
    if (!instanceId) return;
    setKillError(null);
    startKillTransition(async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(instanceId)}/heal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "kill" }),
        });
        const data = (await res.json()) as { ok: true; action: string } | { error: string };
        if (!res.ok || !("ok" in data)) {
          setKillError("error" in data ? data.error : `HTTP ${res.status}`);
          return;
        }
        setKillOpen(false);
        router.refresh();
      } catch (err) {
        setKillError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <>
      <span
        ref={triggerRef}
        className="relative inline-flex"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
      >
        <span
          tabIndex={0}
          className={`${labelCls} cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-sm`}
        >
          {display}
        </span>
        {summary.kind === "subagent" && summary.parent && (
          <span
            className="ml-1 font-mono text-[10px] text-muted-foreground/70 whitespace-nowrap"
            title={`subagent of agent-${summary.parent}`}
          >
            ↳{summary.parent}
          </span>
        )}
      </span>
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              transform: pos.placement === "top" ? "translateY(-100%)" : undefined,
            }}
            className="z-60 max-w-104 rounded-md border border-border bg-popover text-popover-foreground shadow-xl"
            onMouseEnter={cancelTimers}
            onMouseLeave={onLeave}
          >
            <AgentCardBody
              summary={summary}
              onRequestKill={() => {
                setKillError(null);
                setKillOpen(true);
              }}
            />
          </div>,
          document.body,
        )}
      <Dialog
        open={killOpen}
        onOpenChange={(next) => {
          if (!killPending) setKillOpen(next);
        }}
      >
        <DialogHeader>
          <DialogTitle>Kill this agent&apos;s heartbeat?</DialogTitle>
          <DialogDescription>
            <span className="block mb-2">
              Target:{" "}
              <span className="font-mono font-semibold text-foreground">agent-{summary.name}</span>
            </span>
            <span className="block">
              Deletes the heartbeat file. The agent disappears from the active list and the coord
              layer treats it as dead. The agent&apos;s process is not signalled; it&apos;ll
              re-register on its next hook call. Use when an agent stopped cleanly but didn&apos;t
              clear its file, OR when you want to revoke all of its claims at once.
            </span>
          </DialogDescription>
        </DialogHeader>
        {killError && <p className="mt-3 text-xs text-red-400 font-mono">✗ {killError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setKillOpen(false)} disabled={killPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirmKill} disabled={killPending}>
            {killPending ? "Killing…" : "Kill heartbeat"}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

function AgentCardBody({
  summary,
  onRequestKill,
}: {
  summary: AgentSummary;
  onRequestKill: () => void;
}) {
  const isActive = summary.state === "active";
  return (
    <div className="text-xs space-y-2 leading-relaxed min-w-80 max-w-104 px-3 py-3 font-sans">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1">
          <span className="font-mono font-semibold text-sm">agent-{summary.name}</span>
          <CopyMicroButton value={`agent-${summary.name}`} label="Copy agent name" />
        </span>
        <span
          className={
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] border " +
            (isActive
              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
              : "bg-muted/60 text-muted-foreground border-border")
          }
        >
          <span
            className={
              "size-1.5 rounded-full " + (isActive ? "bg-emerald-400" : "bg-muted-foreground/50")
            }
          />
          {summary.state}
        </span>
      </div>

      {summary.kind === "subagent" && (
        <div className="flex items-center gap-1.5 border-t border-border/60 pt-2 text-[11px]">
          <Cpu className="size-3 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">
            {summary.agent_type ? `${summary.agent_type} ` : ""}subagent
            {summary.parent ? (
              <>
                {" · of "}
                <span className="font-mono text-foreground">agent-{summary.parent}</span>
              </>
            ) : (
              " · parent exited"
            )}
          </span>
        </div>
      )}

      <div className="space-y-1 border-t border-border/60 pt-2">
        {summary.agent_id && <IdRow label="AGENT_ID" value={summary.agent_id} />}
        {isActive && summary.session_id && <IdRow label="session" value={summary.session_id} />}
        {isActive && summary.instance_id && summary.instance_id !== summary.session_id && (
          <IdRow label="instance" value={summary.instance_id} />
        )}
      </div>

      {summary.kind !== "subagent" && (summary.kind || summary.platform || summary.model) && (
        <div className="flex items-center gap-1.5 text-muted-foreground border-t border-border/60 pt-2">
          <Cpu className="size-3 shrink-0" />
          <span className="flex gap-2 flex-wrap text-[11px]">
            {summary.kind && <span>{summary.kind}</span>}
            {summary.platform && (
              <span className="text-foreground/90 font-medium">
                {harnessLabel(summary.platform)}
              </span>
            )}
            {summary.model && <span className="font-mono">{summary.model}</span>}
          </span>
        </div>
      )}

      <div className="space-y-1 text-muted-foreground border-t border-border/60 pt-2">
        {summary.last_seen && (
          <div className="flex items-center gap-1.5">
            <Activity className="size-3 shrink-0" />
            <span>last seen {relativeAgo(summary.last_seen)}</span>
          </div>
        )}
        {summary.started_at && (
          <div className="flex items-center gap-1.5">
            <History className="size-3 shrink-0" />
            <span>session started {relativeAgo(summary.started_at)}</span>
          </div>
        )}
        {summary.created_at && (
          <div className="flex items-center gap-1.5">
            <History className="size-3 shrink-0" />
            <span>persona minted {relativeAgo(summary.created_at)}</span>
          </div>
        )}
      </div>

      {isActive && summary.task && (
        <div className="border-t border-border/60 pt-2">
          <div className="flex items-start gap-1.5">
            <Activity className="size-3 shrink-0 mt-0.5 text-emerald-400" />
            <span className="wrap-break-word">{summary.task}</span>
          </div>
        </div>
      )}

      {isActive && (summary.last_tool || (summary.files_touched?.length ?? 0) > 0) && (
        <div className="border-t border-border/60 pt-2 space-y-1 text-muted-foreground">
          {summary.last_tool && (
            <div className="flex items-center gap-1.5">
              <Wrench className="size-3 shrink-0" />
              <span>
                last tool: <span className="font-mono">{summary.last_tool}</span>
                {summary.last_tool_target ? (
                  <span className="text-muted-foreground/70">
                    {" "}
                    ({truncate(summary.last_tool_target, 60)})
                  </span>
                ) : null}
              </span>
            </div>
          )}
          {summary.files_touched && summary.files_touched.length > 0 && (
            <div className="flex items-start gap-1.5">
              <FileWarning className="size-3 shrink-0 mt-0.5 text-amber-400" />
              <span>
                {summary.files_touched.length} file
                {summary.files_touched.length === 1 ? "" : "s"} held:{" "}
                <span className="font-mono text-[10px] break-all">
                  {summary.files_touched.slice(0, 3).join(", ")}
                  {summary.files_touched.length > 3
                    ? ` +${summary.files_touched.length - 3} more`
                    : ""}
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      {summary.aliases.length > 0 && (
        <div className="border-t border-border/60 pt-2 text-muted-foreground">
          <div className="text-[10px] uppercase tracking-wide mb-0.5">Aliases</div>
          <ul className="space-y-0.5">
            {summary.aliases.map((a, i) => (
              <li key={i} className="font-mono text-[11px]">
                agent-{a.name}{" "}
                <span className="text-muted-foreground/70">
                  (retired {relativeAgo(a.retired_at)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-border/60 pt-2">
        <AgentActions summary={summary} onRequestKill={onRequestKill} />
      </div>
    </div>
  );
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 shrink-0">
        {label}
      </span>
      <span className="font-mono text-[10px] break-all flex-1">{value}</span>
      <CopyMicroButton value={value} label={`Copy ${label}`} />
    </div>
  );
}

function CopyMicroButton({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* silent */
        }
      }}
      aria-label={label}
      className="inline-flex items-center justify-center size-4 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
    >
      {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
    </button>
  );
}

function AgentActions({
  summary,
  onRequestKill,
}: {
  summary: AgentSummary;
  onRequestKill: () => void;
}) {
  const router = useRouter();
  const isActive = summary.state === "active";
  const hasOwner = !!summary.instance_id;
  // Mutations (heal / pidmap / kill) need a live instance; a stale/ended card
  // carries an instance_id only so its page is reachable, not so its (gone)
  // heartbeat can be acted on. Gate the live-only actions on liveness, matching
  // the standalone page which hides heal/nudge/kill entirely for ended agents.
  const canMutate = hasOwner && isActive;
  // The /agents/[id] page resolves by instance_id: live heartbeats via
  // readAgent, and ended sessions via readEndedAgent (read-only reconstruction
  // from the durable log). So link by instance_id for ANY card that carries one
  // (live, observed, AND ended); the page renders a read-only view rather than
  // 404ing when the heartbeat is gone.
  const agentPagePath = summary.instance_id
    ? `/agents/${encodeURIComponent(summary.instance_id)}`
    : "";
  const [busy, setBusy] = React.useState<"heal" | "pidmap" | null>(null);
  const [feedback, setFeedback] = React.useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const btnCls =
    "inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-foreground hover:bg-muted/60 disabled:opacity-40 disabled:cursor-not-allowed";
  const destructiveBtnCls =
    "inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-destructive hover:bg-destructive/15 disabled:opacity-40 disabled:cursor-not-allowed";

  async function fireHeal(kind: "heartbeat" | "pidmap") {
    if (!summary.instance_id) return;
    setBusy(kind === "heartbeat" ? "heal" : kind);
    setFeedback(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(summary.instance_id)}/heal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = (await res.json()) as { ok: true; action: string } | { error: string };
      if (!res.ok || !("ok" in data)) {
        setFeedback({
          ok: false,
          msg: "error" in data ? data.error : `HTTP ${res.status}`,
        });
        return;
      }
      setFeedback({ ok: true, msg: data.action });
      router.refresh();
    } catch (err) {
      setFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1 flex-wrap">
        {agentPagePath && (
          <Tooltip content="View the agent's page in a new window.">
            <a
              href={agentPagePath}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] border border-border bg-background hover:bg-muted/60 text-foreground"
            >
              <ExternalLink className="size-3" />
              Open
            </a>
          </Tooltip>
        )}
        <Tooltip
          content={
            canMutate
              ? "Recreate the heartbeat file if it's missing (corrective; use only when the agent is actually alive)."
              : "The agent's session has ended. Heal requires a live session."
          }
        >
          <button
            type="button"
            disabled={!canMutate || busy !== null}
            onClick={() => fireHeal("heartbeat")}
            className={btnCls}
          >
            <HeartCrack className="size-3" />
            {busy === "heal" ? "Healing…" : "Heal"}
          </button>
        </Tooltip>
        <Tooltip
          content={
            canMutate
              ? "Rebuild .pidmap from active heartbeats. Safe to run any time; does not affect heartbeats or claims."
              : "The agent's session has ended. Pidmap heal requires a live session."
          }
        >
          <button
            type="button"
            disabled={!canMutate || busy !== null}
            onClick={() => fireHeal("pidmap")}
            className={btnCls}
          >
            <Wrench className="size-3" />
            {busy === "pidmap" ? "Healing…" : "Pidmap"}
          </button>
        </Tooltip>
        <Tooltip
          content={
            canMutate
              ? "Delete this agent's heartbeat file; disappears from the active list."
              : "Only available for active sessions with a live instance."
          }
        >
          <button
            type="button"
            disabled={!canMutate || busy !== null}
            onClick={onRequestKill}
            className={destructiveBtnCls}
          >
            <Skull className="size-3" />
            Kill
          </button>
        </Tooltip>
      </div>
      {feedback && (
        <p
          className={"text-[10px] font-mono " + (feedback.ok ? "text-emerald-400" : "text-red-400")}
        >
          {feedback.ok ? `✓ ${feedback.msg}` : `✗ ${feedback.msg}`}
        </p>
      )}
    </div>
  );
}

export function AgentChipList({
  names,
  className,
  separator = ", ",
}: {
  names: string[];
  className?: string;
  separator?: string;
}) {
  const items = names.filter((n) => n && n.trim());
  return (
    <span className={className}>
      {items.map((n, i) => (
        <span key={`${n}-${i}`}>
          <AgentChip name={n} />
          {i < items.length - 1 ? separator : null}
        </span>
      ))}
    </span>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function relativeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
