import { registerThumbnailPreview } from "../lib/thumbnail-reuse";

const args = process.argv.slice(2);
if (args.includes("--help") || !args.length) {
  console.log(`Register a verified raster capture for a finished artifact source.
Usage: bun web/scripts/thumbnail-register-preview.ts --root <repository> --source <repo-relative-file> --preview <repo-relative-raster>
Both files must belong to the same artifact workspace. The command writes a
hidden .thumbnail-preview-<source-hash>.json sidecar in that workspace.
Schema 1 records canonical source/preview paths and checked file versions;
source.dependencies also binds the local HTML/CSS asset graph. Changes to
source, preview, dependencies, or file policy invalidate reuse automatically.
Registration requires a descriptor-directory filesystem (/proc/self/fd or /dev/fd).
Only call after the producing pipeline verifies this capture matches the source.`);
} else {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (
      !["--root", "--source", "--preview"].includes(args[index]) ||
      !args[index + 1] ||
      options.has(args[index])
    )
      throw new Error("Expected --root, --source and --preview exactly once");
    options.set(args[index], args[index + 1]);
  }
  const root = options.get("--root");
  const source = options.get("--source");
  const preview = options.get("--preview");
  if (!root || !source || !preview) throw new Error("Missing --root, --source or --preview");
  console.log(await registerThumbnailPreview(source, preview, { root }));
}
