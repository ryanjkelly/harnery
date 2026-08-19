#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { docsMetadataV2Schema } from "../src/lib/docs-metadata-v2-schema.ts";

const target = join(import.meta.dir, "..", "schemas", "docs-metadata-v2.schema.json");
const docsTarget = join(
  import.meta.dir,
  "..",
  "docs",
  "src",
  "content",
  "docs",
  "reference",
  "markdown-metadata-v2.mdx",
);
const rendered = `${JSON.stringify(docsMetadataV2Schema, null, 2)}\n`;
const properties = docsMetadataV2Schema.properties as Record<
  string,
  { type?: string; const?: string; enum?: readonly string[] }
>;
const fieldRows = Object.entries(properties)
  .map(([name, schema]) => {
    const shape = schema.const
      ? `literal \`${schema.const}\``
      : schema.enum
        ? schema.enum.map((value) => `\`${value}\``).join(", ")
        : (schema.type ?? "profile-specific");
    return `| \`${name}\` | ${shape} |`;
  })
  .join("\n");
const profileRows = docsMetadataV2Schema.allOf
  .map((entry) => {
    const typeRule = entry.if.properties.type as { const?: string; enum?: readonly string[] };
    const types = typeRule.const ? [typeRule.const] : [...(typeRule.enum ?? [])];
    return `| ${types.map((type) => `\`${type}\``).join(", ")} | ${entry.then.required.map((field) => `\`${field}\``).join(", ")} |`;
  })
  .join("\n");
const docsRendered = `---
title: Markdown metadata v2
description: Generated field and profile reference for the harnery-doc/v2 contract.
sidebar:
  order: 8
---

This reference is generated from the JSON Schema. Edit the TypeScript schema
source and run \`bun run generate:docs-metadata-v2\` instead of editing this page.

## Fields

| Field | Shape |
|---|---|
${fieldRows}

## Profile requirements

Every document requires \`schema\`, \`type\`, \`created_at\`, \`updated_at\`, and
\`summary\`. These profiles add required fields:

| Types | Additional required fields |
|---|---|
${profileRows}
`;
if (process.argv.includes("--check")) {
  const stale = [
    [target, rendered],
    [docsTarget, docsRendered],
  ].filter(([path, expected]) => readFileSync(path, "utf8") !== expected);
  if (stale.length > 0) {
    console.error(`${stale.map(([path]) => path).join(", ")} is stale; regenerate it`);
    process.exit(1);
  }
} else {
  writeFileSync(target, rendered);
  writeFileSync(docsTarget, docsRendered);
  console.log([target, docsTarget].join("\n"));
}
