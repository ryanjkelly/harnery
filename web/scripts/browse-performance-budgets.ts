export interface BrowsePerformanceSample {
  name: string;
  listingMs: number | null;
  firstDecodedMs: number | null;
  allDecodedMs: number | null;
  visible: number;
  decoded: number;
  thumbnailRequests: number;
  workspaceRequests: number;
  paletteRequests: number;
  uniqueRequestedFiles: number;
  errors: string[];
}

/** Latencies are configurable smoke ceilings, not cross-machine speed claims. */
export const defaultBudgets = {
  listingMs: 2_500,
  firstDecodedMs: 5_000,
  allDecodedMs: 10_000,
  maxRequests: 240,
  maxUniqueFiles: 100,
  maxRevisitRequests: 4,
};

export function checkBrowseSample(
  sample: BrowsePerformanceSample,
  budgets = defaultBudgets,
): string[] {
  const failures: string[] = [];
  if (!sample.visible || sample.decoded !== sample.visible)
    failures.push(`${sample.name}: visible thumbnails did not all decode`);
  if (sample.listingMs === null || sample.listingMs > budgets.listingMs)
    failures.push(`${sample.name}: listing exceeded ${budgets.listingMs} ms`);
  if (sample.firstDecodedMs === null || sample.firstDecodedMs > budgets.firstDecodedMs)
    failures.push(`${sample.name}: first decode exceeded ${budgets.firstDecodedMs} ms`);
  if (sample.allDecodedMs === null || sample.allDecodedMs > budgets.allDecodedMs)
    failures.push(`${sample.name}: decode exceeded ${budgets.allDecodedMs} ms`);
  if (sample.thumbnailRequests > budgets.maxRequests)
    failures.push(`${sample.name}: thumbnail requests exceeded ${budgets.maxRequests}`);
  if (sample.uniqueRequestedFiles > budgets.maxUniqueFiles)
    failures.push(`${sample.name}: offscreen work exceeded ${budgets.maxUniqueFiles} files`);
  if (sample.name === "same-document-back" && sample.thumbnailRequests > budgets.maxRevisitRequests)
    failures.push(`${sample.name}: revisit requests exceeded ${budgets.maxRevisitRequests}`);
  if (sample.workspaceRequests !== 0)
    failures.push(`${sample.name}: folder navigation requested the workspace catalog`);
  if (sample.paletteRequests !== 0)
    failures.push(`${sample.name}: folder navigation requested the unopened command palette`);
  failures.push(...sample.errors.map((error) => `${sample.name}: ${error}`));
  return failures;
}

export function positiveBudget(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid budget: ${value}`);
  return number;
}
