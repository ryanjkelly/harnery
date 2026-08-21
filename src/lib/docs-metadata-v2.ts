export const DOCS_METADATA_SCHEMA_V2 = "harnery-doc/v2";

export const DOCS_METADATA_TYPES = [
  "plan",
  "issue",
  "handoff",
  "runbook",
  "topic",
  "audit",
  "book",
  "entity",
  "concept",
  "query",
  "page",
  "inquiry",
  "quote-sheet",
  "weekly-post",
  "synced-page",
] as const;

export type DocsMetadataType = (typeof DOCS_METADATA_TYPES)[number];

export type DocsMetadataProfile =
  | "lifecycle"
  | "runbook"
  | "wiki"
  | "synced"
  | "quote-sheet"
  | "weekly-post"
  | "inquiry"
  | "general";

export interface DocsMetadataValidationIssue {
  severity: "error" | "warning";
  code: string;
  field: string;
  message: string;
}

export interface DocsMetadataValidationResult {
  valid: boolean;
  profile: DocsMetadataProfile | null;
  issues: DocsMetadataValidationIssue[];
}

const RFC3339_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PLAN_STATUSES = new Set(["proposed", "in-progress", "shipped", "abandoned"]);
const ISSUE_STATUSES = new Set(["open", "resolved", "wontfix"]);
const HANDOFF_STATUSES = new Set(["open", "resolved", "abandoned"]);
const ISSUE_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const LIFECYCLE_TYPES = new Set<DocsMetadataType>(["plan", "issue", "handoff"]);
const WIKI_TYPES = new Set<DocsMetadataType>(["book", "entity", "concept", "query", "page"]);
const SUPPORTED_TYPES = new Set<DocsMetadataType>(DOCS_METADATA_TYPES);

const BASE_FIELDS = new Set([
  "schema",
  "type",
  "created_at",
  "updated_at",
  "owner",
  "summary",
  "tags",
  "relations",
  "access",
]);

const PROFILE_FIELDS: Record<DocsMetadataProfile, ReadonlySet<string>> = {
  lifecycle: new Set([
    ...BASE_FIELDS,
    "status",
    "status_changed_at",
    "status_note",
    "severity",
    "resolved_at",
    "affected",
    "resolution",
  ]),
  runbook: new Set([...BASE_FIELDS, "title", "audience", "source", "reviewed_at", "review_due_at"]),
  wiki: new Set([
    ...BASE_FIELDS,
    "title",
    "category",
    "aliases",
    "source_count",
    "provenance",
    "primary_entity",
    "source_pages",
    "source_tokens",
    "top_entities",
  ]),
  synced: new Set([
    ...BASE_FIELDS,
    "title",
    "handle",
    "published",
    "source",
    "source_updated_at",
    "source_id",
    "source_template",
  ]),
  "quote-sheet": new Set([
    ...BASE_FIELDS,
    "title",
    "status",
    "product",
    "variant",
    "sku",
    "manufacturer",
    "customer",
    "bid_id",
    "drive_file_id",
    "drive_title",
    "quote_date",
    "revision",
    "batch_size",
    "order_size",
    "price",
    "source_pdf",
    "claims",
  ]),
  "weekly-post": new Set([...BASE_FIELDS, "title", "status", "week", "coverage"]),
  inquiry: new Set([
    ...BASE_FIELDS,
    "title",
    "status",
    "status_changed_at",
    "resolved_at",
    "severity",
    "affected",
  ]),
  general: BASE_FIELDS,
};

