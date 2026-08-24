import Link from "next/link";

import { CodecComprehensionStudy } from "@/components/codec/CodecComprehensionStudy";
import styles from "@/components/codec/codecComprehension.module.css";
import {
  publicCodecComprehensionStudy,
  readCodecComprehensionCohort,
} from "@/lib/codec/comprehension";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function CodecEvaluatePage() {
  const cohort = readCodecComprehensionCohort();
  if (!cohort) {
    return (
      <main className={styles.studyPage}>
        <div className={styles.pageGrid} aria-hidden />
        <section className={styles.introPanel}>
          <p className={styles.kicker}>Blinded portrait check</p>
          <h1>No prepared cohort is available.</h1>
          <p className={styles.deck}>
            This test starts only from a privacy-safe cohort of accepted semantic readings. Codec
            remains available while the cohort is prepared.
          </p>
          <Link className={styles.backLink} href="/codec" prefetch={false}>
            Return to Codec
          </Link>
        </section>
      </main>
    );
  }
  return <CodecComprehensionStudy study={publicCodecComprehensionStudy(cohort)} />;
}
