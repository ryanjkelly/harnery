/**
 * Codec visual director — Phase 1 experimental view (truth-first projection).
 *
 * Server component: builds the initial sanitized scene on the server so the
 * page renders complete without JS, then hands live updates to the CodecView
 * client leaf (SSE with polling fallback). Read-only by contract; there are
 * no control affordances on this surface and never will be (see the host
 * repo's Codec visual-director plan).
 */

import Link from "next/link";

import { AgentChipProvider } from "@/components/AgentChip";
import { CodecView } from "@/components/codec/CodecView";
import styles from "@/components/codec/codec.module.css";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import { buildScene } from "@/lib/codec/scene-source";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CodecPage() {
  const scene = await buildScene();
  const summaries = buildAgentSummaryMap(scene.panels.map((p) => p.identity.display_name));

  return (
    <AgentChipProvider summaries={summaries}>
      <main className={styles.codecPage}>
        <div className={styles.pageGrid} aria-hidden />
        <header className={styles.codecHeader}>
          <div className={styles.headerTitleRow}>
            <span className={styles.headerBeacon} aria-hidden />
            <p className={styles.headerKicker}>Live agent director</p>
            <h1 className={styles.codecTitle}>Codec</h1>
            <Link className={styles.rosterLink} href="/codec/roster" prefetch={false}>
              Roster lab
            </Link>
          </div>
          <p className={styles.codecDeck}>
            A read-only, ledger-backed view of the team in motion. Local intent stays on this
            machine; the dashboard remains the control surface.
          </p>
        </header>
        <div className={styles.codecStage}>
          <CodecView initialScene={scene} />
        </div>
      </main>
    </AgentChipProvider>
  );
}
