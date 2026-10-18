import { createHash } from "node:crypto";

const HOME_PATH =
  /(?:[A-Za-z]:[\\/]Users[\\/](?:[^\\/\r\n\0:"<>|]+(?=[\\/])|[^\\/\s\0:]+)|\/home\/[^/\s\0:]+|\/Users\/[^/\s\0:]+)/g;

/** One stable representation for private home paths in values and identity inputs. */
export function canonicalizeDiagnosticIdentity(value: string): string {
  return value.replace(HOME_PATH, (home) => {
    const digest = createHash("sha256")
      .update("harnery-diagnostic-home-v1\0")
      .update(home)
      .digest("hex");
    return `[REDACTED:home:${digest}]`;
  });
}
