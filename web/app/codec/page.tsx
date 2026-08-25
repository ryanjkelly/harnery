/**
 * Codec visual director — Phase 1 experimental view (truth-first projection).
 *
 * Server component: builds the initial sanitized scene on the server so the
 * page renders complete without JS, then hands live updates to the CodecView
 * client leaf (SSE with polling fallback). Read-only by contract; there are
 * presentation controls on this surface never mutate the underlying ledger
 * or coordination state (see the host repo's Codec visual-director plan).
 */

import { AgentChipProvider } from "@/components/AgentChip";
import { CodecView } from "@/components/codec/CodecView";
import styles from "@/components/codec/codec.module.css";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import { getSharedCodecScene } from "@/lib/codec/scene-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CodecPage() {
  const scene = await getSharedCodecScene();
  const summaries = buildAgentSummaryMap(scene.panels.map((p) => p.identity.display_name));

  return (
    <AgentChipProvider summaries={summaries}>
      <main className={styles.codecPage}>
        <div className={styles.pageGrid} aria-hidden />
        <div className={styles.codecStage}>
          <CodecView initialScene={scene} />
        </div>
      </main>
    </AgentChipProvider>
  );
}
