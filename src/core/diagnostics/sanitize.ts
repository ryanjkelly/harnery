const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|passwd|private[_-]?key|secret|session[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key)/i;
const OMITTED_CONTENT_KEY =
  /(?:^|[_-])(?:environment|env|prompt|prompts|tool[_-]?payload|tool[_-]?result|transcript|transcripts)(?:$|[_-])/i;
const HOME_PATH = /(?:[A-Za-z]:\\Users\\[^\\\s]+|\/home\/[^/\s]+|\/Users\/[^/\s]+)/g;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const TOKENISH_VALUE = /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[A-Z0-9]{16,}\b/g;
const SENSITIVE_QUERY = /([?&](?:access_token|api_key|key|password|secret|token)=)[^&#\s]+/gi;
const SENSITIVE_ENV = /(\b[A-Z0-9_]*(?:API_KEY|PASSWORD|SECRET|TOKEN)=)[^\s]+/g;
const SENSITIVE_ARGUMENT = /(\B--?(?:access-token|api-key|password|secret|token)\s+)[^\s]+/gi;

export interface SanitizationStats {
  sanitized_value_count: number;
  omitted_value_count: number;
}

export function sanitizeDiagnosticValue(value: unknown): {
  value: unknown;
  stats: SanitizationStats;
} {
  const stats: SanitizationStats = { sanitized_value_count: 0, omitted_value_count: 0 };
  return { value: sanitize(value, stats, 0), stats };
}

function sanitize(value: unknown, stats: SanitizationStats, depth: number): unknown {
  if (depth > 24) {
    stats.omitted_value_count += 1;
    return "[OMITTED:depth-limit]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeString(value, stats);
  if (Array.isArray(value)) {
    const sliced = value.slice(0, 5_000);
    const kept = sliced.map((item, index) => {
      if (
        typeof sliced[index - 1] === "string" &&
        /^(?:--?)(?:access-token|api-key|password|secret|token)$/i.test(sliced[index - 1] as string)
      ) {
        stats.sanitized_value_count += 1;
        return "[REDACTED:argument]";
      }
      return sanitize(item, stats, depth + 1);
    });
    if (kept.length !== value.length) stats.omitted_value_count += value.length - kept.length;
    return kept;
  }
  if (!value || typeof value !== "object") return String(value);

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value);
  const namedSensitiveField = entries.some(
    ([key, item]) => key === "name" && typeof item === "string" && SENSITIVE_KEY.test(item),
  );
  for (const [key, item] of entries) {
    if (OMITTED_CONTENT_KEY.test(key)) {
      result[key] = "[OMITTED:sensitive-content]";
      stats.omitted_value_count += 1;
      continue;
    }
    if (key === "value" && namedSensitiveField) {
      result[key] = "[REDACTED:sensitive-field]";
      stats.sanitized_value_count += 1;
      continue;
    }
    if (SENSITIVE_KEY.test(key)) {
      result[key] = "[REDACTED:sensitive-field]";
      stats.sanitized_value_count += 1;
      continue;
    }
    result[key] = sanitize(item, stats, depth + 1);
  }
  return result;
}

function sanitizeString(value: string, stats: SanitizationStats): string {
  let next = value;
  const replacements: Array<[RegExp, string | ((...args: string[]) => string)]> = [
    [PRIVATE_KEY, "[REDACTED:private-key]"],
    [BEARER_VALUE, "Bearer [REDACTED:token]"],
    [TOKENISH_VALUE, "[REDACTED:token]"],
    [AWS_ACCESS_KEY, "[REDACTED:access-key]"],
    [SENSITIVE_QUERY, "$1[REDACTED]"],
    [SENSITIVE_ENV, "$1[REDACTED]"],
    [SENSITIVE_ARGUMENT, "$1[REDACTED]"],
    [URL_CREDENTIALS, (_match, scheme: string) => `${scheme}[REDACTED]@`],
    [HOME_PATH, "[REDACTED:home]"],
  ];
  for (const [pattern, replacement] of replacements) {
    const replaced = next.replace(pattern, replacement as never);
    if (replaced !== next) stats.sanitized_value_count += 1;
    next = replaced;
  }
  return next;
}
