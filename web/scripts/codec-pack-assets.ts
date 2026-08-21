#!/usr/bin/env bun

/**
 * Prepare generated Codec portraits for the runtime pack roster.
 *
 * Generation stays outside the live dashboard. This tool validates one
 * complete source set, makes 512px web assets, writes manifests, and only
 * installs after every staged pack passes the same validator as the server.
 * Existing packs move to a recoverable archive instead of being deleted.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

import { REQUIRED_EXPRESSIONS, validatePackDir } from "../lib/codec/packs";

interface ArtDirectionSpec {
  schema_version: 1;
  style_id: string;
  pack_version: string;
  generated_with: string;
  quality: string;
  prompt_base: string;
  expression_prompts: Record<string, string>;
  output: {
    size: number;
    webp_quality: number;
  };
  packs: Array<{
    pack_id: string;
    character: string;
    palette: string;
  }>;
}

interface Args {
  spec?: string;
  source?: string;
  target?: string;
  install: boolean;
}

const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseArgs(argv: string[]): Args {
  const out: Args = { install: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--install") {
      out.install = true;
      continue;
    }
    if (arg === "--spec" || arg === "--source" || arg === "--target") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      out[arg.slice(2) as "spec" | "source" | "target"] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function readSpec(filePath: string): ArtDirectionSpec {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ArtDirectionSpec;
  if (
    parsed.schema_version !== 1 ||
    !parsed.style_id ||
    !parsed.pack_version ||
    !parsed.generated_with ||
    !parsed.prompt_base ||
    !Array.isArray(parsed.packs) ||
    !Number.isInteger(parsed.output?.size) ||
    parsed.output.size < 256 ||
    parsed.output.size > 2048 ||
    !Number.isInteger(parsed.output?.webp_quality) ||
    parsed.output.webp_quality < 1 ||
    parsed.output.webp_quality > 100
  ) {
    throw new Error("invalid art-direction spec");
  }
  for (const expression of REQUIRED_EXPRESSIONS) {
    if (expression !== "neutral" && !parsed.expression_prompts?.[expression]) {
      throw new Error(`missing expression prompt: ${expression}`);
    }
  }
  for (const pack of parsed.packs) {
    if (!PACK_ID.test(pack.pack_id) || !pack.character || !pack.palette) {
      throw new Error(`invalid pack spec: ${pack.pack_id || "unnamed"}`);
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.spec || !args.source || !args.target) {
    throw new Error(
      "usage: codec-pack-assets --spec <art-direction.json> --source <generated-root> --target <runtime-packs> [--install]",
    );
  }

  const specPath = path.resolve(args.spec);
  const sourceRoot = path.resolve(args.source);
  const targetRoot = path.resolve(args.target);
  const codecRoot = path.dirname(targetRoot);
  const spec = readSpec(specPath);
  const stageRoot = path.join(codecRoot, `.pack-stage-${process.pid}`);
  const expressions = Object.fromEntries(
    REQUIRED_EXPRESSIONS.map((expression) => [expression, `${expression}.webp`]),
  );

  if (fs.existsSync(stageRoot)) {
    throw new Error(`staging path already exists: ${stageRoot}`);
  }
  fs.mkdirSync(stageRoot, { recursive: true });

  const prepared: Array<{ pack_id: string; bytes: number }> = [];
  try {
    for (const pack of spec.packs) {
      const sourceDir = path.join(sourceRoot, pack.pack_id);
      const stageDir = path.join(stageRoot, pack.pack_id);
      fs.mkdirSync(stageDir, { recursive: true });
      let bytes = 0;

      for (const expression of REQUIRED_EXPRESSIONS) {
        const input = path.join(sourceDir, `${expression}.webp`);
        const output = path.join(stageDir, `${expression}.webp`);
        if (!fs.existsSync(input)) throw new Error(`${pack.pack_id}: missing ${expression}.webp`);
        await sharp(input)
          .resize(spec.output.size, spec.output.size, { fit: "cover", position: "centre" })
          .webp({ quality: spec.output.webp_quality, effort: 6, smartSubsample: true })
          .toFile(output);
        bytes += fs.statSync(output).size;
      }

      fs.writeFileSync(
        path.join(stageDir, "pack.json"),
        `${JSON.stringify(
          {
            schema_version: 1,
            pack_id: pack.pack_id,
            pack_version: spec.pack_version,
            style: spec.style_id,
            character: pack.character,
            palette: pack.palette,
            generated_with: spec.generated_with,
            quality: spec.quality,
            prompt_base: spec.prompt_base,
            expressions,
          },
          null,
          2,
        )}\n`,
      );

      const validation = validatePackDir(stageDir);
      if (!validation.ok) {
        throw new Error(`${pack.pack_id}: ${validation.problems.join("; ")}`);
      }
      prepared.push({ pack_id: pack.pack_id, bytes });
    }

    if (!args.install) {
      console.log(JSON.stringify({ ok: true, install: false, prepared }, null, 2));
      return;
    }

    fs.mkdirSync(targetRoot, { recursive: true });
    const archiveRoot = path.join(
      codecRoot,
      "pack-archive",
      `${spec.style_id}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    fs.mkdirSync(archiveRoot, { recursive: true });

    for (const pack of spec.packs) {
      const targetDir = path.join(targetRoot, pack.pack_id);
      if (fs.existsSync(targetDir)) {
        fs.renameSync(targetDir, path.join(archiveRoot, pack.pack_id));
      }
      fs.renameSync(path.join(stageRoot, pack.pack_id), targetDir);
    }
    fs.copyFileSync(specPath, path.join(codecRoot, "art-direction.json"));
    console.log(
      JSON.stringify(
        { ok: true, install: true, style: spec.style_id, archive: archiveRoot, prepared },
        null,
        2,
      ),
    );
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

await main();
