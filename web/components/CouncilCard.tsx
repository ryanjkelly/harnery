"use client";

import { ArrowUpRight, Check, Copy, FileText, PartyPopper, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AgentChip, AgentChipList } from "@/components/AgentChip";
import { FormattedDateTime } from "@/components/FormattedDateTime";
import { FilePath } from "@/components/file-viewer/FilePath";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import type { CouncilSummary } from "@/lib/coord-reader";

/**
 * Council list card. The card itself is inert, with an explicit "Open" link in
 * the header, so per-row Copy buttons and tooltip interactions don't collide
 * with a click target. Archived rows get a Delete button + confirm dialog inline.
 */
export function CouncilCard({
  council,
  archived,
}: {
  council: CouncilSummary;
  archived: boolean;
}) {
  const detailHref = `/councils/${encodeURIComponent(council.council_id)}${
    archived ? "?archived=1" : ""
  }`;
  const isTerminal = council.status !== "active";
  const stewardDiffers = !!council.steward && council.steward !== council.created_by;

  return (
    <Card className="hover:border-primary/40 transition-colors">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <CardTitle className="text-base font-mono break-all min-w-0 flex-1 normal-case tracking-normal text-foreground">
            {council.council_id}
          </CardTitle>
          <div className="flex items-center gap-1 shrink-0">
            <CopyIconButton
              value={council.council_id}
              title="Copy council ID to clipboard."
              ariaLabel="Copy council ID"
            />
            {archived && <DeleteIconButton councilId={council.council_id} />}
            <Link
              href={detailHref}
              className="inline-flex items-center gap-1 rounded bg-primary hover:bg-primary/85 text-primary-foreground h-7 px-2.5 text-xs"
            >
              Open
              <ArrowUpRight className="size-3" aria-hidden />
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-wrap mt-2">
          <Badge
            variant="outline"
            title={
              council.status === "active"
                ? "Council accepts mutations (contribute / advance / close)."
                : council.status === "closed"
                  ? "Read-only; deliberation finalized."
                  : "Moved to .harnery/councils/archive/ (terminal state)."
            }
          >
            {council.status}
          </Badge>
          {isTerminal ? (
            <>
              <Badge variant="muted">
                {council.current_round} round
                {council.current_round === 1 ? "" : "s"}
              </Badge>
              <Badge variant="default">
                {council.total_contributions} contribution
                {council.total_contributions === 1 ? "" : "s"}
              </Badge>
              {council.duration_label && (
                <Badge variant="outline" title="Wall-clock from convened → closed/archived.">
                  {council.duration_label}
                </Badge>
              )}
              {council.close_handoff_path && (
                <Badge
                  variant="success"
                  title="Close-out handoff exists: terminal state with a written artifact."
                >
                  <PartyPopper className="size-3" aria-hidden />
                  complete
                </Badge>
              )}
            </>
          ) : (
            <>
              <Badge variant="muted">
                round {council.current_round} {council.round_status}
              </Badge>
              <Badge variant="default">
                {council.contributors_in_current_round.length}/{council.members.length}
              </Badge>
            </>
          )}
          {council.auto_advance && (
            <Badge
              variant="outline"
              title="`council contribute` fires `advance` automatically once all members are in."
            >
              auto-advance
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm leading-relaxed line-clamp-3">{council.objective}</p>

        <div className="text-xs space-y-1">
          <MetaRow label="convened">
            <AgentChip name={council.created_by} />
            <span className="text-muted-foreground"> · </span>
            <span className="text-muted-foreground">
              <FormattedDateTime iso={council.created_at} />
            </span>
          </MetaRow>
          {stewardDiffers && council.steward && (
            <MetaRow label="steward">
              <AgentChip name={council.steward} />
            </MetaRow>
          )}
          <MetaRow label="members">
            <AgentChipList names={council.members} />
          </MetaRow>
          {council.target_doc && (
            <MetaRow label="target" copyValue={council.target_doc}>
              <span className="font-mono inline-flex items-center gap-1">
                <FileText className="size-3 shrink-0" aria-hidden />
                {council.target_doc}
              </span>
            </MetaRow>
          )}
          {council.closed_at && (
            <MetaRow label="closed">
              <span className="text-muted-foreground">
                <FormattedDateTime iso={council.closed_at} />
              </span>
            </MetaRow>
          )}
          {council.archived_at && (
            <MetaRow label="archived">
              <span className="text-muted-foreground">
                <FormattedDateTime iso={council.archived_at} />
              </span>
            </MetaRow>
          )}
          {council.close_handoff_path && (
            <MetaRow label="handoff" copyValue={council.close_handoff_path}>
              <span className="font-mono inline-flex items-center gap-1">
                <FileText className="size-3 shrink-0" aria-hidden />
                {/* council handoff path → clickable */}
                <FilePath path={council.close_handoff_path} className="font-mono" />
              </span>
            </MetaRow>
          )}
          {!archived && council.pending_in_current_round.length > 0 && (
            <MetaRow label="pending">
              <AgentChipList
                names={council.pending_in_current_round}
                className="text-muted-foreground"
              />
            </MetaRow>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MetaRow({
  label,
  children,
  copyValue,
}: {
  label: string;
  children: React.ReactNode;
  copyValue?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground/70 w-16 shrink-0">{label}</span>
      <span className="flex-1 min-w-0 break-all">{children}</span>
      {copyValue && (
        <CopyIconButton value={copyValue} title={`Copy ${label}`} ariaLabel={`Copy ${label}`} />
      )}
    </div>
  );
}

function CopyIconButton({
  value,
  title,
  ariaLabel,
}: {
  value: string;
  title: string;
  ariaLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip content={copied ? "Copied" : title}>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* ignore */
          }
        }}
        className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60"
        aria-label={ariaLabel}
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-400" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </Tooltip>
  );
}

function DeleteIconButton({ councilId }: { councilId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onConfirm = (): void => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/councils/${encodeURIComponent(councilId)}/delete`, {
          method: "POST",
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || !json.ok) {
          setError(json.error ?? `failed (HTTP ${res.status})`);
          return;
        }
        setOpen(false);
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  if (!open) {
    return (
      <Tooltip content="Permanently delete this archived council.">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/15"
          aria-label="Delete council"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </Tooltip>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className="text-destructive">Delete?</span>
      <Button type="button" variant="destructive" size="xs" onClick={onConfirm} disabled={busy}>
        {busy ? "…" : "yes"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => setOpen(false)}
        disabled={busy}
      >
        no
      </Button>
      {error && <span className="text-destructive">{error}</span>}
    </span>
  );
}
