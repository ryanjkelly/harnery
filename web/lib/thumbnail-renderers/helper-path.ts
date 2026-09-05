import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Helpers are shipped as runtime files, never evaluated as TypeScript by Node. */
export function thumbnailHelperPath(name: "browser-worker.mjs" | "office-worker.py"): string {
  const directories = [
    path.join(process.cwd(), "lib", "thumbnail-renderers"),
    path.join(process.cwd(), "web", "lib", "thumbnail-renderers"),
    path.dirname(fileURLToPath(import.meta.url)),
  ];
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("thumbnail_worker_missing");
}
