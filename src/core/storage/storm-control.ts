import { createHash } from "node:crypto";
import type { HarneryLogLevel } from "./contract.ts";

export interface HarneryStormSummary {
  key: string;
  count: number;
  represented_bytes: number;
  first_emitted_at: string;
  last_emitted_at: string;
  exemplar_digests: readonly string[];
}

export interface ProcessStormControllerOptions {
  enabled: boolean;
  window_ms: number;
  max_exemplars: number;
  burst?: number;
  now?: () => number;
}

interface Bucket {
  started: number;
  admitted: number;
  dropped: number;
  representedBytes: number;
  first: string;
  last: string;
  exemplars: string[];
}

export class ProcessStormController {
  readonly #options: Required<ProcessStormControllerOptions>;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: ProcessStormControllerOptions) {
    this.#options = { ...options, burst: options.burst ?? 100, now: options.now ?? Date.now };
  }

  admit(key: string, level: HarneryLogLevel, bytes: number): boolean {
    if (!this.#options.enabled || level === "error" || level === "fatal") return true;
    const now = this.#options.now();
    let bucket = this.#buckets.get(key);
    if (!bucket || now - bucket.started >= this.#options.window_ms) {
      bucket = {
        started: now,
        admitted: 0,
        dropped: 0,
        representedBytes: 0,
        first: new Date(now).toISOString(),
        last: new Date(now).toISOString(),
        exemplars: [],
      };
      this.#buckets.set(key, bucket);
    }
    if (bucket.admitted < this.#options.burst) {
      bucket.admitted += 1;
      return true;
    }
    bucket.dropped += 1;
    bucket.representedBytes += bytes;
    bucket.last = new Date(now).toISOString();
    const digest = createHash("sha256").update(`${key}:${bytes}`).digest("hex").slice(0, 16);
    if (
      bucket.exemplars.length < this.#options.max_exemplars &&
      !bucket.exemplars.includes(digest)
    ) {
      bucket.exemplars.push(digest);
    }
    return false;
  }

  drainSummaries(force = false): HarneryStormSummary[] {
    const now = this.#options.now();
    const summaries: HarneryStormSummary[] = [];
    for (const [key, bucket] of this.#buckets) {
      if (!force && now - bucket.started < this.#options.window_ms) continue;
      if (bucket.dropped > 0) {
        summaries.push({
          key,
          count: bucket.dropped,
          represented_bytes: bucket.representedBytes,
          first_emitted_at: bucket.first,
          last_emitted_at: bucket.last,
          exemplar_digests: bucket.exemplars,
        });
      }
      this.#buckets.delete(key);
    }
    return summaries;
  }
}