const LIFECYCLE_FIELDS: Record<"plan" | "issue" | "handoff", ReadonlySet<string>> = {
  plan: new Set([...BASE_FIELDS, "status", "status_changed_at", "status_note"]),
  issue: new Set([
    ...BASE_FIELDS,
    "status",
    "status_changed_at",
    "status_note",
    "severity",
    "resolved_at",
    "affected",
  ]),
  handoff: new Set([...BASE_FIELDS, "status", "status_changed_at", "status_note", "resolution"]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function add(
  issues: DocsMetadataValidationIssue[],
  severity: DocsMetadataValidationIssue["severity"],
  code: string,
  field: string,
  message: string,
): void {
  issues.push({ severity, code, field, message });
}

export function docsMetadataProfileForType(type: DocsMetadataType): DocsMetadataProfile {
  if (LIFECYCLE_TYPES.has(type)) return "lifecycle";
  if (type === "runbook") return "runbook";
  if (WIKI_TYPES.has(type)) return "wiki";
  if (type === "synced-page") return "synced";
  if (type === "quote-sheet") return "quote-sheet";
  if (type === "weekly-post") return "weekly-post";
  if (type === "inquiry") return "inquiry";
  return "general";
}

export function isDocsMetadataType(value: unknown): value is DocsMetadataType {
  return typeof value === "string" && SUPPORTED_TYPES.has(value as DocsMetadataType);
}

function requireString(
  data: Record<string, unknown>,
  field: string,
  issues: DocsMetadataValidationIssue[],
): string | null {
  const value = data[field];
  if (typeof value !== "string" || value.trim() === "") {
    add(issues, "error", "required_string", field, `${field} must be a non-empty string`);
    return null;
  }
  return value;
}

function validateTimestamp(
  data: Record<string, unknown>,
  field: string,
  issues: DocsMetadataValidationIssue[],
  required = true,
): number | null {
  const value = data[field];
  if (value === undefined && !required) return null;
  if (typeof value !== "string" || !RFC3339_UTC_SECONDS.test(value)) {
    add(
      issues,
      "error",
      "invalid_timestamp",
      field,
      `${field} must use RFC 3339 UTC seconds, for example 2026-08-19T19:47:53Z`,
    );
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().replace(".000Z", "Z") !== value) {
    add(issues, "error", "invalid_timestamp", field, `${field} is not a real timestamp`);
    return null;
  }
  return parsed;
}

function validateOwner(
  data: Record<string, unknown>,
  issues: DocsMetadataValidationIssue[],
  required = false,
): void {
  if (data.owner === undefined && !required) return;
  const owner = requireString(data, "owner", issues);
  if (owner && !SLUG.test(owner)) {
    add(issues, "error", "invalid_owner", "owner", "owner must be a lowercase kebab-case id");
  }
}

function validateSummary(
  data: Record<string, unknown>,
  issues: DocsMetadataValidationIssue[],
  required = false,
): void {
  if (data.summary === undefined && !required) return;
  requireString(data, "summary", issues);
}

function validateOptionalString(
  data: Record<string, unknown>,
  field: string,
  issues: DocsMetadataValidationIssue[],
): void {
  if (data[field] !== undefined) requireString(data, field, issues);
}

function validateStringList(
  value: unknown,
  field: string,
  issues: DocsMetadataValidationIssue[],
  itemPattern?: RegExp,
): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    add(issues, "error", "invalid_list", field, `${field} must be a YAML list of strings`);
    return null;
  }
  const items = value as string[];
  if (new Set(items).size !== items.length) {
    add(issues, "error", "duplicate_list_item", field, `${field} contains duplicate values`);
  }
  if (itemPattern) {
    for (const item of items) {
      if (!itemPattern.test(item)) {
        add(
          issues,
          "error",
          "invalid_list_item",
          field,
          `${field} contains invalid value '${item}'`,
        );
      }
    }
  }
  return items;
}

function validateRelations(
  data: Record<string, unknown>,
  issues: DocsMetadataValidationIssue[],
): void {
  if (data.relations === undefined) return;
  if (!isRecord(data.relations)) {
    add(issues, "error", "invalid_relations", "relations", "relations must be a YAML mapping");
    return;
  }
  const allowed = new Set(["depends_on", "supersedes", "superseded_by", "continues", "related"]);
  for (const [key, value] of Object.entries(data.relations)) {
    if (!allowed.has(key)) {
      add(issues, "error", "unknown_relation", `relations.${key}`, `unknown relation '${key}'`);
      continue;
    }
    validateStringList(value, `relations.${key}`, issues);
  }
}

