import { BreakableMono } from "@/components/BreakableMono";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  CodecPanelScene,
  CodecRelationship,
  CodecScene,
  CodecTransient,
  Presented,
} from "@/lib/codec/contracts";
import type { SemanticAgentReadModelV2 } from "../../../src/core/semantic/contract";

interface AgentStateAtlasProps {
  panel?: CodecPanelScene;
  relationships: CodecRelationship[];
  transients: CodecTransient[];
  sceneFreshness: CodecScene["freshness"];
  sceneGeneratedAt: string;
  semanticDocument?: SemanticAgentReadModelV2;
  namesByInstance: Record<string, string>;
}

interface SemanticFieldValue {
  value: unknown;
  basis: string;
  confidence: string;
  evidence_event_ids: string[];
  observed_at?: string;
}

const SIGNAL_LABELS = [
  "Declared task",
  "Presence",
  "Activity",
  "Lifecycle",
  "Expression",
  "Attention",
  "Context band",
  "Context usage",
  "Runtime",
  "Progress rhythm",
  "Focus",
  "Current operation",
  "Artifact cue",
  "Friction",
  "Telemetry",
  "Telemetry reason",
  "Parent instance",
  "Ledger state",
  "Remote relay",
  "Remote digest",
] as const;

/** Full-detail counterpart to a Codec card. Codec remains the projection
 * authority; this component makes every channel and receipt inspectable. */
