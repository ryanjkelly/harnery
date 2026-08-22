/** Synthetic Codec choreography. This route never reads or streams live coordination state. */

import Link from "next/link";

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
        <header className={styles.codecHeader}>
          <div className={styles.headerTitleRow}>
            <span className={styles.headerBeaconReplay} aria-hidden />
            <p className={styles.headerKicker}>Non-live visual study</p>
            <h1 className={styles.codecTitle}>Codec replay</h1>
            <Link className={styles.rosterLink} href="/codec" prefetch={false}>
              Live Codec
            </Link>
          </div>
          <p className={styles.codecDeck}>
            Invented agents and events exercise delegation, dependencies, messages, blockers, and
            completions. Nothing here reports current team activity.
          </p>
        </header>
        <div className={styles.codecStage}>
          <CodecView initialScene={scene} mode="replay" replayPhases={phases} />
        </div>
      </main>
    </AgentChipProvider>
  );
}