function validateAccess(
  data: Record<string, unknown>,
  issues: DocsMetadataValidationIssue[],
): void {
  if (data.access === undefined) return;
  if (!isRecord(data.access)) {
    add(issues, "error", "invalid_access", "access", "access must be a YAML mapping");
    return;
  }
  const allowed = new Set(["roles", "viewers"]);
  for (const key of Object.keys(data.access)) {
    if (!allowed.has(key)) {
      add(
        issues,
        "error",
        "unknown_access_field",
        `access.${key}`,
        `unknown access field '${key}'`,
      );
    }
  }
  if (data.access.roles !== undefined) {
    validateStringList(data.access.roles, "access.roles", issues, SLUG);
  }
  if (data.access.viewers !== undefined) {
    validateStringList(data.access.viewers, "access.viewers", issues, EMAIL);
  }
}

function validateLifecycle(
  data: Record<string, unknown>,
  type: "plan" | "issue" | "handoff",
  createdAt: number | null,
  updatedAt: number | null,
  issues: DocsMetadataValidationIssue[],
): void {
  const status = requireString(data, "status", issues);
  const allowed =
    type === "plan" ? PLAN_STATUSES : type === "issue" ? ISSUE_STATUSES : HANDOFF_STATUSES;
  if (status && !allowed.has(status)) {
    add(issues, "error", "invalid_status", "status", `status '${status}' is invalid for ${type}`);
  }

  const changedAt = validateTimestamp(data, "status_changed_at", issues);
  if (createdAt !== null && changedAt !== null && changedAt < createdAt) {
    add(
      issues,
      "error",
      "timestamp_order",
      "status_changed_at",
      "status_changed_at cannot precede created_at",
    );
  }
  if (updatedAt !== null && changedAt !== null && changedAt > updatedAt) {
    add(
      issues,
      "error",
      "timestamp_order",
      "status_changed_at",
      "status_changed_at cannot be later than updated_at",
    );
  }

  validateOptionalString(data, "status_note", issues);

  if (type === "issue") {
    const severity = requireString(data, "severity", issues);
    if (severity && !ISSUE_SEVERITIES.has(severity)) {
      add(
        issues,
        "error",
        "invalid_severity",
        "severity",
        `severity '${severity}' must be low, medium, high, or critical`,
      );
    }
    if (data.affected !== undefined) validateStringList(data.affected, "affected", issues);
    const resolvedAt = validateTimestamp(data, "resolved_at", issues, status === "resolved");
    if (status !== "resolved" && resolvedAt !== null) {
      add(
        issues,
        "error",
        "unexpected_resolved_at",
        "resolved_at",
        "resolved_at is only valid when status is resolved",
      );
    }
    if (createdAt !== null && resolvedAt !== null && resolvedAt < createdAt) {
      add(
        issues,
        "error",
        "timestamp_order",
        "resolved_at",
        "resolved_at cannot precede created_at",
      );
    }
    if (updatedAt !== null && resolvedAt !== null && resolvedAt > updatedAt) {
      add(
        issues,
        "error",
        "timestamp_order",
        "resolved_at",
        "resolved_at cannot be later than updated_at",
      );
    }
  }

  if (type === "handoff") {
    const terminal = status === "resolved" || status === "abandoned";
    if (terminal && !isRecord(data.resolution)) {
      add(
        issues,
        "error",
        "missing_resolution",
        "resolution",
        "terminal handoffs require a resolution mapping",
      );
    }
    if (!terminal && data.resolution !== undefined) {
      add(
        issues,
        "error",
        "unexpected_resolution",
        "resolution",
        "open handoffs cannot carry resolution metadata",
      );
    }
    if (isRecord(data.resolution)) {
      if (typeof data.resolution.outcome !== "string" || !data.resolution.outcome.trim()) {
        add(
          issues,
          "error",
          "invalid_resolution",
          "resolution.outcome",
          "resolution.outcome must be a non-empty string",
        );
      }
      if (data.resolution.commits !== undefined) {
        validateStringList(data.resolution.commits, "resolution.commits", issues);
      }
    }
  }
}

