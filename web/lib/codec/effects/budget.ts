import type { CodecEffectCue } from "./contracts";

export interface CodecEffectBudgetOptions {
  maxConcurrent: number;
  seenLimit?: number;
}

/** Bounds visual work independently from the event rate. Scene state still
 * updates when an effect is deduplicated or dropped by the visual budget. */
export class CodecEffectBudget {
  readonly #active = new Map<string, CodecEffectCue>();
  readonly #seen = new Map<string, true>();
  readonly #maxConcurrent: number;
  readonly #seenLimit: number;

  constructor(options: CodecEffectBudgetOptions) {
    this.#maxConcurrent = Math.max(1, options.maxConcurrent);
    this.#seenLimit = Math.max(this.#maxConcurrent, options.seenLimit ?? 500);
  }

  start(cue: CodecEffectCue): boolean {
    if (this.#seen.has(cue.id)) return false;
    this.#remember(cue.id);
    if (this.#active.size >= this.#maxConcurrent) return false;
    if (
      [...this.#active.values()].some((active) => active.targetInstanceId === cue.targetInstanceId)
    ) {
      return false;
    }
    this.#active.set(cue.id, cue);
    return true;
  }

  finish(id: string): void {
    this.#active.delete(id);
  }

  clearActive(): void {
    this.#active.clear();
  }

  get activeCount(): number {
    return this.#active.size;
  }

  #remember(id: string): void {
    this.#seen.set(id, true);
    while (this.#seen.size > this.#seenLimit) {
      const oldest = this.#seen.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#seen.delete(oldest);
    }
  }
}
