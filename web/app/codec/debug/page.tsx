/** Interactive synthetic harness for testing the real Codec view. */

import { AgentChipProvider } from "@/components/AgentChip";
import { CodecDebugLab } from "@/components/codec/CodecDebugLab";
import codecStyles from "@/components/codec/codec.module.css";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import { FALLBACK_PACK } from "@/lib/codec/contracts";
import type { CodecDebugAgent } from "@/lib/codec/debug-scene";
import { listPacks } from "@/lib/codec/packs";
import { COORD_NAMES } from "../../../../src/core/agents/state/names";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function CodecDebugPage() {
  const packs = listPacks();
  const agents: CodecDebugAgent[] = COORD_NAMES.slice(0, 52).map((name, index) => {
    const pack = packs[index] ?? FALLBACK_PACK;
    return {
      id: `debug-agent-${index + 1}`,
      name,
      packId: pack.pack_id,
      packVersion: pack.pack_version,
    };
  });
  const summaries = buildAgentSummaryMap(agents.map((agent) => agent.name));

  return (
    <AgentChipProvider summaries={summaries}>
      <main className={codecStyles.codecPage} data-codec-debug-page>
        <div className={codecStyles.pageGrid} aria-hidden />
        <CodecDebugLab agents={agents} />
      </main>
    </AgentChipProvider>
  );
}
