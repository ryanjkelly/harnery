/**
 * Codec visual director — Phase 1 experimental view (truth-first projection).
 *
 * Server component: builds the initial sanitized scene on the server so the
 * page renders complete without JS, then hands live updates to the CodecView
 * client leaf (SSE with polling fallback). Read-only by contract; there are
 * no control affordances on this surface and never will be (see the host
 * repo's Codec visual-director plan).
 */

import { AgentChipProvider } from "@/components/AgentChip";
import { CodecView } from "@/components/codec/CodecView";
import { buildAgentSummaryMap } from "@/lib/agent-summary";
import { buildScene } from "@/lib/codec/scene-source";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CodecPage() {
  const scene = await buildScene();
  const summaries = buildAgentSummaryMap(scene.panels.map((p) => p.identity.display_name));

  return (
    <AgentChipProvider summaries={summaries}>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-5 flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Codec</h1>
            <p className="text-sm text-muted-foreground">
              Read-only presentation of live agent activity. Experimental; the{" "}
              dashboard remains the control surface.
            </p>
          </div>
        </header>
        <CodecView initialScene={scene} />
      </main>
    </AgentChipProvider>
  );
}
