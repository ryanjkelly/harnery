import { FileText } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AgentChip, AgentChipList, AgentChipProvider } from "@/components/AgentChip";
import { ContributionMatrixCard } from "@/components/ContributionMatrix";
import { CouncilActions } from "@/components/CouncilActions";
import { CouncilCompletionBanner } from "@/components/CouncilCompletionBanner";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { NavBar } from "@/components/NavBar";
import { RoundDiff } from "@/components/RoundDiff";
import { NextActionBanner, RoutingLegend } from "@/components/RoutingGuide";
import { RoutingPromptTabs } from "@/components/RoutingPromptTabs";
import { WaitingOnSteward } from "@/components/WaitingOnSteward";
import { FilePath } from "@/components/file-viewer/FilePath";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import { listKnownAgents } from "@/lib/agent-summary";
import { NO_DATA } from "@/lib/format/no-data";
import {
  coordRoot,
  readAgents,
  readCouncilDetail,
  readInstanceIdentities,
} from "@/lib/coord-reader";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ archived?: string }>;
}

export default async function CouncilDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const decoded = decodeURIComponent(id);
  const detail = readCouncilDetail(decoded, sp.archived === "1");
  if (!detail) notFound();

  const {
    manifest,
    summary,
    contribution_matrix,
    consecutive_all_trivial_rounds,
    exit_criterion_met,
    archived,
    rounds,
    invite_markdown,
    steward,
    current_round_contributors,
    current_round_prompts,
  } = detail;

  // Prior rounds (everything < current_round). These feed the RoundDiff
  // (Plan evolution) component regardless of visibility, since the diff is
  // strictly across already-collected rounds.
  const priorRounds = rounds.filter((r) => r.round < manifest.current_round);

  const pending = manifest.members.filter((m) => !current_round_contributors.includes(m));

  // Closed or archived: every "in-progress" affordance (round-status badge,
  // pending lists, contributor counts on a dead round) renders terminal-aware.
  const terminal = archived || manifest.status !== "active";

  // Routing-flow guidance: which prompt is copy-able now (the sequential model
  // gates copy on `active`), and how many of the drafted prompts are already in.
  const activePrompt = current_round_prompts.find((p) => p.state === "active") ?? null;
  const promptsContributed = current_round_prompts.filter((p) => p.state === "contributed").length;
  const promptsTotal = current_round_prompts.length;

  // Live "working" signal per member: an agent heartbeating within the last
  // ~2 minutes. The global LiveRefresher (mounted in NavBar) already calls
  // router.refresh() on any .harnery/ change, heartbeat writes included, so
  // this server-computed map updates live with no per-page plumbing: a member
  // kicked off in another window surfaces a pulsing "working" pill here, and
  // flips to "contributed" the moment their council.contribution lands.
  const WORKING_WINDOW_MS = 120_000;
  const nowMs = Date.now();
  const activityByMember: Record<string, { lastTool: string | null; lastSeen: string }> = {};
  for (const hb of readAgents().active) {
    const ageMs = nowMs - Date.parse(hb.last_heartbeat);
    if (!Number.isFinite(ageMs) || ageMs > WORKING_WINDOW_MS) continue;
    const name = hb.name.startsWith("agent-") ? hb.name : `agent-${hb.name}`;
    activityByMember[name] = {
      lastTool: hb.last_tool ?? null,
      lastSeen: hb.last_heartbeat,
    };
  }
  const activeMemberWorking = activePrompt ? Boolean(activityByMember[activePrompt.member]) : false;

  // Open round nobody has acted on (no prompts drafted, no contributions).
  // With exit_criterion_met this means the operator advanced past the finish
  // line, so the banner + Actions panel + attention system all recommend Close
  // until someone acts on the round (which signals "keep deliberating").
  const roundIdle =
    manifest.round_status === "open" &&
    current_round_contributors.length === 0 &&
    promptsTotal === 0;
  const closeRecommended =
    exit_criterion_met && (manifest.round_status === "collected" || roundIdle);

  // Members who haven't contributed AND have no routing prompt. The steward
  // (who routes prompts to others and contributes directly) is the usual case.
  // When all drafted prompts are in, these are what still block the round.
  const pendingUnrouted = pending.filter((m) => !current_round_prompts.some((p) => p.member === m));
  const workingUnrouted = pendingUnrouted.filter((m) => Boolean(activityByMember[m]));

  // Build the agent-summary map for every agent surfaced on this page so
  // AgentChip popovers render with persona metadata baked in.
  const everyName = new Set<string>();
  if (manifest.created_by) everyName.add(manifest.created_by);
  if (manifest.steward) everyName.add(manifest.steward);
  if (steward) everyName.add(steward);
  for (const m of manifest.members) everyName.add(m);
  for (const m of current_round_contributors) everyName.add(m);
  for (const p of current_round_prompts) everyName.add(p.member);
  for (const r of rounds) {
    for (const c of r.contributors) everyName.add(c.author);
  }
  // Durable session identities ride along so stale members (no heartbeat
  // left) still resolve their harness (platform): the operator routing a
  // prompt needs to know WHICH harness window to paste into.
  const summaries = buildAgentSummaryMap(everyName, readInstanceIdentities());
  const knownAgents = listKnownAgents();
  const summaryOf = (member: string) =>
    summaries[(member.startsWith("agent-") ? member.slice("agent-".length) : member).toLowerCase()];
  const platformOf = (member: string): string | null => summaryOf(member)?.platform ?? null;

  return (
    <AgentChipProvider summaries={summaries}>
      <NavBar scannedDir={coordRoot()} />
      <main className="w-full max-w-screen-2xl mx-auto px-6 pb-10">
        <nav className="mb-4 text-xs text-muted-foreground">
          <Link href="/councils" className="hover:text-foreground">
            ← Councils
          </Link>
          {" / "}
          <Link href="/agents" className="hover:text-foreground">
            Agents
          </Link>
        </nav>

        <header className="mb-6">
          <h1 className="text-base font-mono font-semibold tracking-tight flex items-center gap-3 flex-wrap break-all">
            {manifest.council_id}
            <Badge
              variant="outline"
              title={
                manifest.status === "active"
                  ? "Council accepts mutations (contribute / advance / close)."
                  : manifest.status === "closed"
                    ? "Read-only; deliberation finalized."
                    : "Moved to .harnery/councils/archive/ (terminal state)."
              }
            >
              {manifest.status}
            </Badge>
            <Badge
              variant="muted"
              title={
                terminal
                  ? `Round ${manifest.current_round} was ${manifest.round_status} when the council closed; deliberation ended here.`
                  : manifest.round_status === "open"
                    ? `Round ${manifest.current_round} is open; members can still contribute.`
                    : `Round ${manifest.current_round} is collected (all members in), ready to advance.`
              }
            >
              {terminal
                ? `round ${manifest.current_round} final`
                : `round ${manifest.current_round} ${manifest.round_status}`}
            </Badge>
            {/* On terminal councils a dead round's 0/N reads like outstanding
                work, so only show the contributor count while the round can
                still take contributions (or actually got some). */}
            {(!terminal || current_round_contributors.length > 0) && (
              <Badge
                variant="default"
                title={
                  terminal
                    ? `Round ${manifest.current_round} ended with ${current_round_contributors.length}/${manifest.members.length} contributions.`
                    : `${current_round_contributors.length}/${manifest.members.length} members contributed to round ${manifest.current_round}.${pending.length > 0 ? ` Pending: ${pending.join(", ")}.` : " All members in."}`
                }
              >
                {current_round_contributors.length}/{manifest.members.length}
              </Badge>
            )}
            {/* The status badge already reads "archived" once the manifest
                flips, so only render the extra archived badge for the edge
                where an archive-dir manifest still says "closed". */}
            {archived && manifest.status !== "archived" && (
              <Badge
                variant="outline"
                title="Council moved to .harnery/councils/archive/ (read-only)."
              >
                archived
              </Badge>
            )}
          </h1>
          <p className="text-sm text-foreground/90 mt-2 leading-relaxed">{manifest.objective}</p>
          {manifest.target_doc && (
            <p className="text-xs text-muted-foreground mt-1 font-mono inline-flex items-center gap-1">
              target:
              <FileText className="size-3 shrink-0" aria-hidden />
              {manifest.target_doc}
            </p>
          )}
        </header>

        <CouncilCompletionBanner
          status={manifest.status}
          archived={archived}
          closedAt={manifest.closed_at}
          archivedAt={manifest.archived_at}
          councilId={manifest.council_id}
          steward={steward}
          consecutiveAllTrivialRounds={consecutive_all_trivial_rounds}
          totalRounds={manifest.current_round}
          closeHandoffPath={summary.close_handoff_path}
          stewardWorking={Boolean(activityByMember[steward])}
        />

        {contribution_matrix.rounds.length > 0 && contribution_matrix.mapping.length > 0 && (
          <div className="mb-4">
            <ContributionMatrixCard
              matrix={contribution_matrix}
              currentRound={manifest.current_round}
            />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-1 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Summary</CardTitle>
              </CardHeader>
              <CardContent className="text-xs space-y-2">
                <Row label="convened" value={<AgentChip name={manifest.created_by} />} />
                {steward && steward !== manifest.created_by && (
                  <Row label="steward" value={<AgentChip name={steward} />} />
                )}
                <Row label="created" value={<FormattedDateTime iso={manifest.created_at} />} />
                <Row label="auto-adv" value={manifest.auto_advance ? "yes" : "no"} />
                <Row label="visibility" value={manifest.round_visibility ?? "next_round"} />
                {manifest.closed_at && (
                  <Row label="closed" value={<FormattedDateTime iso={manifest.closed_at} />} />
                )}
                {manifest.archived_at && (
                  <Row label="archived" value={<FormattedDateTime iso={manifest.archived_at} />} />
                )}
                {summary.close_handoff_path && (
                  <Row
                    label="handoff"
                    value={
                      <span className="font-mono text-xs inline-flex items-center gap-1 break-all">
                        <FileText className="size-3 shrink-0" aria-hidden />
                        {/* council handoff path → clickable */}
                        <FilePath path={summary.close_handoff_path} className="font-mono text-xs" />
                      </span>
                    }
                  />
                )}
              </CardContent>
            </Card>

            {/* A terminal council's empty current round (opened past the
                finish line, never ran) would render as all-members-pending,
                pure noise; the plan-evolution diff covers real history. */}
            {(!terminal || current_round_contributors.length > 0) && (
              <Card>
                <CardHeader>
                  <CardTitle>
                    Round {manifest.current_round} ({current_round_contributors.length}/
                    {manifest.members.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs space-y-2">
                  <Row
                    label="contributed"
                    value={
                      current_round_contributors.length > 0 ? (
                        <AgentChipList names={current_round_contributors} />
                      ) : (
                        NO_DATA
                      )
                    }
                  />
                  <Row
                    label={terminal ? "did not contribute" : "pending"}
                    value={pending.length > 0 ? <AgentChipList names={pending} /> : NO_DATA}
                  />
                </CardContent>
              </Card>
            )}

            {/* Anchor target for the NextActionBanner's "Advance to round N"
                link; scroll-mt clears the page padding when jumped to. */}
            <div id="council-actions" className="scroll-mt-24">
              <CouncilActions
                councilId={manifest.council_id}
                status={manifest.status}
                roundStatus={manifest.round_status}
                pending={pending}
                currentRound={manifest.current_round}
                steward={steward}
                exitCriterionMet={exit_criterion_met}
                consecutiveAllTrivialRounds={consecutive_all_trivial_rounds}
                roundIdle={roundIdle}
                closeHandoffDone={summary.close_handoff_path !== null}
                knownAgents={knownAgents}
              />
            </div>
          </div>

          <div className="lg:col-span-2 space-y-4">
            {/* closeRecommended widens the gate: an idle round has no prompts,
                but the stage-0 "close the council" banner (and its attention
                alert) must still render. */}
            {!archived &&
              manifest.status === "active" &&
              (promptsTotal > 0 || closeRecommended) && (
                <NextActionBanner
                  councilId={manifest.council_id}
                  activeMember={activePrompt?.member ?? null}
                  activeMemberPlatform={activePrompt ? platformOf(activePrompt.member) : null}
                  activeMemberWorking={activeMemberWorking}
                  routedContributed={promptsContributed}
                  routedTotal={promptsTotal}
                  pendingUnrouted={pendingUnrouted}
                  workingUnrouted={workingUnrouted}
                  steward={steward}
                  memberContributed={current_round_contributors.length}
                  memberTotal={manifest.members.length}
                  currentRound={manifest.current_round}
                  nextRound={manifest.current_round + 1}
                  exitCriterionMet={exit_criterion_met}
                  consecutiveAllTrivialRounds={consecutive_all_trivial_rounds}
                  roundIdle={roundIdle}
                />
              )}
            {!archived && manifest.status === "active" && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 flex-wrap">
                    <span>Routing prompts: round {manifest.current_round}</span>
                    {manifest.round_status === "collected" && (
                      <Badge variant="outline">complete</Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {current_round_prompts.length === 0 ? (
                    <WaitingOnSteward
                      councilId={manifest.council_id}
                      currentRound={manifest.current_round}
                      steward={steward}
                      stewardWorking={Boolean(activityByMember[steward])}
                    />
                  ) : (
                    <div>
                      <RoutingLegend />
                      <RoutingPromptTabs
                        prompts={current_round_prompts.map((p) => ({
                          member: p.member,
                          body: p.body,
                          bytes: p.bytes,
                          state: p.state,
                          order: p.order,
                          activity: activityByMember[p.member] ?? null,
                          platform: platformOf(p.member),
                          model: summaryOf(p.member)?.model ?? null,
                        }))}
                        steward={
                          steward
                            ? {
                                name: steward,
                                contributed: current_round_contributors.includes(steward),
                                platform: platformOf(steward),
                                model: summaryOf(steward)?.model ?? null,
                                activity: activityByMember[steward] ?? null,
                              }
                            : null
                        }
                        councilId={manifest.council_id}
                        currentRound={manifest.current_round}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>
                  Plan evolution ({priorRounds.length} prior round
                  {priorRounds.length === 1 ? "" : "s"})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {priorRounds.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">
                    No prior rounds yet. Contributions for round {manifest.current_round} stay
                    hidden until round {manifest.current_round + 1} opens (round_visibility=
                    {manifest.round_visibility ?? "next_round"}).
                  </p>
                ) : (
                  <RoundDiff rounds={priorRounds} />
                )}
              </CardContent>
            </Card>

            {invite_markdown && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 flex-wrap">
                    <span>Invitation</span>
                    <Badge
                      variant="outline"
                      title="Read-only context. The invitation is what members saw when the council was convened; it doesn't change across rounds."
                    >
                      reference
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
                    The original onboarding message routed to members at convene-time. Shown here
                    for context; the live per-round instructions live in the Routing prompts card
                    above.
                  </p>
                  <pre className="text-xs whitespace-pre-wrap font-mono max-h-100 overflow-y-auto leading-relaxed px-3 py-2 rounded border border-border/60 bg-background/60">
                    {invite_markdown}
                  </pre>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </AgentChipProvider>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: string | React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground/70 tabular-nums shrink-0 w-16">{label}</span>
      <span className="text-foreground/90 break-all">{value}</span>
    </div>
  );
}
