import Link from "next/link";

import styles from "@/components/codec/codecRoster.module.css";
import {
  listPacks,
  ROSTER_EXPRESSIONS,
  ROSTER_SPRITE_COLUMNS,
  ROSTER_SPRITE_ROWS,
  ROSTER_SPRITE_TILE_HEIGHT,
  ROSTER_SPRITE_TILE_WIDTH,
  readPackRegistry,
  summarizePackRoster,
} from "@/lib/codec/packs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function CodecRosterPage() {
  const packs = listPacks();
  const registry = readPackRegistry();
  const summary = summarizePackRoster(packs, registry);

  return (
    <main className={styles.rosterPage}>
      <div className={styles.pageGlow} aria-hidden />
      <header className={styles.rosterHeader}>
        <div>
          <p className={styles.kicker}>Character system</p>
          <h1>Codec roster lab</h1>
          <p className={styles.deck}>
            Every live portrait state, shown at the same narrow crop the agent cards use. Packs
            remain ahead-of-demand presentation assets; this page never generates or controls agent
            work.
          </p>
        </div>
        <div className={styles.headerStats}>
          <span>{packs.length} complete packs</span>
          <span>{ROSTER_EXPRESSIONS.length} expressions each</span>
          <span>{summary.active_bindings.length} active bindings</span>
          <Link href="/codec" prefetch={false}>
            Return to live Codec
          </Link>
        </div>
      </header>

      <section
        data-codec-roster-operations
        className={styles.operations}
        aria-labelledby="roster-operations-title"
      >
        <header className={styles.operationsHeader}>
          <div>
            <p className={styles.kicker}>Operational view</p>
            <h2 id="roster-operations-title">Roster coverage</h2>
          </div>
          <span data-coverage={summary.coverage} className={styles.coverageState}>
            {summary.coverage === "ready"
              ? "reserve ready"
              : summary.coverage === "at-capacity"
                ? "at capacity"
                : "needs attention"}
          </span>
        </header>

        <div className={styles.operationGrid}>
          <article>
            <p>Capacity</p>
            <strong>
              {summary.active_bindings.length} assigned · {summary.reserve_pack_ids.length} reserve
            </strong>
            <span>
              {summary.orphaned_bindings.length > 0
                ? `${summary.orphaned_bindings.length} active bindings point to missing or changed packs.`
                : "Every active binding resolves to its installed pack version."}
            </span>
          </article>
          <article>
            <p>Active assignments</p>
            {summary.active_bindings.length === 0 ? (
              <strong>None right now</strong>
            ) : (
              <ul className={styles.bindingList}>
                {summary.active_bindings.map((binding) => (
                  <li key={`${binding.instance_id}:${binding.bound_at}`}>
                    <code>{shortInstanceId(binding.instance_id)}</code>
                    <span>→</span>
                    <strong>{binding.pack_id}</strong>
                  </li>
                ))}
              </ul>
            )}
          </article>
          <article>
            <p>Binding history</p>
            <strong>{summary.released_bindings.length} released assignments retained</strong>
            <span>
              The registry is append-only: released characters return to the reserve pool without
              rewriting their session history.
            </span>
          </article>
        </div>
      </section>

      {packs.length === 0 ? (
        <p className={styles.empty}>No complete character packs are installed.</p>
      ) : (
        <section data-codec-roster className={styles.packStack} aria-label="Codec character packs">
          {packs.map((pack, packIndex) => {
            const bound = summary.active_bindings.filter(
              (binding) => binding.pack_id === pack.pack_id,
            );
            const historicalUses = summary.historical_uses_by_pack[pack.pack_id] ?? 0;
            return (
              <article data-codec-pack={pack.pack_id} className={styles.pack} key={pack.pack_id}>
                <header className={styles.packHeader}>
                  <div>
                    <p className={styles.packIdentity}>
                      <span>{pack.pack_id}</span>
                      <small>v{pack.pack_version}</small>
                    </p>
                    <p className={styles.character}>
                      {pack.character ?? "Original Codec character"}
                    </p>
                    <div className={styles.packAssignment} data-assigned={bound.length > 0}>
                      <span>{bound.length > 0 ? "assigned" : "reserve"}</span>
                      {bound.map((binding) => (
                        <code key={binding.instance_id}>
                          {shortInstanceId(binding.instance_id)}
                        </code>
                      ))}
                    </div>
                  </div>
                  <dl className={styles.packMeta}>
                    <div>
                      <dt>Style</dt>
                      <dd>{pack.style ?? "unspecified"}</dd>
                    </div>
                    <div>
                      <dt>Palette</dt>
                      <dd>{pack.palette ?? "unspecified"}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>
                        {pack.generated_with ?? "unknown"}
                        {pack.quality ? ` · ${pack.quality}` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Use</dt>
                      <dd>
                        {bound.length} live · {historicalUses} total
                      </dd>
                    </div>
                  </dl>
                </header>

                <div className={styles.expressionGrid}>
                  {ROSTER_EXPRESSIONS.map((expression, expressionIndex) => (
                    <figure
                      data-codec-expression={expression}
                      className={styles.expression}
                      key={expression}
                    >
                      {/* biome-ignore lint/performance/noImgElement: runtime packs are already optimized WebP assets */}
                      <img
                        className={styles.expressionSprite}
                        src={`/api/codec-pack/${pack.pack_id}/sprite?v=${pack.pack_version}`}
                        alt={`${pack.pack_id} character with ${expression} expression`}
                        width={ROSTER_SPRITE_COLUMNS * ROSTER_SPRITE_TILE_WIDTH}
                        height={ROSTER_SPRITE_ROWS * ROSTER_SPRITE_TILE_HEIGHT}
                        loading={packIndex === 0 ? "eager" : "lazy"}
                        fetchPriority={packIndex === 0 ? "high" : "low"}
                        decoding="async"
                        style={{
                          transform: `translate3d(-${(expressionIndex % ROSTER_SPRITE_COLUMNS) * (100 / ROSTER_SPRITE_COLUMNS)}%, -${Math.floor(expressionIndex / ROSTER_SPRITE_COLUMNS) * (100 / ROSTER_SPRITE_ROWS)}%, 0)`,
                        }}
                      />
                      <figcaption>{expression}</figcaption>
                    </figure>
                  ))}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}

function shortInstanceId(instanceId: string): string {
  if (instanceId.length <= 14) return instanceId;
  return `${instanceId.slice(0, 7)}…${instanceId.slice(-5)}`;
}