function validateRunbook(
  data: Record<string, unknown>,
  updatedAt: number | null,
  issues: DocsMetadataValidationIssue[],
): void {
  validateOptionalString(data, "title", issues);
  validateOptionalString(data, "audience", issues);
  validateOptionalString(data, "source", issues);
  const reviewedAt = validateTimestamp(data, "reviewed_at", issues);
  const reviewDueAt = validateTimestamp(data, "review_due_at", issues);
  if (reviewedAt !== null && reviewDueAt !== null && reviewDueAt <= reviewedAt) {
    add(
      issues,
      "error",
      "timestamp_order",
      "review_due_at",
      "review_due_at must be later than reviewed_at",
    );
  }
  if (updatedAt !== null && reviewedAt !== null && reviewedAt > updatedAt) {
    add(
      issues,
      "error",
      "timestamp_order",
      "reviewed_at",
      "reviewed_at cannot be later than updated_at",
    );
  }
}

function validateWiki(data: Record<string, unknown>, issues: DocsMetadataValidationIssue[]): void {
  requireString(data, "title", issues);
  requireString(data, "category", issues);
  if (data.aliases !== undefined) validateStringList(data.aliases, "aliases", issues);
  if (
    typeof data.source_count !== "number" ||
    !Number.isInteger(data.source_count) ||
    data.source_count < 0
  ) {
    add(
      issues,
      "error",
      "invalid_source_count",
      "source_count",
      "source_count must be a non-negative integer",
    );
  }
  if (!isRecord(data.provenance)) {
    add(issues, "error", "invalid_provenance", "provenance", "provenance must be a mapping");
  } else {
    validateStringList(data.provenance.sources, "provenance.sources", issues);
  }
}

function validateSynced(
  data: Record<string, unknown>,
  issues: DocsMetadataValidationIssue[],
): void {
  requireString(data, "title", issues);
  requireString(data, "handle", issues);
  requireString(data, "source", issues);
  validateTimestamp(data, "source_updated_at", issues);
  if (typeof data.published !== "boolean") {
    add(issues, "error", "invalid_boolean", "published", "published must be a boolean");
  }
  validateOptionalString(data, "source_id", issues);
  validateOptionalString(data, "source_template", issues);
}

function validateQuoteSheet(
  data: Record<string, unknown>,
  issues: DocsMetadataValidationIssue[],
): void {
  for (const field of ["title", "status", "product", "manufacturer", "quote_date", "source_pdf"]) {
    requireString(data, field, issues);
  }
  if (
    typeof data.status === "string" &&
    !new Set(["not-final", "unsigned", "signed", "final"]).has(data.status)
  ) {
    add(
      issues,
      "error",
      "invalid_status",
      "status",
      "quote-sheet status must be not-final, unsigned, signed, or final",
    );
  }
}

function validateWeeklyPost(
  data: Record<string, unknown>,
  issues: DocsMetadataValidationIssue[],
): void {
  for (const field of ["title", "status", "week", "coverage"]) requireString(data, field, issues);
}

