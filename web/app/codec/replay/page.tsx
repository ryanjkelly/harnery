/** Synthetic Codec choreography. This route never reads or streams live coordination state. */

import { AgentChipProvider } from "@/components/AgentChip";
import { CodecView } from "@/components/codec/CodecView";
import styles from "@/components/codec/codec.module.css";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import { createCodecReplayPhases } from "@/lib/codec/replay-scene";

export default function CodecReplayPage() {
  const phases = createCodecReplayPhases();
  const scene = phases[0]?.scene;
  if (!scene) return null;
  const summaries = buildAgentSummaryMap(scene.panels.map((panel) => panel.identity.display_name));

  return (
    <AgentChipProvider summaries={summaries}>
      <main className={styles.codecPage} data-codec-replay-page>
        <div className={styles.pageGrid} aria-hidden />
        <div className={styles.codecStage}>
          <CodecView initialScene={scene} mode="replay" replayPhases={phases} />
        </div>
      </main>
    </AgentChipProvider>
  );
}
