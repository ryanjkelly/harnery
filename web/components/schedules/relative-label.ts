/**
 * Relative time words for the Schedules page. Kept apart from `lib/schedules.ts`
 * (which shells the CLI) so the client clock can import it.
 */

function span(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours < 3 && rest > 0) return `${hours} hr ${rest} min`;
  if (hours < 48) return `${Math.round(min / 60)} hr`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} days`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months} months`;
  return `${Math.round(days / 365)} years`;
}

/** "in 4 min", "3 min ago", "in 1 hr 20 min", "2 days ago"; "now" inside a minute. */
export function relativeLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = t - now;
  if (Math.abs(diff) < 60_000) return diff >= 0 ? "in under a min" : "just now";
  const text = span(Math.abs(diff));
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}
