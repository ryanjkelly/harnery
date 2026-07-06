"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";

export type AgentRegistryRow = {
  /** Bare name without the `agent-` prefix. */
  name: string;
  instance_id: string;
  active: boolean;
  age_seconds: number;
  platform?: string | null;
  task?: string | null;
};

/**
 * Council-create form. The picker is checkboxes for membership + a single
 * radio for steward. The convener (created_by) defaults to the steward; we
 * don't surface it separately to keep the form focused.
 *
 * Submits to POST /api/councils which shells to `harn agents council create`.
 * Success routes the operator to the council detail page.
 */
export function NewCouncilForm({
  initialObjective,
  agents,
}: {
  initialObjective: string;
  agents: AgentRegistryRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [objective, setObjective] = useState(initialObjective);
  const [targetDoc, setTargetDoc] = useState("");
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [steward, setSteward] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const memberNames = useMemo(
    () => Array.from(selected).map((bare) => `agent-${bare}`),
    [selected],
  );

  function toggleMember(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
        if (steward === name) setSteward(null);
      } else {
        next.add(name);
        if (!steward) setSteward(name);
      }
      return next;
    });
  }

  const canSubmit =
    !pending && objective.trim().length > 0 && selected.size > 0 && steward !== null;

  const objectiveCharCount = objective.length;
  const objectiveTooShort = objective.trim().length < 8;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/councils", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            objective: objective.trim(),
            members: memberNames,
            steward: `agent-${steward}`,
            target_doc: targetDoc.trim() || null,
            auto_advance: autoAdvance,
          }),
        });
        const data = (await res.json()) as
          | { ok: true; council_id: string }
          | { error: string; stderr?: string };
        if (!res.ok || !("ok" in data)) {
          const msg =
            "error" in data
              ? `${data.error}${data.stderr ? `: ${data.stderr}` : ""}`
              : `HTTP ${res.status}`;
          setError(msg);
          return;
        }
        // Guard: if the API ever omits council_id, land on the list page
        // rather than a broken /councils/undefined URL.
        router.push(
          data.council_id
            ? `/councils/${encodeURIComponent(data.council_id)}`
            : "/councils",
        );
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Objective</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            spellCheck={false}
            className="w-full min-h-[100px] max-h-[260px] text-sm font-mono p-2 rounded border border-border bg-background/40 focus:outline-none focus:ring-2 focus:ring-primary/40 resize-y"
            placeholder="One paragraph: what is this council deciding?"
          />
          <p className="text-[11px] text-muted-foreground">
            {objectiveCharCount} chars
            {objectiveTooShort && objectiveCharCount > 0 && (
              <span className="ml-2 text-amber-400">
                (very short; councils benefit from a clear objective)
              </span>
            )}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Members{" "}
            <span className="text-xs font-normal text-muted-foreground ml-1 normal-case">
              ({selected.size} selected)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Pick which agents will contribute, then choose one steward. Stale
            agents (last heartbeat &gt; 5 min) are selectable; they&apos;ll see
            the invitation on their next SessionStart.
          </p>
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No agents registered. Start at least one agent session so a
              heartbeat appears in{" "}
              <code className="font-mono text-[11px]">.harnery/active/</code>.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded border border-border overflow-hidden">
              {agents.map((a) => {
                const isMember = selected.has(a.name);
                const isSteward = steward === a.name;
                return (
                  <li
                    key={a.instance_id}
                    className={
                      isMember
                        ? "bg-muted/30"
                        : "hover:bg-muted/20 transition-colors"
                    }
                  >
                    <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer min-h-11 sm:min-h-0">
                      <input
                        type="checkbox"
                        checked={isMember}
                        onChange={() => toggleMember(a.name)}
                        className="size-4 shrink-0 cursor-pointer"
                      />
                      <span className="flex-1 flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm">
                          agent-{a.name}
                        </span>
                        <Badge variant={a.active ? "default" : "outline"}>
                          {a.active ? "active" : "stale"}
                        </Badge>
                        {a.platform && (
                          <span className="text-[10px] text-muted-foreground">
                            {a.platform}
                          </span>
                        )}
                        {a.task && (
                          <Tooltip content={a.task}>
                            <span className="text-[10px] text-muted-foreground truncate max-w-[40ch] cursor-help">
                              · {a.task}
                            </span>
                          </Tooltip>
                        )}
                      </span>
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {fmtAge(a.age_seconds)}
                      </span>
                    </label>
                    {isMember && (
                      <label className="flex items-center gap-2 pl-10 pr-3 pb-2 cursor-pointer text-xs text-muted-foreground">
                        <input
                          type="radio"
                          name="steward"
                          checked={isSteward}
                          onChange={() => setSteward(a.name)}
                          className="size-3 shrink-0 cursor-pointer"
                        />
                        steward (drafts per-round routing prompts)
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="target_doc" className="text-xs font-medium">
              Target doc (optional)
            </label>
            <input
              id="target_doc"
              type="text"
              value={targetDoc}
              onChange={(e) => setTargetDoc(e.target.value)}
              placeholder="docs/proposal.md"
              className="w-full text-xs font-mono p-2 rounded border border-border bg-background/40 focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <p className="text-[11px] text-muted-foreground">
              Monorepo-relative path. Members see it in the invitation.
            </p>
          </div>

          <label className="flex items-center gap-2 cursor-pointer text-xs">
            <input
              type="checkbox"
              checked={autoAdvance}
              onChange={(e) => setAutoAdvance(e.target.checked)}
              className="size-4 cursor-pointer"
            />
            <span>
              Auto-advance: fire{" "}
              <code className="font-mono text-[11px]">council advance</code>{" "}
              automatically once all members contribute. Default off preserves
              operator agency.
            </span>
          </label>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs">
          <AlertCircle className="size-4 shrink-0 mt-0.5 text-red-400" />
          <span className="text-red-300">{error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 [&>button]:min-h-11 sm:[&>button]:min-h-0">
        <p className="text-xs text-muted-foreground">
          {steward
            ? `Steward: agent-${steward}. Convener defaults to steward.`
            : "Select at least one member and choose a steward to enable Create."}
        </p>
        <Button type="submit" disabled={!canSubmit}>
          <ChevronRight className="size-3" />
          {pending ? "Creating…" : "Create council"}
        </Button>
      </div>
    </form>
  );
}

function fmtAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
