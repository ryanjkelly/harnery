const timestamp = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$",
};
const stringList = { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true };

/** Editor-facing JSON Schema. The TypeScript validator remains authoritative. */
export const docsMetadataV2Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://harnery.com/schemas/docs-metadata-v2.schema.json",
  title: "Harnery Markdown metadata v2",
  type: "object",
  required: ["schema", "type", "created_at", "updated_at", "summary"],
  properties: {
    schema: { const: "harnery-doc/v2" },
    type: { enum: DOCS_METADATA_TYPES },
    created_at: timestamp,
    updated_at: timestamp,
    owner: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    summary: { type: "string", minLength: 1 },
    tags: { ...stringList, items: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } },
    relations: {
      type: "object",
      properties: Object.fromEntries(
        ["depends_on", "supersedes", "superseded_by", "continues", "related"].map((key) => [
          key,
          stringList,
        ]),
      ),
      additionalProperties: false,
    },
    access: {
      type: "object",
      properties: { roles: stringList, viewers: stringList },
      additionalProperties: false,
    },
    status: { type: "string" },
    status_changed_at: timestamp,
    status_note: { type: "string", minLength: 1 },
    severity: { enum: ["low", "medium", "high", "critical"] },
    resolved_at: timestamp,
    affected: stringList,
    resolution: {
      type: "object",
      required: ["outcome"],
      properties: { outcome: { type: "string", minLength: 1 }, commits: stringList },
      additionalProperties: false,
    },
    title: { type: "string", minLength: 1 },
    audience: { type: "string", minLength: 1 },
    source: { type: "string", minLength: 1 },
    reviewed_at: timestamp,
    review_due_at: timestamp,
    category: { type: "string", minLength: 1 },
    aliases: stringList,
    source_count: { type: "integer", minimum: 0 },
    provenance: {
      type: "object",
      required: ["sources"],
      properties: { sources: stringList },
      additionalProperties: false,
    },
    primary_entity: { type: "string" },
    source_pages: {},
    source_tokens: {},
    top_entities: stringList,
    handle: { type: "string", minLength: 1 },
    published: { type: "boolean" },
    source_updated_at: timestamp,
    source_id: { type: "string", minLength: 1 },
    source_template: { type: "string", minLength: 1 },
    product: {},
    variant: {},
    sku: {},
    manufacturer: {},
    customer: {},
    bid_id: {},
    drive_file_id: {},
    drive_title: {},
    quote_date: {},
    revision: {},
    batch_size: {},
    order_size: {},
    price: {},
    source_pdf: {},
    claims: {},
    week: {},
    coverage: {},
  },
  patternProperties: { "^x_": {} },
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { type: { const: "plan" } }, required: ["type"] },
      then: {
        required: ["status", "status_changed_at", "owner"],
        properties: { status: { enum: ["proposed", "in-progress", "shipped", "abandoned"] } },
      },
    },
    {
      if: { properties: { type: { const: "issue" } }, required: ["type"] },
      then: {
        required: ["status", "status_changed_at", "owner", "severity"],
        properties: { status: { enum: ["open", "resolved", "wontfix"] } },
      },
    },
    {
      if: { properties: { type: { const: "handoff" } }, required: ["type"] },
      then: {
        required: ["status", "status_changed_at", "owner"],
        properties: { status: { enum: ["open", "resolved", "abandoned"] } },
      },
    },
    {
      if: { properties: { type: { const: "runbook" } }, required: ["type"] },
      then: { required: ["owner", "reviewed_at", "review_due_at"] },
    },
    {
      if: {
        properties: { type: { enum: ["book", "entity", "concept", "query", "page"] } },
        required: ["type"],
      },
      then: { required: ["title", "category", "source_count", "provenance"] },
    },
    {
      if: { properties: { type: { const: "synced-page" } }, required: ["type"] },
      then: { required: ["title", "handle", "published", "source", "source_updated_at"] },
    },
  ],
};
import { DOCS_METADATA_TYPES } from "./docs-metadata-v2.ts";
