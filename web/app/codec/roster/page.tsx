import Link from "next/link";

import styles from "@/components/codec/codecRoster.module.css";
import { listPacks, REQUIRED_EXPRESSIONS, readPackRegistry } from "@/lib/codec/packs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function CodecRosterPage() {
  const packs = listPacks();
  const registry = readPackRegistry();
  const activeBindings = registry.bindings.filter((binding) => !binding.released_at);

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
          <span>{REQUIRED_EXPRESSIONS.length} expressions each</span>
          <span>{activeBindings.length} active bindings</span>
          <Link href="/codec" prefetch={false}>
            Return to live Codec
          </Link>
        </div>
      </header>

      {packs.length === 0 ? (
        <p className={styles.empty}>No complete character packs are installed.</p>
      ) : (
        <section data-codec-roster className={styles.packStack} aria-label="Codec character packs">
          {packs.map((pack) => {
            const bound = activeBindings.filter((binding) => binding.pack_id === pack.pack_id);
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
                      <dt>Live</dt>
                      <dd>{bound.length}</dd>
                    </div>
                  </dl>
                </header>

                <div className={styles.expressionGrid}>
                  {REQUIRED_EXPRESSIONS.map((expression) => (
                    <figure
                      data-codec-expression={expression}
                      className={styles.expression}
                      key={expression}
                    >
                      {/* biome-ignore lint/performance/noImgElement: runtime packs are already optimized WebP assets */}
                      <img
                        src={`/api/codec-pack/${pack.pack_id}/${expression}?v=${pack.pack_version}`}
                        alt={`${pack.pack_id} character with ${expression} expression`}
                        width={512}
                        height={512}
                        loading="eager"
                        decoding="async"
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