function validateInquiry(
  data: Record<string, unknown>,
  createdAt: number | null,
  updatedAt: number | null,
  issues: DocsMetadataValidationIssue[],
): void {
  requireString(data, "title", issues);
  const status = requireString(data, "status", issues);
  if (status && !new Set(["open", "resolved", "abandoned"]).has(status)) {
    add(issues, "error", "invalid_status", "status", `inquiry status '${status}' is invalid`);
  }
  const changedAt = validateTimestamp(data, "status_changed_at", issues);
  if (createdAt !== null && changedAt !== null && changedAt < createdAt) {
    add(
      issues,
      "error",
      "timestamp_order",
      "status_changed_at",
      "status_changed_at cannot precede created_at",
    );
  }
  if (updatedAt !== null && changedAt !== null && changedAt > updatedAt) {
    add(
      issues,
      "error",
      "timestamp_order",
      "status_changed_at",
      "status_changed_at cannot be later than updated_at",
    );
  }
  const resolvedAt = validateTimestamp(data, "resolved_at", issues, status === "resolved");
  if (status !== "resolved" && resolvedAt !== null) {
    add(
      issues,
      "error",
      "unexpected_resolved_at",
      "resolved_at",
      "resolved_at is only valid when status is resolved",
    );
  }
}

/** Validate one parsed YAML frontmatter mapping against the harnery-doc/v2 contract. */
export function validateDocsMetadataV2(
  data: Record<string, unknown>,
): DocsMetadataValidationResult {
  const issues: DocsMetadataValidationIssue[] = [];
  if (data.schema !== DOCS_METADATA_SCHEMA_V2) {
    add(issues, "error", "invalid_schema", "schema", `schema must be '${DOCS_METADATA_SCHEMA_V2}'`);
  }

  const rawType = requireString(data, "type", issues);
  const type = rawType && isDocsMetadataType(rawType) ? rawType : null;
  if (rawType && !type) {
    add(issues, "error", "invalid_type", "type", `unsupported document type '${rawType}'`);
  }
  const profile = type ? docsMetadataProfileForType(type) : null;

  const createdAt = validateTimestamp(data, "created_at", issues);
  const updatedAt = validateTimestamp(data, "updated_at", issues);
  if (createdAt !== null && updatedAt !== null && updatedAt < createdAt) {
    add(issues, "error", "timestamp_order", "updated_at", "updated_at cannot precede created_at");
  }

  if (data.tags !== undefined) validateStringList(data.tags, "tags", issues, SLUG);
  const lifecycleType = type !== null && LIFECYCLE_TYPES.has(type);
  validateOwner(data, issues, lifecycleType || type === "runbook" || type === "inquiry");
  validateSummary(data, issues, type !== null);
  validateRelations(data, issues);
  validateAccess(data, issues);

  if (profile) {
    const allowed =
      type && LIFECYCLE_TYPES.has(type)
        ? LIFECYCLE_FIELDS[type as "plan" | "issue" | "handoff"]
        : PROFILE_FIELDS[profile];
    for (const key of Object.keys(data)) {
      if (!allowed.has(key) && !key.startsWith("x_")) {
        add(issues, "error", "unknown_field", key, `unknown ${profile} metadata field '${key}'`);
      }
    }
  }

  if (type && LIFECYCLE_TYPES.has(type)) {
    validateLifecycle(data, type as "plan" | "issue" | "handoff", createdAt, updatedAt, issues);
  } else if (type === "runbook") {
    validateRunbook(data, updatedAt, issues);
  } else if (type && WIKI_TYPES.has(type)) {
    validateWiki(data, issues);
  } else if (type === "synced-page") {
    validateSynced(data, issues);
  } else if (type === "quote-sheet") {
    validateQuoteSheet(data, issues);
  } else if (type === "weekly-post") {
    validateWeeklyPost(data, issues);
  } else if (type === "inquiry") {
    validateInquiry(data, createdAt, updatedAt, issues);
  }

  return {
    valid: issues.every((issue) => issue.severity !== "error"),
    profile,
    issues,
  };
}

export function isDocsMetadataV2(data: Record<string, unknown>): boolean {
  return data.schema === DOCS_METADATA_SCHEMA_V2;
}
