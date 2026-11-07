/**
 * Byte formatters shared by the dashboard. Pick one by context instead of
 * writing another local copy.
 */

/** File size for viewers and trees: `512 B`, `3.4 KB`, `12.0 MB`. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Binary-unit size for capacity and diagnostics: `812 B`, `4.2 GiB`, `17 TiB`. Null reads "Unknown". */
export function formatBytes(value: number | null): string {
  if (value === null) return "Unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
