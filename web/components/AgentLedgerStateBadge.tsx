import { Badge } from "@/components/ui/badge";
import type { AgentLedgerStateV2 } from "@/lib/coord-reader";

const COPY: Record<
  AgentLedgerStateV2,
  { label: string; variant: "muted" | "info" | "success"; hint: string }
> = {
  live: {
    label: "live",
    variant: "muted",
    hint: "The current ledger generation is live.",
  },
  ending: {
    label: "ending",
    variant: "muted",
    hint: "A session-finalization request is pending; wait for the ledger terminal.",
  },
  "recovery-required": {
    label: "recovery required",
    variant: "info",
    hint: "Tool spans remain open after the turn closed; this generation needs recovery.",
  },
  terminal: {
    label: "terminal",
    variant: "success",
    hint: "The ledger contains the authoritative session terminal.",
  },
};

export function AgentLedgerStateBadge({ state }: { state: AgentLedgerStateV2 }) {
  const copy = COPY[state];
  return (
    <Badge variant={copy.variant} title={copy.hint}>
      {copy.label}
    </Badge>
  );
}