export function AgentStateAtlas({
  panel,
  relationships,
  transients,
  sceneFreshness,
  sceneGeneratedAt,
  semanticDocument,
  namesByInstance,
}: AgentStateAtlasProps) {
  const signals = panel
    ? [
        panel.identity.task,
        panel.presence,
        panel.activity,
        panel.lifecycle,
        panel.expression,
        panel.attention,
        panel.context_band,
        panel.context_usage,
        panel.runtime,
        panel.progress_rhythm,
        panel.focus_bubble,
        panel.operation,
        panel.artifact_cue,
        panel.friction,
        panel.telemetry,
        panel.telemetry_reason,
        panel.parent_instance_id,
        panel.ledger_state,
        panel.remote_source?.relay,
        panel.remote_source?.digest,
      ]
    : [];

  return (
    <div className="mb-4 space-y-4" data-agent-state-atlas>
      <Card className="overflow-hidden border-sky-500/30 bg-gradient-to-br from-sky-500/5 via-card to-purple-500/5">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Complete agent state</CardTitle>
              <CardDescription className="mt-1 max-w-3xl leading-relaxed">
                The same canonical projection that powers Codec, expanded with every receipt and
                joined to the durable semantic record. Direct records remain below.
              </CardDescription>
            </div>
            <fieldset className="flex flex-wrap gap-1.5">
              <legend className="sr-only">State source legend</legend>
              <Badge variant="info">direct</Badge>
              <Badge variant="outline">projected</Badge>
              <Badge variant="warning">inferred</Badge>
              <Badge variant="accent">semantic</Badge>
            </fieldset>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCell
              label="Scene freshness"
              value={sceneFreshness.value}
              detail={`${sceneFreshness.provenance} · ${sceneFreshness.confidence} confidence`}
            />
            <SummaryCell
              label="Projection generated"
              value={<FormattedDateTime iso={sceneGeneratedAt} />}
              detail={`observed through ${sceneFreshness.observed_at}`}
            />
            <SummaryCell
              label="Current operation"
              value={
                panel?.operation?.value.intent ??
                panel?.operation?.value.label ??
                "No open operation"
              }
              detail={panel?.operation ? humanize(panel.operation.value.state) : "not observed"}
            />
            <SummaryCell
              label="Semantic state"
              value={panel?.semantic?.state ?? semanticDocument?.reader_outcome ?? "No reading"}
              detail={
                panel?.semantic?.reader.resolved_model_id ??
                panel?.semantic?.reader.configured_model ??
                "reader has not produced a document"
              }
            />
          </div>
        </CardContent>
      </Card>

      {panel ? (
        <>
          <section aria-labelledby="projected-signals-title">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="projected-signals-title" className="text-sm font-semibold">
                  Projected signals
                </h2>
                <p className="text-xs text-muted-foreground">
                  Every Codec panel channel, including unavailable channels.
                </p>
              </div>
              <div className="text-xs text-muted-foreground">
                updated <FormattedDateTime iso={panel.updated_at} />
              </div>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {SIGNAL_LABELS.map((label, index) => (
                <SignalCard key={label} label={label} signal={signals[index]} />
              ))}
            </div>
          </section>

          <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Recent intents ({panel.intent_history?.length ?? 0})</CardTitle>
                <CardDescription className="text-pretty">
                  Bounded operator-authored intent labels. Commands and tool inputs are excluded.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {panel.intent_history && panel.intent_history.length > 0 ? (
                  <ol className="space-y-2">
                    {panel.intent_history.map((intent) => (
                      <li key={intent.event_id} className="rounded-lg border border-border/50 p-3">
                        <p className="text-balance text-sm font-medium leading-relaxed">
                          {intent.text}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <Badge variant="outline">{humanize(intent.category)}</Badge>
                          <Badge variant="muted">{humanize(intent.event_type)}</Badge>
                          {intent.tool_name && <Badge variant="muted">{intent.tool_name}</Badge>}
                          {intent.adapter && <Badge variant="muted">{intent.adapter}</Badge>}
                          {intent.live_overlay && <Badge variant="info">live overlay</Badge>}
                        </div>
                        <ReceiptLine observedAt={intent.observed_at} eventIds={[intent.event_id]} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <EmptyState>No recent local intent signals.</EmptyState>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent actions ({panel.recent_actions.length})</CardTitle>
                <CardDescription className="text-pretty">
                  Newest sanitized action categories and outcomes.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {panel.recent_actions.length > 0 ? (
                  <ol className="space-y-2">
                    {panel.recent_actions.map((action) => (
                      <li
                        key={action.event_id}
                        className="grid gap-2 rounded-lg border border-border/50 p-3 sm:grid-cols-[1fr_auto]"
                      >
                        <div>
                          <p className="font-medium">{humanize(action.category)}</p>
                          <ReceiptLine
                            observedAt={action.observed_at}
                            eventIds={[action.event_id]}
                          />
                        </div>
                        <Badge variant={action.outcome === "error" ? "destructive" : "outline"}>
                          {action.outcome}
                        </Badge>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <EmptyState>No recent action evidence.</EmptyState>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-3">
            <FactCard title="Panel identity">
              <Fact label="Instance" value={panel.instance_id} mono />
              <Fact label="Display name" value={panel.identity.display_name} />
              <Fact label="Machine" value={panel.machine ?? "local"} />
              <Fact
                label="Artifact workspace"
                value={panel.has_artifact_workspace ? "available" : "not observed"}
              />
              <Fact label="Character pack" value={panel.character.pack_id} mono />
              <Fact label="Pack version" value={panel.character.pack_version} mono />
            </FactCard>
            <RelationshipCard relationships={relationships} namesByInstance={namesByInstance} />
            <TransientCard transients={transients} namesByInstance={namesByInstance} />
          </div>
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>No recent Codec panel</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              This generation is outside Codec&apos;s bounded recent-panel window. Durable direct,
              semantic, journal, and event records remain available on this page.
            </p>
          </CardContent>
        </Card>
      )}

      <SemanticRecord panel={panel} document={semanticDocument} />
    </div>
  );
}

function SummaryCell({
  label,
  value,
  detail,
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/50 bg-background/60 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 break-words text-sm font-semibold">{value}</div>
      <p className="mt-1 break-words text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function SignalCard({ label, signal }: { label: string; signal?: Presented<unknown> }) {
  return (
    <Card
      className="min-w-0 gap-2 overflow-hidden p-3"
      data-signal={label.toLowerCase().replaceAll(" ", "-")}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>{label}</CardTitle>
          {signal ? <ProvenanceBadge provenance={signal.provenance} /> : <Badge>unavailable</Badge>}
        </div>
      </CardHeader>
      <CardContent className="min-w-0 gap-2">
        {signal ? (
          <>
            <SignalValue value={signal.value} />
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="muted">{signal.confidence} confidence</Badge>
              {signal.expires_at && <Badge variant="warning">temporary</Badge>}
            </div>
            <ReceiptLine
              observedAt={signal.observed_at}
              expiresAt={signal.expires_at}
              eventIds={signal.evidence_event_ids}
            />
          </>
        ) : (
          <EmptyState>No value reached this projection.</EmptyState>
        )}
      </CardContent>
    </Card>
  );
}

function SignalValue({ value }: { value: unknown }) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <p className="text-balance break-words text-sm font-medium">{String(value)}</p>;
  }
  const rows = flattenStructuredValue(value);
  if (rows.length === 1 && rows[0]?.[0] === "value") {
    return <p className="text-balance break-words text-sm font-medium">{rows[0][1]}</p>;
  }
  return (
    <div className="min-w-0 max-w-full overflow-x-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
      <dl className="space-y-1">
        {rows.map(([key, nested]) => (
          <div
            key={key}
            className="grid min-w-0 grid-cols-1 gap-0.5 border-b border-border/30 pb-1 last:border-0 last:pb-0 sm:grid-cols-[minmax(8rem,0.75fr)_minmax(0,1fr)] sm:gap-2"
          >
            <dt className="text-balance text-muted-foreground">{humanizeStructuredKey(key)}</dt>
            <dd className="min-w-0 break-words">{nested}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function flattenStructuredValue(value: unknown, prefix = "value"): Array<[string, string]> {
  if (value === null) return [[prefix, "not reported"]];
  if (Array.isArray(value)) {
    if (value.length === 0) return [[prefix, "empty"]];
    if (value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
      return [[prefix, value.map(String).join(" · ")]];
    }
    return value.flatMap((item, index) => flattenStructuredValue(item, `${prefix}[${index}]`));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [[prefix, "empty"]];
    return entries.flatMap(([key, nested]) =>
      flattenStructuredValue(nested, prefix === "value" ? key : `${prefix}.${key}`),
    );
  }
  return [[prefix, String(value)]];
}

function ProvenanceBadge({ provenance }: { provenance: string }) {
  const variant =
    provenance === "event"
      ? "info"
      : provenance === "inferred"
        ? "warning"
        : provenance === "projection"
          ? "outline"
          : "muted";
  return <Badge variant={variant}>{provenance}</Badge>;
}

function ReceiptLine({
  observedAt,
  expiresAt,
  eventIds,
}: {
  observedAt: string;
  expiresAt?: string;
  eventIds?: string[];
}) {
  return (
    <div className="space-y-1 border-t border-border/40 pt-2 text-[10px] text-foreground/70">
      <p>
        observed <FormattedDateTime iso={observedAt} kind="timestamp" />
        {expiresAt && (
          <>
            {" "}
            · expires <FormattedDateTime iso={expiresAt} kind="timestamp" />
          </>
        )}
      </p>
      {eventIds && eventIds.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none">
            {eventIds.length} evidence event IDs
          </summary>
          <ul className="mt-1 space-y-0.5">
            {eventIds.map((eventId) => (
              <li key={eventId} className="break-all font-mono">
                {eventId}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function FactCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2">{children}</dl>
      </CardContent>
    </Card>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-1 border-b border-border/30 pb-2 last:border-0 last:pb-0 sm:grid-cols-[7rem_1fr]">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-xs">
        {mono && typeof value === "string" ? <BreakableMono text={value} /> : value}
      </dd>
    </div>
  );
}

function RelationshipCard({
  relationships,
  namesByInstance,
}: {
  relationships: CodecRelationship[];
  namesByInstance: Record<string, string>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Relationships ({relationships.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {relationships.length > 0 ? (
          <ul className="space-y-2">
            {relationships.map((relationship) => (
              <li key={relationship.relationship_id} className="rounded-lg border p-2 text-xs">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="accent">{humanize(relationship.kind)}</Badge>
                  <Badge variant="outline">{relationship.status}</Badge>
                  <Badge variant="muted">{relationship.provenance}</Badge>
                </div>
                <p className="mt-2 break-words">
                  {nameOf(relationship.from_instance_id, namesByInstance)} →{" "}
                  {nameOf(relationship.to_instance_id, namesByInstance)}
                </p>
                <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                  {relationship.relationship_id}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No active projected relationships.</EmptyState>
        )}
      </CardContent>
    </Card>
  );
}

function TransientCard({
  transients,
  namesByInstance,
}: {
  transients: CodecTransient[];
  namesByInstance: Record<string, string>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Transient cues ({transients.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {transients.length > 0 ? (
          <ul className="space-y-2">
            {transients.map((transient) => (
              <li key={transient.cue_id} className="rounded-lg border p-2 text-xs">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="info">{humanize(transient.kind)}</Badge>
                  <Badge variant="muted">{transient.provenance}</Badge>
                </div>
                <p className="mt-2">
                  {transient.from_instance_id
                    ? nameOf(transient.from_instance_id, namesByInstance)
                    : "system"}{" "}
                  →{" "}
                  {transient.to_instance_id
                    ? nameOf(transient.to_instance_id, namesByInstance)
                    : "team"}
                </p>
                <ReceiptLine observedAt={transient.occurred_at} expiresAt={transient.expires_at} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No unexpired transient cues.</EmptyState>
        )}
      </CardContent>
    </Card>
  );
}

function SemanticRecord({
  panel,
  document,
}: {
  panel?: CodecPanelScene;
  document?: SemanticAgentReadModelV2;
}) {
  const presented = panel?.semantic;
  const documentFields =
    document?.reader_outcome === "accepted"
      ? (Object.entries(document.meaning) as Array<[string, SemanticFieldValue]>)
      : [];
  const projectedFields = presented
    ? (
        [
          ["headline", presented.headline],
          ["summary", presented.summary],
          ["phase", presented.phase],
          ["expression_cue", presented.expression_cue],
          ["purpose", presented.purpose],
          ["recent_result", presented.recent_result],
          ["attention", presented.attention],
          ["next_step", presented.next_step],
          ["tags", presented.tags],
        ] as const
      ).flatMap(([label, field]) =>
        field
          ? [
              [
                label,
                {
                  value: field.value,
                  basis: field.basis,
                  confidence: field.confidence,
                  evidence_event_ids: field.evidence_event_ids ?? [],
                  observed_at: field.observed_at,
                },
              ] as [string, SemanticFieldValue],
            ]
          : [],
      )
    : [];
  const fields = documentFields.length > 0 ? documentFields : projectedFields;
  const reader = document?.reader ?? presented?.reader;
  const readerOutcome = document?.reader_outcome ?? presented?.reader_outcome;
  const generatedAt = document?.generated_at ?? presented?.generated_at;
  const observedThroughEventId =
    document?.source.observed_through_event_id ?? presented?.observed_through_event_id;
  const observedThroughTs = document?.source.observed_through_ts ?? presented?.observed_through_ts;
  const evidenceDigest = document?.source.evidence_digest ?? presented?.evidence_digest;
  const receipt = document?.receipt ?? presented?.receipt;
  const usage =
    document?.receipt && "usage" in document.receipt ? document.receipt.usage : presented?.usage;

  return (
    <Card className="border-purple-500/30">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Semantic record</CardTitle>
            <CardDescription className="mt-1">
              Model-synthesized meaning stays separate from direct and deterministic state.
            </CardDescription>
          </div>
          <Badge variant={presented?.state === "current" ? "accent" : "muted"}>
            {presented?.state ?? document?.reader_outcome ?? "unavailable"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {reader &&
        readerOutcome &&
        generatedAt &&
        observedThroughEventId &&
        observedThroughTs &&
        evidenceDigest ? (
          <>
            <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              <SummaryCell
                label="Reader outcome"
                value={readerOutcome}
                detail={readerAttestation(reader)}
              />
              <SummaryCell
                label="Reader"
                value={readerModel(reader)}
                detail={`${reader.harness} · configured ${reader.configured_model}`}
              />
              <SummaryCell
                label="Generated"
                value={<FormattedDateTime iso={generatedAt} />}
                detail={`through ${observedThroughEventId}`}
              />
              <SummaryCell
                label="Evidence digest"
                value={<BreakableMono text={evidenceDigest} className="text-xs" />}
                detail={
                  document
                    ? `ledger ${document.source.ledger_genesis_id}`
                    : "projected semantic channel"
                }
              />
            </div>

            {fields.length > 0 ? (
              <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {fields.map(([label, field]) => (
                  <Card key={label} className="min-w-0 gap-2 overflow-hidden p-3">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle>{humanize(label)}</CardTitle>
                        <Badge variant={field.basis === "prediction" ? "warning" : "accent"}>
                          {humanize(field.basis)}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <SignalValue value={field.value} />
                      <Badge variant="muted">{field.confidence} confidence</Badge>
                      <ReceiptLine
                        observedAt={field.observed_at ?? observedThroughTs}
                        eventIds={field.evidence_event_ids}
                      />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="mt-4">
                <EmptyState>This reader outcome carries no semantic meaning fields.</EmptyState>
              </div>
            )}

            <dl className="mt-4 grid gap-2 rounded-lg border border-border/50 p-3 text-xs md:grid-cols-2">
              <Fact
                label="Instance"
                value={document?.instance_id ?? panel?.instance_id ?? "—"}
                mono
              />
              {document && <Fact label="Generation" value={document.generation_id} mono />}
              {document && (
                <Fact label="Prompt contract" value={document.reader.prompt_contract_version} />
              )}
              <Fact
                label="Derived expiry"
                value={
                  presented?.expires_at ? <FormattedDateTime iso={presented.expires_at} /> : "—"
                }
              />
              {receipt && "reason_code" in receipt && (
                <Fact label="Receipt reason" value={humanize(receipt.reason_code)} />
              )}
              {receipt && "eligible_after" in receipt && (
                <Fact
                  label="Eligible after"
                  value={<FormattedDateTime iso={receipt.eligible_after} />}
                />
              )}
              {receipt && "validation_issue_codes" in receipt && (
                <Fact label="Validation issues" value={receipt.validation_issue_codes.join(", ")} />
              )}
              {usage && <Fact label="Usage receipt" value={<SignalValue value={usage} />} />}
            </dl>
          </>
        ) : (
          <EmptyState>No semantic document exists for this generation.</EmptyState>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="text-sm italic text-muted-foreground">{children}</p>;
}

function nameOf(instanceId: string, namesByInstance: Record<string, string>): string {
  return namesByInstance[instanceId] ?? instanceId;
}

function humanizeStructuredKey(value: string): string {
  const segments = value.split(".");
  if (segments[0] === "tokens") segments.shift();
  return segments
    .map((segment) =>
      segment === "value"
        ? "amount"
        : segment === "provenance"
          ? "source"
          : segment.replaceAll("_", " "),
    )
    .join(" › ");
}

function readerModel(
  reader: SemanticAgentReadModelV2["reader"] | NonNullable<CodecPanelScene["semantic"]>["reader"],
): string {
  return "resolved_model_id" in reader
    ? (reader.resolved_model_id ?? reader.configured_model)
    : reader.configured_model;
}

function readerAttestation(
  reader: SemanticAgentReadModelV2["reader"] | NonNullable<CodecPanelScene["semantic"]>["reader"],
): string {
  return "model_attestation" in reader
    ? (reader.model_attestation ?? "reader not attested")
    : "reader not attested";
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ");
}
