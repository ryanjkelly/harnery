import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentChipProvider } from "@/components/AgentChip";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkflowStatusBadge } from "@/components/WorkflowStatusBadge";
import { WorkspaceStateBadge } from "@/components/WorkspaceStateBadge";
import { AgentElapsed } from "@/components/workflow/AgentElapsed";
import { WorkflowActivityLog } from "@/components/workflow/WorkflowActivityLog";
import { buildAgentSummaryMap, buildEndedAgentSummaries } from "@/lib/agent-summary";
import { coordRoot, readEvents, readInstanceIdentities } from "@/lib/coord-reader";
import { readWorkflowChildSessions, readWorkflowRun } from "@/lib/workflow-reader";

/** Rows of child activity pre-rendered for first paint; the SSE snapshot
 * replaces them on connect. */
const INITIAL_ACTIVITY_ROWS = 400;

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ runId: string }>;
}

/**
 * /workflows/[runId]: one run as a stages → agents tree, journal-driven so it
 * stays inspectable while the run is live and after the orchestrator exits.
 */
export default async function WorkflowRunPage({ params }: PageProps) {
  const { runId } = await params;
  const run = readWorkflowRun(coordRoot(), decodeURIComponent(runId));
  if (!run) notFound();

  // Child sessions are the join key for everything live on this page: the
  // activity feed filters on them, and their heartbeats are what separate a
  // working agent from a dead orchestrator.
  const childSessions = readWorkflowChildSessions(coordRoot(), run.runId);
  const sessionIds = new Set(childSessions.map((c) => c.sessionId));
  const activityRows =
    sessionIds.size > 0
      ? readEvents({ limit: INITIAL_ACTIVITY_ROWS, sessions: sessionIds }).rows
      : [];

  // Child harness sessions are main sessions, so instance_id === session_id and
  // the durable identity log names them even after they exit.
  const identities = readInstanceIdentities();
  const instanceToName: Record<string, string> = {};
  for (const c of childSessions) {
    const identity = identities[c.sessionId];
    if (identity) instanceToName[c.sessionId] = identity.name;
  }
  const childNames = Array.from(new Set(Object.values(instanceToName))).sort();
  const summaries = {
    ...buildEndedAgentSummaries(identities),
    ...buildAgentSummaryMap(childNames, identities),
  };

  /*
   * Which agent rows have a live child behind them.
   *
   * Children now report the agent id the orchestrator stamped into their env, so
   * a live heartbeat says which row it is running and this is exact. The
   * fallback below covers a run started before that stamp existed, or a harness
   * whose session never reported: unclaimed live sessions go to journaled-running
   * rows in order. That can pick the wrong row among concurrent agents, but it
   * can never claim more live agents than there are live sessions, which is the
   * part that would mislead.
   */
  const liveAgentIds = new Set<string>();
  let unattributedLive = 0;
  for (const c of childSessions) {
    if (!c.live) continue;
    if (c.agentId) liveAgentIds.add(c.agentId);
    else unattributedLive++;
  }
  for (const a of run.agents) {
    if (unattributedLive <= 0) break;
    if (a.status !== "running" || liveAgentIds.has(a.id)) continue;
    liveAgentIds.add(a.id);
    unattributedLive--;
  }

  const byStage = new Map<string, typeof run.agents>();
  for (const a of run.agents) {
    const key = a.stage || "(no stage)";
    byStage.set(key, [...(byStage.get(key) ?? []), a]);
  }
  // Preserve declared stage order; agents with unknown stages append after.
  const orderedStages = [
    ...run.stages.filter((s) => byStage.has(s)),
    ...Array.from(byStage.keys()).filter((s) => !run.stages.includes(s)),
  ];

  const stageTree =
    orderedStages.length === 0 ? (
      <p className="mb-8 text-sm text-muted-foreground">No agents journaled yet.</p>
    ) : (
      <div className="mb-8 space-y-6">
        {orderedStages.map((stageTitle) => (
          <section key={stageTitle}>
            <Tooltip content="A stage groups the agents dispatched together. Stages run in the order the script declares them; agents inside one stage can run concurrently.">
              <h2 className="mb-2 inline-block cursor-help text-sm font-medium text-muted-foreground">
                ── {stageTitle}
              </h2>
            </Tooltip>
            <ul className="space-y-1">
              {(byStage.get(stageTitle) ?? []).map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
                >
                  <WorkflowStatusBadge status={a.status} />
                  <Tooltip content="Agent id within this run, assigned in dispatch order. It is the key the journal uses for this agent's start, retries, and end.">
                    <span className="cursor-help font-mono text-xs text-muted-foreground">
                      {a.id}
                    </span>
                  </Tooltip>
                  {a.harness ? (
                    <Tooltip
                      content={`Harness that ran this agent. It was spawned as a headless ${a.harness} subprocess${a.model ? `, model ${a.model}` : ""}.`}
                    >
                      <span className="cursor-help rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {a.harness}
                      </span>
                    </Tooltip>
                  ) : null}
                  <Tooltip content="The agent's label from the workflow script. Hover the row's right-hand figures for attempts, duration, and cost.">
                    <span className="min-w-0 flex-1 cursor-help truncate">{a.label}</span>
                  </Tooltip>
                  {a.status === "running" && a.startedAt ? (
                    <AgentElapsed startedAt={a.startedAt} live={liveAgentIds.has(a.id)} />
                  ) : null}
                  {a.attempts !== undefined ||
                  a.durationMs !== undefined ||
                  a.costUsd !== undefined ? (
                    <Tooltip
                      content={`${
                        a.attempts !== undefined
                          ? `${a.attempts} attempt${a.attempts === 1 ? "" : "s"} (a retry costs extra and is counted here). `
                          : ""
                      }${
                        a.durationMs !== undefined
                          ? `Ran for ${Math.round(a.durationMs / 1000)} seconds. `
                          : ""
                      }${
                        a.costUsd !== undefined
                          ? `Cost $${a.costUsd.toFixed(4)} across every attempt.`
                          : ""
                      }`.trim()}
                    >
                      <span className="cursor-help text-xs text-muted-foreground">
                        {a.attempts !== undefined
                          ? `${a.attempts} attempt${a.attempts === 1 ? "" : "s"}`
                          : ""}
                        {a.durationMs !== undefined ? ` · ${Math.round(a.durationMs / 1000)}s` : ""}
                        {a.costUsd !== undefined ? ` · $${a.costUsd.toFixed(4)}` : ""}
                      </span>
                    </Tooltip>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );

  /*
   * The activity panel owns its own scroll, and the page keeps owning the
   * document scroll.
   *
   * `/live` and `/events` can use a `fixed inset-0` shell because a log is the
   * whole page there. Here the run also has to show the workspace and proof
   * cards, which that shell would fight, so the log gets a bounded height
   * instead. `overscroll-contain` on the table's own scroller is what keeps the
   * two surfaces from chaining: without it, reaching the end of the log starts
   * scrolling the document underneath it.
   */
  const activitySection =
    sessionIds.size === 0 ? null : (
      <section className="mb-8">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <Tooltip content="Everything this run's child agents actually did: each shell command with its declared intent, each file read or edit, and each turn boundary. The run journal only records agent starts and ends, so this is the only place the work itself shows up.">
            <h2 className="cursor-help text-sm font-semibold">Activity</h2>
          </Tooltip>
          <Tooltip content="One child session per agent the run spawned. `live` counts the ones still running, from their coordination heartbeats. Rows are newest-first, the same direction the Live page reads.">
            <span className="cursor-help text-xs text-muted-foreground">
              {childSessions.length} child session{childSessions.length === 1 ? "" : "s"} ·{" "}
              {childSessions.filter((c) => c.live).length} live · newest first
            </span>
          </Tooltip>
        </div>
        <div className="flex h-[32rem] flex-col [&_.overflow-y-auto]:overscroll-contain">
          <AgentChipProvider summaries={summaries}>
            <WorkflowActivityLog
              runId={run.runId}
              initialRows={activityRows}
              agentNames={childNames}
              instanceToName={instanceToName}
            />
          </AgentChipProvider>
        </div>
      </section>
    );

  return (
    <div className="min-h-screen">
      <NavBar scannedDir={coordRoot()} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <p className="mb-3 text-xs">
          <Link href="/workflows" className="text-muted-foreground hover:text-foreground">
            ← all runs
          </Link>
        </p>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <WorkflowStatusBadge status={run.status} />
          {run.workspace ? <WorkspaceStateBadge inspection={run.workspace} /> : null}
          <h1 className="text-xl font-semibold">{run.name}</h1>
        </div>
        <p className="mb-6 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <Tooltip content="Run id. Its journal lives at .harnery/workflows/<run-id>/journal.jsonl, and `workflow proof <run-id>` prints the terminal proof packet.">
            <span className="cursor-help font-mono">{run.runId}</span>
          </Tooltip>
          {run.startedAt ? (
            <Tooltip content="When the orchestrator wrote run.start.">
              <span className="cursor-help">
                {"· started "}
                <FormattedDateTime iso={run.startedAt} />
              </span>
            </Tooltip>
          ) : null}
          {run.endedAt ? (
            <Tooltip content="When the orchestrator wrote run.end. Absent while a run is still in flight.">
              <span className="cursor-help">
                {"· ended "}
                <FormattedDateTime iso={run.endedAt} />
              </span>
            </Tooltip>
          ) : null}
          <Tooltip content="Total cost of every agent in this run, summed from agent.end. It reads $0.0000 mid-run, because cost is only reported when an agent finishes.">
            <span className="cursor-help">{`· $${run.costUsd.toFixed(4)}`}</span>
          </Tooltip>
          {run.agentsCached > 0 ? (
            <Tooltip content="Agents skipped because an identical call in a prior run already produced a result. Cached agents cost nothing and spawn no child.">
              <span className="cursor-help">{`· ${run.agentsCached} cached`}</span>
            </Tooltip>
          ) : null}
          {run.billing.length > 0 ? (
            <Tooltip content="How each harness authenticated. `subscription` means a stored login paid for it; `api` means an API key did.">
              <span className="cursor-help">{`· billing: ${run.billing.join(", ")}`}</span>
            </Tooltip>
          ) : null}
        </p>

        {run.status === "parked" && run.parkedApprovalId ? (
          <section className="mb-8 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <h2 className="text-sm font-semibold">Awaiting durable approval</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              No further protected work will run until this request is resolved and the workflow is
              resumed explicitly.
            </p>
            <code className="mt-3 block break-all text-xs">{run.parkedApprovalId}</code>
            <code className="mt-1 block break-all text-xs">
              harn workflow approvals show {run.parkedApprovalId}
            </code>
          </section>
        ) : null}

        {/* Where the run is, then what it is doing. Both above the workspace and
            proof cards, which matter most once the run is over. */}
        {stageTree}
        {activitySection}

        {run.workspace ? (
          !run.workspace.ok ? (
            <section className="mb-8 rounded-lg border border-red-500/40 bg-red-500/5 p-4">
              <h2 className="text-sm font-semibold">Workspace evidence is invalid</h2>
              <p className="mt-1 break-all text-sm text-muted-foreground">{run.workspace.error}</p>
            </section>
          ) : (
            <section className="mb-8 rounded-lg border border-border bg-card p-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <Tooltip content="Which checkout the run's agents edited. A shared workspace means they worked directly in this repo; an isolated one means they worked in a separate checkout that has to be integrated before the changes land here.">
                  <h2 className="cursor-help text-sm font-semibold">Workspace</h2>
                </Tooltip>
                <WorkspaceStateBadge inspection={run.workspace} />
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <Tooltip content="What the run asked for versus what it got. These differ when isolation was requested but could not be honoured, in which case the run fell back to the shared checkout and says so below.">
                    <dt className="cursor-help text-xs uppercase tracking-wide text-muted-foreground">
                      Allocation
                    </dt>
                  </Tooltip>
                  <dd className="mt-1">
                    {run.workspace.value.requested_isolation} requested ·{" "}
                    {run.workspace.value.effective_isolation} effective
                  </dd>
                  {run.workspace.value.provider ? (
                    <Tooltip content="The workspace provider that allocated the checkout, and its version.">
                      <dd className="mt-1 cursor-help font-mono text-xs text-muted-foreground">
                        {run.workspace.value.provider.id}@{run.workspace.value.provider.version}
                      </dd>
                    </Tooltip>
                  ) : null}
                </div>
                <div>
                  <Tooltip content="Whether the workspace was still what the run claimed it was when it finished. `drift` counts things that changed underneath it; `unknown` counts things the check could not determine either way, which is reported rather than assumed benign.">
                    <dt className="cursor-help text-xs uppercase tracking-wide text-muted-foreground">
                      Verification
                    </dt>
                  </Tooltip>
                  <dd className="mt-1">{run.workspace.value.verification.status}</dd>
                  <dd className="mt-1 text-xs text-muted-foreground">
                    {run.workspace.value.verification.drift.length} drift ·{" "}
                    {run.workspace.value.verification.unknowns.length} unknown
                  </dd>
                </div>
                <div>
                  <Tooltip content="Whether work done in an isolated workspace has been brought back into this checkout yet. `none` means there was nothing to integrate, which is the normal reading for a shared-workspace run.">
                    <dt className="cursor-help text-xs uppercase tracking-wide text-muted-foreground">
                      Integration
                    </dt>
                  </Tooltip>
                  <dd className="mt-1">{run.workspace.value.integration.state}</dd>
                  <dd className="mt-1 text-xs text-muted-foreground">
                    {run.workspace.value.integration.changed_paths.length} changed path
                    {run.workspace.value.integration.changed_paths.length === 1 ? "" : "s"}
                  </dd>
                </div>
                <div>
                  <Tooltip content="Whether the isolated checkout has been released. Cleanup is deliberately conservative: a workspace with uncommitted changes is preserved rather than deleted, so nothing is thrown away silently.">
                    <dt className="cursor-help text-xs uppercase tracking-wide text-muted-foreground">
                      Cleanup
                    </dt>
                  </Tooltip>
                  <dd className="mt-1">{run.workspace.value.cleanup.state.replaceAll("_", " ")}</dd>
                  <dd className="mt-1 text-xs text-muted-foreground">
                    {run.workspace.value.cleanup.attempts} attempt
                    {run.workspace.value.cleanup.attempts === 1 ? "" : "s"}
                  </dd>
                </div>
              </dl>
              {run.workspace.value.compatibility ? (
                <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                  Compatibility selection: {run.workspace.value.compatibility.reason}. The run used
                  the shared checkout.
                </p>
              ) : null}
              {run.workspace.value.allocation ? (
                <div className="mt-4 space-y-1 border-t border-border pt-3 font-mono text-xs text-muted-foreground">
                  <p className="break-all">binding {run.workspace.value.allocation.binding_id}</p>
                  <p className="break-all">
                    workspace {run.workspace.value.allocation.workspace_root}
                  </p>
                  <p className="break-all">active {run.workspace.value.allocation.active_root}</p>
                </div>
              ) : null}
              {run.workspace.value.repository.dirty_paths.length > 0 ||
              run.workspace.value.repository.conflicts.length > 0 ||
              run.workspace.value.repository.operations_in_progress.length > 0 ? (
                <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                  {run.workspace.value.repository.dirty_paths.length} dirty path ·{" "}
                  {run.workspace.value.repository.conflicts.length} conflict ·{" "}
                  {run.workspace.value.repository.operations_in_progress.length} Git operation
                </div>
              ) : null}
            </section>
          )
        ) : null}

        {run.proof ? (
          <section className="mb-8 rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Tooltip content="The bounded record of what the run proved, written when it ended. `workflow proof <run-id>` prints the same packet on the command line.">
                <h2 className="cursor-help text-sm font-semibold">Run proof</h2>
              </Tooltip>
              <Tooltip content="How the run scored against the acceptance criteria it was given. `unknown` is a real verdict rather than a rounding error: it means the evidence did not settle the question, and it is reported instead of being counted as a pass.">
                <span className="cursor-help text-xs text-muted-foreground">
                  {run.proof.acceptance.summary.satisfied} satisfied ·{" "}
                  {run.proof.acceptance.summary.unsatisfied} unsatisfied ·{" "}
                  {run.proof.acceptance.summary.unknown} unknown
                </span>
              </Tooltip>
            </div>
            {run.proof.run.objective ? (
              <p className="mb-4 text-sm">{run.proof.run.objective}</p>
            ) : null}
            {run.proof.policy ? (
              <div className="mb-4 rounded-md border border-border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Tooltip content="The policy the run was launched under. It decides what the agents were allowed to do before they tried it, rather than after.">
                    <span className="cursor-help font-medium">Policy: {run.proof.policy.name}</span>
                  </Tooltip>
                  <Tooltip content="Policy decisions made during the run. `asked` counts requests that needed an explicit approval, which park the run until someone resolves them.">
                    <span className="cursor-help rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {run.proof.policy.summary.allowed} allowed · {run.proof.policy.summary.denied}{" "}
                      denied · {run.proof.policy.summary.asked} asked
                    </span>
                  </Tooltip>
                  <Tooltip content="The isolation and network posture the policy granted this run.">
                    <span className="cursor-help text-xs text-muted-foreground">
                      {run.proof.policy.isolation} · network {run.proof.policy.network_access}
                    </span>
                  </Tooltip>
                </div>
                {run.proof.policy.decisions.length > 0 ? (
                  <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">
                      {run.proof.policy.decisions.length} decision
                      {run.proof.policy.decisions.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {run.proof.policy.decisions.map((decision) => (
                        <li key={decision.id} className="rounded bg-muted/50 px-2 py-1.5">
                          <span className="font-mono">{decision.id}</span> · {decision.verdict}
                          {decision.initial_verdict === "ask" ? " after ask" : ""} ·{" "}
                          {decision.phase} · {decision.request.action}
                          <span className="block break-all pt-0.5">{decision.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : null}
            {run.proof.acceptance.criteria.length > 0 ? (
              <ul className="mb-4 space-y-1">
                {run.proof.acceptance.criteria.map((criterion) => (
                  <li
                    key={criterion.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <WorkflowStatusBadge
                      status={
                        criterion.status === "satisfied"
                          ? "done"
                          : criterion.status === "unsatisfied"
                            ? "failed"
                            : "stale"
                      }
                    />
                    <Tooltip content="Criterion id. The evidence entries below cite these ids, which is how a claim is tied to the thing that backs it.">
                      <span className="cursor-help font-mono text-xs text-muted-foreground">
                        {criterion.id}
                      </span>
                    </Tooltip>
                    <span className="min-w-0 flex-1">{criterion.statement}</span>
                    {criterion.evidence_ids.length > 0 ? (
                      <Tooltip content="Evidence backing this criterion. A criterion with no evidence cannot be marked satisfied.">
                        <span className="cursor-help text-xs text-muted-foreground">
                          {criterion.evidence_ids.join(", ")}
                        </span>
                      </Tooltip>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {run.proof.evidence.length > 0 ? (
              <div className="mb-4">
                <Tooltip content="What the run actually produced to back its claims: command output, file diffs, test results. Each entry carries where it came from and whether it held up.">
                  <h3 className="mb-2 inline-block cursor-help text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Evidence
                  </h3>
                </Tooltip>
                <ul className="space-y-1">
                  {run.proof.evidence.map((evidence) => (
                    <li
                      key={evidence.id}
                      className="rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Tooltip content="Evidence id, cited by the acceptance criteria above.">
                          <span className="cursor-help font-mono text-xs text-muted-foreground">
                            {evidence.id}
                          </span>
                        </Tooltip>
                        <Tooltip content="Kind of evidence, whether it held up, and who recorded it. Evidence recorded by the agent doing the work is weaker than evidence from an independent check, so the source is kept rather than flattened away.">
                          <span className="cursor-help rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            {evidence.kind} · {evidence.status} · {evidence.source}
                          </span>
                        </Tooltip>
                        <span>{evidence.label}</span>
                      </div>
                      {evidence.summary ? (
                        <p className="mt-1 text-xs text-muted-foreground">{evidence.summary}</p>
                      ) : null}
                      {evidence.ref ? (
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          {evidence.ref}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <Tooltip content="The repository before and after the run: which branch it was on, which commit HEAD pointed at, and how many uncommitted paths the run added or cleared. This is what lets you tell a run that changed the checkout from one that only read it.">
              <p className="cursor-help text-xs text-muted-foreground">
                Repository: {run.proof.repository.before.branch ?? "unknown"} →{" "}
                {run.proof.repository.after.branch ?? "unknown"} · HEAD{" "}
                {run.proof.repository.before.head?.slice(0, 8) ?? "unknown"} →{" "}
                {run.proof.repository.after.head?.slice(0, 8) ?? "unknown"} ·{" "}
                {run.proof.repository.drift.dirty_paths_added.length} dirty added ·{" "}
                {run.proof.repository.drift.dirty_paths_cleared.length} cleared
              </p>
            </Tooltip>
            {run.proof.unknowns.length > 0 ? (
              <details className="mt-3 text-xs text-muted-foreground">
                {/* The tooltip goes INSIDE the summary. Wrapping the summary
                    itself puts an element between it and its <details> parent,
                    which makes the browser stop treating it as the disclosure
                    label and fall back to rendering "Details". */}
                <summary className="cursor-pointer">
                  <Tooltip content="Things the run could not determine. They are surfaced rather than dropped, because a check that could not run is not the same as a check that passed.">
                    <span>{run.proof.unknowns.length} unknowns</span>
                  </Tooltip>
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {run.proof.unknowns.map((unknown, index) => (
                    <li key={`${unknown.code}-${unknown.agent_id ?? unknown.harness ?? index}`}>
                      {unknown.message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : null}

      </main>
    </div>
  );
}
