import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  memoryBindings,
  memoryBindingTargets,
  memoryExtractionJobs,
  memoryLocalRecords,
  memoryOperations,
  projects,
} from "@paperclipai/db";
import type {
  MemoryBinding,
  MemoryBindingTarget,
  MemoryBindingTargetType,
  MemoryCapture,
  MemoryCaptureResult,
  MemoryCitation,
  MemoryCorrect,
  MemoryCorrectResult,
  MemoryExtractionJob,
  MemoryForget,
  MemoryForgetResult,
  MemoryGovernedScope,
  MemoryListExtractionJobsQuery,
  MemoryListOperationsQuery,
  MemoryListRecordsQuery,
  MemoryOperation,
  MemoryPrincipalRef,
  MemoryProviderDescriptor,
  MemoryQuery,
  MemoryQueryResult,
  MemoryRecord,
  MemoryRetentionSweep,
  MemoryRetentionSweepResult,
  MemoryRevoke,
  MemoryRevokeResult,
  MemoryReview,
  MemoryReviewResult,
  MemoryResolvedBinding,
  MemoryScope,
  MemoryScopeType,
  MemorySensitivityLabel,
  MemorySourceRef,
  MemoryUsage,
} from "@paperclipai/shared";
import { createMemoryBindingSchema, memoryCorrectSchema, memoryRetentionSweepSchema, memoryReviewSchema, memoryRevokeSchema, updateMemoryBindingSchema } from "@paperclipai/shared";
import { z } from "zod";
import { conflict, notFound, unprocessable } from "../errors.js";
import { costService } from "./costs.js";
import { validateInstanceConfig } from "./plugin-config-validator.js";
import {
  getDefaultPluginMemoryProviderDispatcher,
  type PluginMemoryProviderDispatcher,
} from "./plugin-memory-provider-dispatcher.js";
import {
  buildPostRunCaptureTrace,
  buildPreRunHydrateTrace,
  buildSkippedMemoryHookTrace,
  type MemoryHookTrace,
} from "./memory-hook-trace.js";

type ActorInfo = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId: string | null;
  userId: string | null;
  runId: string | null;
};

type BindingRow = typeof memoryBindings.$inferSelect;
type TargetRow = typeof memoryBindingTargets.$inferSelect;
type OperationRow = typeof memoryOperations.$inferSelect;
type RecordRow = typeof memoryLocalRecords.$inferSelect;
type ExtractionJobRow = typeof memoryExtractionJobs.$inferSelect;

export interface MemoryPreRunHydrateResult {
  preamble: string | null;
  trace: MemoryHookTrace;
}

export interface MemoryPostRunCaptureResult {
  trace: MemoryHookTrace;
}

const LOCAL_BASIC_PROVIDER_KEY = "local_basic";

const localBasicConfigSchema = z
  .object({
    enablePreRunHydrate: z.boolean().optional().default(true),
    enablePostRunCapture: z.boolean().optional().default(true),
    enableIssueCommentCapture: z.boolean().optional().default(false),
    enableIssueDocumentCapture: z.boolean().optional().default(true),
    maxHydrateSnippets: z.number().int().positive().max(10).optional().default(5),
  })
  .strict();

type LocalBasicConfig = z.infer<typeof localBasicConfigSchema>;

const LOCAL_BASIC_PROVIDER: MemoryProviderDescriptor = {
  key: LOCAL_BASIC_PROVIDER_KEY,
  displayName: "Local basic",
  description: "Deterministic local memory backed by Postgres full-text search.",
  kind: "builtin",
  pluginId: null,
  capabilities: {
    browse: true,
    correction: false,
    asyncIngestion: false,
    providerManagedExtraction: false,
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enablePreRunHydrate: { type: "boolean", default: true },
      enablePostRunCapture: { type: "boolean", default: true },
      enableIssueCommentCapture: { type: "boolean", default: false },
      enableIssueDocumentCapture: { type: "boolean", default: true },
      maxHydrateSnippets: { type: "integer", minimum: 1, maximum: 10, default: 5 },
    },
  },
  configMetadata: {
    suggestedConfig: {
      enablePreRunHydrate: true,
      enablePostRunCapture: true,
      enableIssueCommentCapture: false,
      enableIssueDocumentCapture: true,
      maxHydrateSnippets: 5,
    },
    fields: [
      {
        key: "enablePreRunHydrate",
        label: "Pre-run hydrate",
        description: "Read relevant memory before agent runs.",
        input: "boolean",
        defaultValue: true,
        suggestedValue: true,
      },
      {
        key: "enablePostRunCapture",
        label: "Post-run capture",
        description: "Capture run summaries after agent runs.",
        input: "boolean",
        defaultValue: true,
        suggestedValue: true,
      },
      {
        key: "enableIssueCommentCapture",
        label: "Issue comment capture",
        description: "Capture issue comments into memory.",
        input: "boolean",
        defaultValue: false,
        suggestedValue: false,
      },
      {
        key: "enableIssueDocumentCapture",
        label: "Issue document capture",
        description: "Capture issue documents into memory.",
        input: "boolean",
        defaultValue: true,
        suggestedValue: true,
      },
      {
        key: "maxHydrateSnippets",
        label: "Hydration snippets",
        description: "Maximum snippets to include when hydrating prompts.",
        input: "number",
        defaultValue: 5,
        suggestedValue: 5,
        min: 1,
        max: 10,
      },
    ],
    healthChecks: [
      {
        key: "postgres",
        label: "Postgres storage",
        status: "ok",
        message: "Local basic memory stores records in the Paperclip database.",
      },
    ],
  },
};

const SENSITIVITY_RANK: Record<MemorySensitivityLabel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const DEFAULT_AGENT_MAX_SENSITIVITY: MemorySensitivityLabel = "confidential";

function parseLocalBasicConfig(config: Record<string, unknown> | null | undefined): LocalBasicConfig {
  return localBasicConfigSchema.parse(config ?? {});
}

function normalizeScopeType(scope: MemoryScope, fallback: MemoryScopeType = "org"): MemoryScopeType {
  if (scope.scopeType) return scope.scopeType;
  if (scope.runId) return "run";
  if (scope.agentId) return "agent";
  if (scope.workspaceId) return "workspace";
  if (scope.projectId) return "project";
  if (scope.teamId) return "team";
  return fallback;
}

function normalizeScopeId(companyId: string, scopeType: MemoryScopeType, scope: MemoryScope) {
  if (scope.scopeId) return scope.scopeId;
  switch (scopeType) {
    case "run":
      return scope.runId ?? null;
    case "agent":
      return scope.agentId ?? null;
    case "workspace":
      return scope.workspaceId ?? null;
    case "project":
      return scope.projectId ?? null;
    case "team":
      return scope.teamId ?? null;
    case "org":
      return companyId;
  }
}

function actorPrincipal(actor: ActorInfo): MemoryPrincipalRef {
  if (actor.actorType === "agent" && actor.agentId) return { type: "agent", id: actor.agentId };
  if (actor.actorType === "user" && actor.userId) return { type: "user", id: actor.userId };
  return { type: "system", id: actor.actorId || "system" };
}

function normalizePrincipal(input: MemoryPrincipalRef | null | undefined, fallback: MemoryPrincipalRef): MemoryPrincipalRef {
  if (input?.type && input.id) return input;
  return fallback;
}

function normalizeCitation(input: MemoryCitation | null | undefined): Record<string, unknown> | null {
  if (!input) return null;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Record<string, unknown>;
}

function citationFromRow(value: unknown): MemoryCitation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as MemoryCitation;
}

function maxSensitivityForActor(actor: ActorInfo, scope: MemoryScope): MemorySensitivityLabel {
  if (actor.actorType === "user" || actor.actorType === "system") return scope.maxSensitivityLabel ?? "restricted";
  return scope.maxSensitivityLabel ?? DEFAULT_AGENT_MAX_SENSITIVITY;
}

function allowedSensitivityLabels(max: MemorySensitivityLabel): MemorySensitivityLabel[] {
  const rank = SENSITIVITY_RANK[max];
  return (Object.keys(SENSITIVITY_RANK) as MemorySensitivityLabel[]).filter(
    (label) => SENSITIVITY_RANK[label] <= rank,
  );
}

function scopeMatches(record: MemoryRecord, allowedScopes: MemoryGovernedScope[]) {
  return allowedScopes.some((scope) => {
    if (scope.type !== record.scopeType) return false;
    if (!scope.id) return !record.scopeId;
    return record.scopeId === scope.id;
  });
}

function canReadRecord(companyId: string, record: MemoryRecord, actor: ActorInfo, scope: MemoryScope = {}) {
  if (record.deletedAt || record.revokedAt || record.retentionState !== "active") return false;
  if (record.supersededByRecordId) return false;
  if (record.expiresAt && record.expiresAt <= new Date()) return false;
  const maxSensitivity = maxSensitivityForActor(actor, scope);
  if (SENSITIVITY_RANK[record.sensitivityLabel] > SENSITIVITY_RANK[maxSensitivity]) return false;
  if (actor.actorType !== "agent") return true;
  if (record.reviewState !== "accepted") return false;
  return scopeMatches(record, deriveAllowedScopes(companyId, scope, actor));
}

function deriveAllowedScopes(companyId: string, scope: MemoryScope, actor: ActorInfo): MemoryGovernedScope[] {
  const scopes: MemoryGovernedScope[] = [{ type: "org", id: companyId }];
  if (scope.allowedScopes?.length) {
    scopes.push(...scope.allowedScopes);
  }
  if (scope.agentId) scopes.push({ type: "agent", id: scope.agentId });
  if (scope.runId) scopes.push({ type: "run", id: scope.runId });
  if (scope.workspaceId) scopes.push({ type: "workspace", id: scope.workspaceId });
  if (scope.projectId) scopes.push({ type: "project", id: scope.projectId });
  if (scope.teamId) scopes.push({ type: "team", id: scope.teamId });
  if (actor.actorType === "agent" && actor.agentId) scopes.push({ type: "agent", id: actor.agentId });

  const seen = new Set<string>();
  return scopes.filter((entry) => {
    const key = `${entry.type}:${entry.id ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildMemoryPreamble(records: MemoryRecord[]) {
  if (records.length === 0) return null;
  return [
    "Relevant memory:",
    ...records.map((record, index) => {
      const sourceLabel = record.source?.kind ?? "memory";
      const body = (record.summary ?? record.content).replace(/\s+/g, " ").slice(0, 240);
      return `${index + 1}. [${sourceLabel}] ${body}`;
    }),
  ].join("\n");
}

function scopeFromRow(row: {
  scopeType?: MemoryScopeType | null;
  scopeId?: string | null;
  scopeAgentId: string | null;
  scopeWorkspaceId?: string | null;
  scopeProjectId: string | null;
  scopeIssueId: string | null;
  scopeRunId: string | null;
  scopeTeamId?: string | null;
  scopeSubjectId: string | null;
  maxSensitivityLabel?: MemorySensitivityLabel | null;
}): MemoryScope {
  return {
    scopeType: row.scopeType ?? null,
    scopeId: row.scopeId ?? null,
    agentId: row.scopeAgentId,
    workspaceId: row.scopeWorkspaceId ?? null,
    projectId: row.scopeProjectId,
    issueId: row.scopeIssueId,
    runId: row.scopeRunId,
    teamId: row.scopeTeamId ?? null,
    subjectId: row.scopeSubjectId,
    maxSensitivityLabel: row.maxSensitivityLabel ?? null,
  };
}

function sourceFromRow(row: {
  sourceKind: MemorySourceRef["kind"] | null;
  sourceIssueId: string | null;
  sourceCommentId: string | null;
  sourceDocumentKey: string | null;
  sourceRunId: string | null;
  sourceActivityId: string | null;
  sourceExternalRef: string | null;
}): MemorySourceRef | null {
  if (!row.sourceKind) return null;
  return {
    kind: row.sourceKind,
    issueId: row.sourceIssueId,
    commentId: row.sourceCommentId,
    documentKey: row.sourceDocumentKey,
    runId: row.sourceRunId,
    activityId: row.sourceActivityId,
    externalRef: row.sourceExternalRef,
  };
}

function normalizeUsage(input: unknown): MemoryUsage[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .map((value) => ({
      provider: typeof value.provider === "string" ? value.provider : "unknown",
      model: typeof value.model === "string" ? value.model : null,
      inputTokens: typeof value.inputTokens === "number" ? value.inputTokens : 0,
      outputTokens: typeof value.outputTokens === "number" ? value.outputTokens : 0,
      embeddingTokens: typeof value.embeddingTokens === "number" ? value.embeddingTokens : 0,
      costCents: typeof value.costCents === "number" ? value.costCents : 0,
      latencyMs: typeof value.latencyMs === "number" ? value.latencyMs : null,
      details:
        typeof value.details === "object" && value.details !== null && !Array.isArray(value.details)
          ? (value.details as Record<string, unknown>)
          : null,
    }));
}

function mapBinding(row: BindingRow): MemoryBinding {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    name: row.name ?? null,
    providerKey: row.providerKey,
    config: row.config ?? {},
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapTarget(row: TargetRow): MemoryBindingTarget {
  return {
    id: row.id,
    companyId: row.companyId,
    bindingId: row.bindingId,
    targetType: row.targetType,
    targetId: row.targetId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapOperation(row: OperationRow): MemoryOperation {
  return {
    id: row.id,
    companyId: row.companyId,
    bindingId: row.bindingId,
    providerKey: row.providerKey,
    operationType: row.operationType,
    triggerKind: row.triggerKind,
    hookKind: row.hookKind ?? null,
    status: row.status,
    actorType: row.actorType as MemoryOperation["actorType"],
    actorId: row.actorId,
    agentId: row.agentId ?? null,
    userId: row.userId ?? null,
    scope: scopeFromRow(row),
    source: sourceFromRow(row),
    queryText: row.queryText ?? null,
    recordCount: row.recordCount,
    requestJson:
      typeof row.requestJson === "object" && row.requestJson !== null && !Array.isArray(row.requestJson)
        ? (row.requestJson as Record<string, unknown>)
        : null,
    resultJson:
      typeof row.resultJson === "object" && row.resultJson !== null && !Array.isArray(row.resultJson)
        ? (row.resultJson as Record<string, unknown>)
        : null,
    policyDecision:
      typeof row.policyDecisionJson === "object" && row.policyDecisionJson !== null && !Array.isArray(row.policyDecisionJson)
        ? (row.policyDecisionJson as Record<string, unknown>)
        : null,
    revocationSelector:
      typeof row.revocationSelectorJson === "object" && row.revocationSelectorJson !== null && !Array.isArray(row.revocationSelectorJson)
        ? (row.revocationSelectorJson as Record<string, unknown>)
        : null,
    retentionAction:
      typeof row.retentionActionJson === "object" && row.retentionActionJson !== null && !Array.isArray(row.retentionActionJson)
        ? (row.retentionActionJson as Record<string, unknown>)
        : null,
    usage: normalizeUsage(row.usageJson),
    error: row.error ?? null,
    costEventId: row.costEventId ?? null,
    financeEventId: row.financeEventId ?? null,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

function mapRecord(row: RecordRow): MemoryRecord {
  const scope = scopeFromRow(row);
  const scopeType = row.scopeType ?? normalizeScopeType(scope);
  return {
    id: row.id,
    companyId: row.companyId,
    bindingId: row.bindingId,
    providerKey: row.providerKey,
    scope,
    source: sourceFromRow(row),
    scopeType,
    scopeId: row.scopeId ?? normalizeScopeId(row.companyId, scopeType, scope),
    owner: row.ownerType && row.ownerId ? { type: row.ownerType, id: row.ownerId } : null,
    createdBy: row.createdByActorType && row.createdByActorId ? { type: row.createdByActorType, id: row.createdByActorId } : null,
    sensitivityLabel: row.sensitivityLabel ?? "internal",
    retentionPolicy:
      typeof row.retentionPolicy === "object" && row.retentionPolicy !== null && !Array.isArray(row.retentionPolicy)
        ? (row.retentionPolicy as Record<string, unknown>)
        : null,
    expiresAt: row.expiresAt ?? null,
    retentionState: row.retentionState ?? "active",
    reviewState: row.reviewState ?? "pending",
    reviewedAt: row.reviewedAt ?? null,
    reviewedBy:
      row.reviewedByActorType && row.reviewedByActorId ? { type: row.reviewedByActorType, id: row.reviewedByActorId } : null,
    reviewNote: row.reviewNote ?? null,
    citation: citationFromRow(row.citationJson),
    supersedesRecordId: row.supersedesRecordId ?? null,
    supersededByRecordId: row.supersededByRecordId ?? null,
    revokedAt: row.revokedAt ?? null,
    revokedBy:
      row.revokedByActorType && row.revokedByActorId ? { type: row.revokedByActorType, id: row.revokedByActorId } : null,
    revocationReason: row.revocationReason ?? null,
    title: row.title ?? null,
    content: row.content,
    summary: row.summary ?? null,
    metadata: row.metadata ?? {},
    createdByOperationId: row.createdByOperationId ?? null,
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapExtractionJob(row: ExtractionJobRow): MemoryExtractionJob {
  return {
    id: row.id,
    companyId: row.companyId,
    bindingId: row.bindingId,
    providerKey: row.providerKey,
    operationId: row.operationId ?? null,
    status: row.status,
    providerJobId: row.providerJobId ?? null,
    source: sourceFromRow(row),
    resultJson:
      typeof row.resultJson === "object" && row.resultJson !== null && !Array.isArray(row.resultJson)
        ? (row.resultJson as Record<string, unknown>)
        : null,
    error: row.error ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildRecordVisibilityConditions(
  companyId: string,
  bindingId: string,
  scope: MemoryScope,
  actor: ActorInfo,
  options?: {
    includeRevoked?: boolean;
    includeExpired?: boolean;
    includeSuperseded?: boolean;
    includeDeleted?: boolean;
  },
) {
  const conditions = [
    eq(memoryLocalRecords.companyId, companyId),
    eq(memoryLocalRecords.bindingId, bindingId),
  ];
  if (!options?.includeDeleted) conditions.push(isNull(memoryLocalRecords.deletedAt));
  if (!options?.includeRevoked) {
    conditions.push(isNull(memoryLocalRecords.revokedAt));
  }
  if (!options?.includeExpired) {
    conditions.push(or(isNull(memoryLocalRecords.expiresAt), sql`${memoryLocalRecords.expiresAt} > now()`)!);
  }
  if (!options?.includeSuperseded) {
    conditions.push(isNull(memoryLocalRecords.supersededByRecordId));
  }
  conditions.push(eq(memoryLocalRecords.reviewState, "accepted"));

  const maxSensitivity = maxSensitivityForActor(actor, scope);
  conditions.push(inArray(memoryLocalRecords.sensitivityLabel, allowedSensitivityLabels(maxSensitivity)));

  const allowedScopes = deriveAllowedScopes(companyId, scope, actor);
  if (actor.actorType === "agent" || scope.allowedScopes?.length) {
    const scopeConditions = allowedScopes.map((allowedScope) =>
      and(
        eq(memoryLocalRecords.scopeType, allowedScope.type),
        allowedScope.id ? eq(memoryLocalRecords.scopeId, allowedScope.id) : isNull(memoryLocalRecords.scopeId),
      ),
    );
    if (scopeConditions.length > 0) {
      conditions.push(or(...scopeConditions)!);
    }
  }

  return conditions;
}

async function createDirectCostEvent(
  db: Db,
  companyId: string,
  actor: ActorInfo,
  scope: MemoryScope,
  usage: MemoryUsage[],
): Promise<string | null> {
  const costCents = usage.reduce((sum, entry) => sum + entry.costCents, 0);
  if (costCents <= 0) return null;
  const agentId = actor.agentId ?? scope.agentId ?? null;
  if (!agentId) return null;
  const first = usage[0] ?? null;
  const event = await costService(db).createEvent(companyId, {
    agentId,
    issueId: scope.issueId ?? null,
    projectId: scope.projectId ?? null,
    goalId: null,
    heartbeatRunId: scope.runId ?? actor.runId ?? null,
    billingCode: null,
    provider: first?.provider ?? "memory",
    biller: first?.provider ?? "memory",
    billingType: "metered_api",
    model: first?.model ?? "memory",
    inputTokens: usage.reduce((sum, entry) => sum + entry.inputTokens + entry.embeddingTokens, 0),
    outputTokens: usage.reduce((sum, entry) => sum + entry.outputTokens, 0),
    cachedInputTokens: 0,
    costCents,
    occurredAt: new Date(),
  });
  return event.id;
}

export function memoryService(
  db: Db,
  opts?: {
    pluginMemoryProviders?: PluginMemoryProviderDispatcher;
  },
) {
  const pluginMemoryProviders = opts?.pluginMemoryProviders ?? getDefaultPluginMemoryProviderDispatcher();
  async function getBindingOrThrow(bindingId: string) {
    const binding = await db
      .select()
      .from(memoryBindings)
      .where(eq(memoryBindings.id, bindingId))
      .then((rows) => rows[0] ?? null);
    if (!binding) throw notFound("Memory binding not found");
    return binding;
  }

  async function validateProviderConfig(providerKey: string, config: Record<string, unknown>) {
    if (providerKey === LOCAL_BASIC_PROVIDER_KEY) {
      return parseLocalBasicConfig(config);
    }

    const pluginProvider = pluginMemoryProviders?.getProvider(providerKey);
    if (!pluginProvider) {
      throw unprocessable(`Unknown memory provider: ${providerKey}`);
    }

    const schema = pluginProvider.descriptor.configSchema;
    if (!schema) return config;

    const validation = validateInstanceConfig(config, schema);
    if (!validation.valid) {
      const detail = validation.errors?.map((error) => `${error.field} ${error.message}`).join("; ") ?? "invalid config";
      throw unprocessable(`Invalid memory provider config: ${detail}`);
    }

    return config;
  }

  function resolutionSource(
    targetType: MemoryBindingTargetType | null,
    bindingKey?: string | null,
  ): MemoryResolvedBinding["source"] {
    if (bindingKey) return "binding_key";
    if (targetType === "agent") return "agent_override";
    if (targetType === "project") return "project_override";
    if (targetType === "company") return "company_default";
    return "unconfigured";
  }

  async function findTargetBinding(
    companyId: string,
    targetType: MemoryBindingTargetType,
    targetId: string,
  ) {
    return db
      .select({
        target: memoryBindingTargets,
        binding: memoryBindings,
      })
      .from(memoryBindingTargets)
      .innerJoin(memoryBindings, eq(memoryBindingTargets.bindingId, memoryBindings.id))
      .where(
        and(
          eq(memoryBindingTargets.companyId, companyId),
          eq(memoryBindingTargets.targetType, targetType),
          eq(memoryBindingTargets.targetId, targetId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function assertScopeTargetsBelongToCompany(companyId: string, scope: MemoryScope) {
    if (scope.agentId) {
      const agent = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, scope.agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== companyId) {
        throw unprocessable("Memory scope agent does not belong to company");
      }
    }

    if (scope.projectId) {
      const project = await db
        .select({ companyId: projects.companyId })
        .from(projects)
        .where(eq(projects.id, scope.projectId))
        .then((rows) => rows[0] ?? null);
      if (!project || project.companyId !== companyId) {
        throw unprocessable("Memory scope project does not belong to company");
      }
    }
  }

  async function resolveBindingInternal(companyId: string, scope: MemoryScope, bindingKey?: string | null) {
    await assertScopeTargetsBelongToCompany(companyId, scope);
    const checkedTargetTypes: MemoryBindingTargetType[] = [];
    if (bindingKey) {
      const binding = await db
        .select()
        .from(memoryBindings)
        .where(and(eq(memoryBindings.companyId, companyId), eq(memoryBindings.key, bindingKey)))
        .then((rows) => rows[0] ?? null);
      if (!binding) throw notFound("Memory binding not found");
      return {
        targetType: null,
        targetId: null,
        binding,
        source: resolutionSource(null, bindingKey),
        checkedTargetTypes,
      };
    }

    const agentId = scope.agentId ?? null;
    if (agentId) {
      checkedTargetTypes.push("agent");
      const target = await findTargetBinding(companyId, "agent", agentId);
      if (target) {
        return {
          targetType: target.target.targetType,
          targetId: target.target.targetId,
          binding: target.binding,
          source: resolutionSource(target.target.targetType),
          checkedTargetTypes,
        };
      }
    }

    const projectId = scope.projectId ?? null;
    if (projectId) {
      checkedTargetTypes.push("project");
      const target = await findTargetBinding(companyId, "project", projectId);
      if (target) {
        return {
          targetType: target.target.targetType,
          targetId: target.target.targetId,
          binding: target.binding,
          source: resolutionSource(target.target.targetType),
          checkedTargetTypes,
        };
      }
    }

    checkedTargetTypes.push("company");
    const target = await findTargetBinding(companyId, "company", companyId);

    return target
      ? {
          targetType: target.target.targetType,
          targetId: target.target.targetId,
          binding: target.binding,
          source: resolutionSource(target.target.targetType),
          checkedTargetTypes,
        }
      : {
          targetType: null,
          targetId: null,
          binding: null,
          source: "unconfigured" as const,
          checkedTargetTypes,
        };
  }

  async function queryLocalBasic(
    binding: BindingRow,
    scope: MemoryScope,
    query: string,
    topK: number,
    actor: ActorInfo,
  ) {
    const rankExpr = sql<number>`
      ts_rank_cd(
        to_tsvector('english', coalesce(${memoryLocalRecords.title}, '') || ' ' || ${memoryLocalRecords.content}),
        websearch_to_tsquery('english', ${query})
      )
    `;
    const rows = await db
      .select()
      .from(memoryLocalRecords)
      .where(
        and(
          ...buildRecordVisibilityConditions(binding.companyId, binding.id, scope, actor),
          sql`to_tsvector('english', coalesce(${memoryLocalRecords.title}, '') || ' ' || ${memoryLocalRecords.content}) @@ websearch_to_tsquery('english', ${query})`,
        ),
      )
      .orderBy(desc(rankExpr), desc(memoryLocalRecords.createdAt))
      .limit(topK);

    return rows.map((row) => mapRecord(row));
  }

  async function captureLocalBasic(
    binding: BindingRow,
    scope: MemoryScope,
    source: MemorySourceRef,
    input: {
      actor: ActorInfo;
      scopeType?: MemoryScopeType | null;
      scopeId?: string | null;
      owner?: MemoryPrincipalRef | null;
      sensitivityLabel?: MemorySensitivityLabel;
      retentionPolicy?: Record<string, unknown> | null;
      expiresAt?: Date | string | null;
      citation?: MemoryCitation | null;
      title?: string | null;
      content: string;
      summary?: string | null;
      metadata?: Record<string, unknown>;
      reviewState?: MemoryRecord["reviewState"];
    },
    operationId: string,
  ) {
    const scopeType = input.scopeType ?? normalizeScopeType(scope);
    const scopeId = input.scopeId ?? normalizeScopeId(binding.companyId, scopeType, scope);
    const createdBy = actorPrincipal(input.actor);
    const owner = normalizePrincipal(input.owner, createdBy);
    const [row] = await db
      .insert(memoryLocalRecords)
      .values({
        id: randomUUID(),
        companyId: binding.companyId,
        bindingId: binding.id,
        providerKey: binding.providerKey,
        scopeAgentId: scope.agentId ?? null,
        scopeProjectId: scope.projectId ?? null,
        scopeIssueId: scope.issueId ?? null,
        scopeRunId: scope.runId ?? null,
        scopeSubjectId: scope.subjectId ?? null,
        scopeType,
        scopeId,
        scopeWorkspaceId: scope.workspaceId ?? null,
        scopeTeamId: scope.teamId ?? null,
        sourceKind: source.kind,
        sourceIssueId: source.issueId ?? null,
        sourceCommentId: source.commentId ?? null,
        sourceDocumentKey: source.documentKey ?? null,
        sourceRunId: source.runId ?? null,
        sourceActivityId: source.activityId ?? null,
        sourceExternalRef: source.externalRef ?? null,
        title: input.title ?? null,
        content: input.content,
        summary: input.summary ?? null,
        metadata: input.metadata ?? {},
        ownerType: owner.type,
        ownerId: owner.id,
        createdByActorType: createdBy.type,
        createdByActorId: createdBy.id,
        sensitivityLabel: input.sensitivityLabel ?? "internal",
        retentionPolicy: input.retentionPolicy ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        retentionState: "active",
        reviewState: input.reviewState ?? "pending",
        citationJson: normalizeCitation(input.citation),
        createdByOperationId: operationId,
      })
      .returning();

    return [mapRecord(row)];
  }

  async function persistCatalogRecords(
    binding: BindingRow,
    records: MemoryRecord[],
    operationId: string | null,
  ) {
    for (const record of records) {
      await db
        .insert(memoryLocalRecords)
        .values({
          id: record.id,
          companyId: binding.companyId,
          bindingId: binding.id,
          providerKey: binding.providerKey,
          scopeAgentId: record.scope.agentId ?? null,
          scopeProjectId: record.scope.projectId ?? null,
          scopeIssueId: record.scope.issueId ?? null,
          scopeRunId: record.scope.runId ?? null,
          scopeSubjectId: record.scope.subjectId ?? null,
          scopeType: record.scopeType,
          scopeId: record.scopeId,
          scopeWorkspaceId: record.scope.workspaceId ?? null,
          scopeTeamId: record.scope.teamId ?? null,
          sourceKind: record.source?.kind ?? null,
          sourceIssueId: record.source?.issueId ?? null,
          sourceCommentId: record.source?.commentId ?? null,
          sourceDocumentKey: record.source?.documentKey ?? null,
          sourceRunId: record.source?.runId ?? null,
          sourceActivityId: record.source?.activityId ?? null,
          sourceExternalRef: record.source?.externalRef ?? null,
          title: record.title ?? null,
          content: record.content,
          summary: record.summary ?? null,
          metadata: record.metadata ?? {},
          ownerType: record.owner?.type ?? null,
          ownerId: record.owner?.id ?? null,
          createdByActorType: record.createdBy?.type ?? null,
          createdByActorId: record.createdBy?.id ?? null,
          sensitivityLabel: record.sensitivityLabel,
          retentionPolicy: record.retentionPolicy,
          expiresAt: record.expiresAt,
          retentionState: record.retentionState,
          reviewState: record.reviewState ?? "pending",
          reviewedAt: record.reviewedAt ?? null,
          reviewedByActorType: record.reviewedBy?.type ?? null,
          reviewedByActorId: record.reviewedBy?.id ?? null,
          reviewNote: record.reviewNote ?? null,
          citationJson: normalizeCitation(record.citation),
          supersedesRecordId: record.supersedesRecordId ?? null,
          supersededByRecordId: record.supersededByRecordId ?? null,
          revokedAt: record.revokedAt ?? null,
          revokedByActorType: record.revokedBy?.type ?? null,
          revokedByActorId: record.revokedBy?.id ?? null,
          revocationReason: record.revocationReason ?? null,
          createdByOperationId: operationId,
          deletedAt: record.deletedAt ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
        .onConflictDoUpdate({
          target: memoryLocalRecords.id,
          set: {
            bindingId: binding.id,
            providerKey: binding.providerKey,
            scopeAgentId: record.scope.agentId ?? null,
            scopeProjectId: record.scope.projectId ?? null,
            scopeIssueId: record.scope.issueId ?? null,
            scopeRunId: record.scope.runId ?? null,
            scopeSubjectId: record.scope.subjectId ?? null,
            scopeType: record.scopeType,
            scopeId: record.scopeId,
            scopeWorkspaceId: record.scope.workspaceId ?? null,
            scopeTeamId: record.scope.teamId ?? null,
            sourceKind: record.source?.kind ?? null,
            sourceIssueId: record.source?.issueId ?? null,
            sourceCommentId: record.source?.commentId ?? null,
            sourceDocumentKey: record.source?.documentKey ?? null,
            sourceRunId: record.source?.runId ?? null,
            sourceActivityId: record.source?.activityId ?? null,
            sourceExternalRef: record.source?.externalRef ?? null,
            title: record.title ?? null,
            content: record.content,
            summary: record.summary ?? null,
            metadata: record.metadata ?? {},
            ownerType: record.owner?.type ?? null,
            ownerId: record.owner?.id ?? null,
            createdByActorType: record.createdBy?.type ?? null,
            createdByActorId: record.createdBy?.id ?? null,
            sensitivityLabel: record.sensitivityLabel,
            retentionPolicy: record.retentionPolicy,
            expiresAt: record.expiresAt,
            retentionState: record.retentionState,
            reviewState: record.reviewState ?? "pending",
            reviewedAt: record.reviewedAt ?? null,
            reviewedByActorType: record.reviewedBy?.type ?? null,
            reviewedByActorId: record.reviewedBy?.id ?? null,
            reviewNote: record.reviewNote ?? null,
            citationJson: normalizeCitation(record.citation),
            supersedesRecordId: record.supersedesRecordId ?? null,
            supersededByRecordId: record.supersededByRecordId ?? null,
            revokedAt: record.revokedAt ?? null,
            revokedByActorType: record.revokedBy?.type ?? null,
            revokedByActorId: record.revokedBy?.id ?? null,
            revocationReason: record.revocationReason ?? null,
            createdByOperationId: operationId,
            deletedAt: record.deletedAt ?? null,
            updatedAt: record.updatedAt,
          },
        });
    }
  }

  async function overlayCatalogRecordState(
    companyId: string,
    bindingId: string,
    records: MemoryRecord[],
  ) {
    if (records.length === 0) return records;
    const rows = await db
      .select()
      .from(memoryLocalRecords)
      .where(
        and(
          eq(memoryLocalRecords.companyId, companyId),
          eq(memoryLocalRecords.bindingId, bindingId),
          inArray(memoryLocalRecords.id, records.map((record) => record.id)),
        ),
      );
    const catalogById = new Map(rows.map((row) => [row.id, mapRecord(row)]));
    return records.map((record) => {
      const catalog = catalogById.get(record.id);
      if (!catalog) return record;
      return {
        ...record,
        reviewState: catalog.reviewState,
        reviewedAt: catalog.reviewedAt,
        reviewedBy: catalog.reviewedBy,
        reviewNote: catalog.reviewNote,
        retentionState: catalog.retentionState,
        revokedAt: catalog.revokedAt,
        revokedBy: catalog.revokedBy,
        revocationReason: catalog.revocationReason,
        supersededByRecordId: catalog.supersededByRecordId,
        deletedAt: catalog.deletedAt,
        updatedAt: catalog.updatedAt,
      };
    });
  }

  async function listLocalBasic(companyId: string, filters: MemoryListRecordsQuery, actor: ActorInfo) {
    const conditions = [eq(memoryLocalRecords.companyId, companyId)];
    if (filters.bindingId) conditions.push(eq(memoryLocalRecords.bindingId, filters.bindingId));
    if (filters.providerKey) conditions.push(eq(memoryLocalRecords.providerKey, filters.providerKey));
    if (filters.scopeType) conditions.push(eq(memoryLocalRecords.scopeType, filters.scopeType));
    if (filters.scopeId) conditions.push(eq(memoryLocalRecords.scopeId, filters.scopeId));
    if (filters.ownerType) conditions.push(eq(memoryLocalRecords.ownerType, filters.ownerType));
    if (filters.ownerId) conditions.push(eq(memoryLocalRecords.ownerId, filters.ownerId));
    if (filters.sensitivityLabel) conditions.push(eq(memoryLocalRecords.sensitivityLabel, filters.sensitivityLabel));
    if (filters.retentionState) conditions.push(eq(memoryLocalRecords.retentionState, filters.retentionState));
    if (filters.reviewState) conditions.push(eq(memoryLocalRecords.reviewState, filters.reviewState));
    if (filters.expiresBefore) conditions.push(lte(memoryLocalRecords.expiresAt, filters.expiresBefore));
    if (filters.agentId) conditions.push(eq(memoryLocalRecords.scopeAgentId, filters.agentId));
    if (filters.workspaceId) conditions.push(eq(memoryLocalRecords.scopeWorkspaceId, filters.workspaceId));
    if (filters.issueId) {
      conditions.push(or(eq(memoryLocalRecords.scopeIssueId, filters.issueId), eq(memoryLocalRecords.sourceIssueId, filters.issueId))!);
    }
    if (filters.projectId) conditions.push(eq(memoryLocalRecords.scopeProjectId, filters.projectId));
    if (filters.teamId) conditions.push(eq(memoryLocalRecords.scopeTeamId, filters.teamId));
    if (filters.runId) {
      conditions.push(or(eq(memoryLocalRecords.scopeRunId, filters.runId), eq(memoryLocalRecords.sourceRunId, filters.runId))!);
    }
    if (filters.sourceKind) conditions.push(eq(memoryLocalRecords.sourceKind, filters.sourceKind));
    if (filters.q) {
      const pattern = `%${filters.q}%`;
      conditions.push(
        or(
          ilike(memoryLocalRecords.title, pattern),
          ilike(memoryLocalRecords.content, pattern),
          ilike(memoryLocalRecords.summary, pattern),
        )!,
      );
    }
    if (!filters.includeDeleted) conditions.push(isNull(memoryLocalRecords.deletedAt));
    if (!filters.includeRevoked) conditions.push(isNull(memoryLocalRecords.revokedAt));
    if (!filters.includeExpired) {
      conditions.push(or(isNull(memoryLocalRecords.expiresAt), sql`${memoryLocalRecords.expiresAt} > now()`)!);
      conditions.push(or(isNull(memoryLocalRecords.retentionState), eq(memoryLocalRecords.retentionState, "active"))!);
    }
    if (!filters.includeSuperseded) conditions.push(isNull(memoryLocalRecords.supersededByRecordId));

    if (actor.actorType === "agent") {
      const scope: MemoryScope = {
        agentId: filters.agentId ?? actor.agentId,
        workspaceId: filters.workspaceId ?? null,
        projectId: filters.projectId ?? null,
        issueId: filters.issueId ?? null,
        runId: filters.runId ?? null,
        teamId: filters.teamId ?? null,
      };
      conditions.push(
        ...buildRecordVisibilityConditions(companyId, filters.bindingId ?? "", scope, actor, {
          includeDeleted: filters.includeDeleted,
          includeExpired: filters.includeExpired,
          includeRevoked: filters.includeRevoked,
          includeSuperseded: filters.includeSuperseded,
        }).filter((condition, index) => index > 1),
      );
    }

    const rows = await db
      .select()
      .from(memoryLocalRecords)
      .where(and(...conditions))
      .orderBy(desc(memoryLocalRecords.createdAt))
      .limit(filters.limit);
    return rows.map((row) => mapRecord(row));
  }

  async function logOperation(input: {
    id?: string;
    companyId: string;
    binding: BindingRow;
    actor: ActorInfo;
    operationType: MemoryOperation["operationType"];
    triggerKind: MemoryOperation["triggerKind"];
    hookKind?: MemoryOperation["hookKind"];
    scope: MemoryScope;
    source?: MemorySourceRef | null;
    queryText?: string | null;
    requestJson?: Record<string, unknown> | null;
    resultJson?: Record<string, unknown> | null;
    policyDecision?: Record<string, unknown> | null;
    revocationSelector?: Record<string, unknown> | null;
    retentionAction?: Record<string, unknown> | null;
    recordCount?: number;
    usage?: MemoryUsage[];
    error?: string | null;
  }) {
    const costEventId = await createDirectCostEvent(
      db,
      input.companyId,
      input.actor,
      input.scope,
      input.usage ?? [],
    );
    const [row] = await db
      .insert(memoryOperations)
      .values({
        id: input.id ?? randomUUID(),
        companyId: input.companyId,
        bindingId: input.binding.id,
        providerKey: input.binding.providerKey,
        operationType: input.operationType,
        triggerKind: input.triggerKind,
        hookKind: input.hookKind ?? null,
        status: input.error ? "failed" : "succeeded",
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId ?? null,
        userId: input.actor.userId ?? null,
        scopeAgentId: input.scope.agentId ?? null,
        scopeProjectId: input.scope.projectId ?? null,
        scopeIssueId: input.scope.issueId ?? null,
        scopeRunId: input.scope.runId ?? input.actor.runId ?? null,
        scopeSubjectId: input.scope.subjectId ?? null,
        scopeType: input.scope.scopeType ?? normalizeScopeType(input.scope),
        scopeId: input.scope.scopeId ?? normalizeScopeId(input.companyId, input.scope.scopeType ?? normalizeScopeType(input.scope), input.scope),
        scopeWorkspaceId: input.scope.workspaceId ?? null,
        scopeTeamId: input.scope.teamId ?? null,
        maxSensitivityLabel: input.scope.maxSensitivityLabel ?? null,
        sourceKind: input.source?.kind ?? null,
        sourceIssueId: input.source?.issueId ?? null,
        sourceCommentId: input.source?.commentId ?? null,
        sourceDocumentKey: input.source?.documentKey ?? null,
        sourceRunId: input.source?.runId ?? null,
        sourceActivityId: input.source?.activityId ?? null,
        sourceExternalRef: input.source?.externalRef ?? null,
        queryText: input.queryText ?? null,
        recordCount: input.recordCount ?? 0,
        requestJson: input.requestJson ?? null,
        resultJson: input.resultJson ?? null,
        policyDecisionJson: input.policyDecision ?? null,
        revocationSelectorJson: input.revocationSelector ?? null,
        retentionActionJson: input.retentionAction ?? null,
        usageJson: (input.usage ?? []) as unknown as Array<Record<string, unknown>>,
        error: input.error ?? null,
        costEventId,
        financeEventId: null,
      })
      .returning();
    return mapOperation(row);
  }

  function ensureBindingEnabled(binding: BindingRow | null): BindingRow {
    if (!binding) {
      throw notFound("No memory binding is configured");
    }
    if (!binding.enabled) {
      throw conflict("Resolved memory binding is disabled");
    }
    return binding;
  }

  function isPluginProvider(providerKey: string) {
    return providerKey !== LOCAL_BASIC_PROVIDER_KEY;
  }

  function isHookEnabled(
    binding: BindingRow,
    hook: "preRunHydrate" | "postRunCapture" | "issueCommentCapture" | "issueDocumentCapture",
  ) {
    if (binding.providerKey !== LOCAL_BASIC_PROVIDER_KEY) {
      return true;
    }

    const config = parseLocalBasicConfig(binding.config);
    switch (hook) {
      case "preRunHydrate":
        return config.enablePreRunHydrate;
      case "postRunCapture":
        return config.enablePostRunCapture;
      case "issueCommentCapture":
        return config.enableIssueCommentCapture;
      case "issueDocumentCapture":
        return config.enableIssueDocumentCapture;
    }
  }

  function getHydrateTopK(binding: BindingRow) {
    if (binding.providerKey === LOCAL_BASIC_PROVIDER_KEY) {
      return parseLocalBasicConfig(binding.config).maxHydrateSnippets;
    }

    const raw = binding.config?.topK;
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? Math.min(Math.max(Math.floor(raw), 1), 25)
      : 5;
  }

  const service = {
    providers: async () => {
      const pluginProviders = pluginMemoryProviders?.listProviders() ?? [];
      return [LOCAL_BASIC_PROVIDER, ...pluginProviders];
    },

    getBindingById: async (bindingId: string) => {
      const row = await db
        .select()
        .from(memoryBindings)
        .where(eq(memoryBindings.id, bindingId))
        .then((rows) => rows[0] ?? null);
      return row ? mapBinding(row) : null;
    },

    listBindings: async (companyId: string) => {
      const rows = await db
        .select()
        .from(memoryBindings)
        .where(eq(memoryBindings.companyId, companyId))
        .orderBy(memoryBindings.key);
      return rows.map((row) => mapBinding(row));
    },

    listTargets: async (companyId: string) => {
      const rows = await db
        .select()
        .from(memoryBindingTargets)
        .where(eq(memoryBindingTargets.companyId, companyId))
        .orderBy(memoryBindingTargets.targetType, memoryBindingTargets.targetId);
      return rows.map((row) => mapTarget(row));
    },

    createBinding: async (companyId: string, data: unknown) => {
      const parsed = createMemoryBindingSchema.parse(data);
      const normalizedConfig = await validateProviderConfig(parsed.providerKey, parsed.config);
      const existing = await db
        .select({ id: memoryBindings.id })
        .from(memoryBindings)
        .where(and(eq(memoryBindings.companyId, companyId), eq(memoryBindings.key, parsed.key)))
        .then((rows) => rows[0] ?? null);
      if (existing) throw conflict("Memory binding key already exists");

      const [row] = await db
        .insert(memoryBindings)
        .values({
          companyId,
          key: parsed.key,
          name: parsed.name ?? null,
          providerKey: parsed.providerKey,
          config: normalizedConfig,
          enabled: parsed.enabled,
        })
        .returning();
      return mapBinding(row);
    },

    updateBinding: async (bindingId: string, data: unknown) => {
      const parsed = updateMemoryBindingSchema.parse(data);
      const current = await getBindingOrThrow(bindingId);
      const normalizedConfig = parsed.config
        ? await validateProviderConfig(current.providerKey, parsed.config)
        : current.config;
      const [row] = await db
        .update(memoryBindings)
        .set({
          name: parsed.name === undefined ? current.name : parsed.name ?? null,
          config: normalizedConfig,
          enabled: parsed.enabled ?? current.enabled,
          updatedAt: new Date(),
        })
        .where(eq(memoryBindings.id, bindingId))
        .returning();
      return mapBinding(row);
    },

    setCompanyDefault: async (companyId: string, bindingId: string) => {
      const binding = await getBindingOrThrow(bindingId);
      if (binding.companyId !== companyId) throw unprocessable("Binding does not belong to company");
      await db
        .delete(memoryBindingTargets)
        .where(
          and(
            eq(memoryBindingTargets.companyId, companyId),
            eq(memoryBindingTargets.targetType, "company"),
            eq(memoryBindingTargets.targetId, companyId),
          ),
        );
      const [row] = await db
        .insert(memoryBindingTargets)
        .values({
          companyId,
          bindingId,
          targetType: "company",
          targetId: companyId,
        })
        .returning();
      return mapTarget(row);
    },

    setAgentOverride: async (agentId: string, bindingId: string | null) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");

      await db
        .delete(memoryBindingTargets)
        .where(
          and(
            eq(memoryBindingTargets.companyId, agent.companyId),
            eq(memoryBindingTargets.targetType, "agent"),
            eq(memoryBindingTargets.targetId, agent.id),
          ),
        );

      if (!bindingId) return null;
      const binding = await getBindingOrThrow(bindingId);
      if (binding.companyId !== agent.companyId) throw unprocessable("Binding does not belong to agent company");

      const [row] = await db
        .insert(memoryBindingTargets)
        .values({
          companyId: agent.companyId,
          bindingId,
          targetType: "agent",
          targetId: agent.id,
        })
        .returning();
      return mapTarget(row);
    },

    setProjectOverride: async (projectId: string, bindingId: string | null) => {
      const project = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Project not found");

      await db
        .delete(memoryBindingTargets)
        .where(
          and(
            eq(memoryBindingTargets.companyId, project.companyId),
            eq(memoryBindingTargets.targetType, "project"),
            eq(memoryBindingTargets.targetId, project.id),
          ),
        );

      if (!bindingId) return null;
      const binding = await getBindingOrThrow(bindingId);
      if (binding.companyId !== project.companyId) throw unprocessable("Binding does not belong to project company");

      const [row] = await db
        .insert(memoryBindingTargets)
        .values({
          companyId: project.companyId,
          bindingId,
          targetType: "project",
          targetId: project.id,
        })
        .returning();
      return mapTarget(row);
    },

    resolveBinding: async (companyId: string, scope: MemoryScope): Promise<MemoryResolvedBinding> => {
      const resolved = await resolveBindingInternal(companyId, scope, null);
      return {
        companyId,
        targetType: resolved.targetType,
        targetId: resolved.targetId,
        binding: resolved.binding ? mapBinding(resolved.binding) : null,
        source: resolved.source,
        checkedTargetTypes: resolved.checkedTargetTypes,
      };
    },

    query: async (companyId: string, data: MemoryQuery, actor: ActorInfo, triggerKind: MemoryOperation["triggerKind"] = "manual", hookKind?: MemoryOperation["hookKind"]) => {
      const resolved = await resolveBindingInternal(companyId, data.scope ?? {}, data.bindingKey);
      const binding = ensureBindingEnabled(resolved.binding);
      let records: MemoryRecord[];
      let preamble: string | null = null;
      let usage: MemoryUsage[] = [];
      let providerResultJson: Record<string, unknown> | null = null;

      if (binding.providerKey === LOCAL_BASIC_PROVIDER_KEY) {
        const config = parseLocalBasicConfig(binding.config);
        records = await queryLocalBasic(
          binding,
          data.scope ?? {},
          data.query,
          Math.min(data.topK ?? config.maxHydrateSnippets, 25),
          actor,
        );
      } else {
        if (!pluginMemoryProviders) {
          throw unprocessable(`Unknown memory provider: ${binding.providerKey}`);
        }
        const providerResult = await pluginMemoryProviders.query(binding.providerKey, {
          binding: mapBinding(binding),
          scope: data.scope ?? {},
          query: data.query,
          topK: Math.min(data.topK ?? getHydrateTopK(binding), 25),
          intent: data.intent,
          metadataFilter: data.metadataFilter,
        });
        records = await overlayCatalogRecordState(companyId, binding.id, providerResult.records);
        preamble = providerResult.preamble ?? null;
        usage = providerResult.usage ?? [];
        providerResultJson = providerResult.resultJson ?? null;
      }
      const allowedScopes = deriveAllowedScopes(companyId, data.scope ?? {}, actor);
      const maxSensitivityLabel = maxSensitivityForActor(actor, data.scope ?? {});
      if (actor.actorType === "agent" || data.scope?.allowedScopes?.length) {
        records = records.filter((record) => scopeMatches(record, allowedScopes));
      }
      records = records.filter(
        (record) =>
          !record.deletedAt
          && !record.revokedAt
          && record.retentionState === "active"
          && record.reviewState === "accepted"
          && !record.supersededByRecordId
          && (!record.expiresAt || record.expiresAt > new Date())
          && SENSITIVITY_RANK[record.sensitivityLabel] <= SENSITIVITY_RANK[maxSensitivityLabel],
      );

      if (data.intent === "agent_preamble" && !preamble) {
        preamble = buildMemoryPreamble(records);
      }
      const operation = await logOperation({
        companyId,
        binding,
        actor,
        operationType: "query",
        triggerKind,
        hookKind,
        scope: data.scope ?? {},
        queryText: data.query,
        requestJson: {
          topK: data.topK ?? null,
          intent: data.intent,
          metadataFilter: data.metadataFilter ?? null,
        },
        resultJson: {
          preamble,
          recordIds: records.map((record) => record.id),
          providerResult: providerResultJson,
        },
        policyDecision: {
          allowedScopes,
          maxSensitivityLabel,
          filteredRecordCount: records.length,
        },
        recordCount: records.length,
        usage,
      });
      return { operation, records, preamble } satisfies MemoryQueryResult;
    },

    capture: async (companyId: string, data: MemoryCapture, actor: ActorInfo, triggerKind: MemoryOperation["triggerKind"] = "manual", hookKind?: MemoryOperation["hookKind"]) => {
      const resolved = await resolveBindingInternal(companyId, data.scope ?? {}, data.bindingKey);
      const binding = ensureBindingEnabled(resolved.binding);
      const operationId = randomUUID();
      let records: MemoryRecord[];
      let usage: MemoryUsage[] = [];
      let providerResultJson: Record<string, unknown> | null = null;

      if (binding.providerKey === LOCAL_BASIC_PROVIDER_KEY) {
        records = await captureLocalBasic(
          binding,
          data.scope ?? {},
          data.source,
          {
            actor,
            scopeType: data.scopeType ?? data.scope?.scopeType ?? null,
            scopeId: data.scopeId ?? data.scope?.scopeId ?? null,
            owner: data.owner ?? null,
            sensitivityLabel: data.sensitivityLabel,
            retentionPolicy: data.retentionPolicy ?? null,
            expiresAt: data.expiresAt ?? null,
            citation: data.citation ?? null,
            title: data.title ?? null,
            content: data.content,
            summary: data.summary ?? null,
            metadata: data.metadata ?? {},
            reviewState: data.reviewState,
          },
          operationId,
        );
      } else {
        if (!pluginMemoryProviders) {
          throw unprocessable(`Unknown memory provider: ${binding.providerKey}`);
        }
        const providerResult = await pluginMemoryProviders.capture(binding.providerKey, {
          binding: mapBinding(binding),
          scope: data.scope ?? {},
          source: data.source,
          scopeType: data.scopeType ?? data.scope?.scopeType ?? null,
          scopeId: data.scopeId ?? data.scope?.scopeId ?? null,
          owner: data.owner ?? actorPrincipal(actor),
          createdBy: actorPrincipal(actor),
          sensitivityLabel: data.sensitivityLabel,
          retentionPolicy: data.retentionPolicy ?? null,
          expiresAt: data.expiresAt ?? null,
          citation: data.citation ?? null,
          title: data.title ?? null,
          content: data.content,
          summary: data.summary ?? null,
          metadata: data.metadata ?? {},
        });
        records = providerResult.records;
        usage = providerResult.usage ?? [];
        providerResultJson = providerResult.resultJson ?? null;
        await persistCatalogRecords(binding, records, operationId);
      }
      const operation = await logOperation({
        id: operationId,
        companyId,
        binding,
        actor,
        operationType: data.title || data.summary ? "upsert" : "capture",
        triggerKind,
        hookKind,
        scope: data.scope ?? {},
        source: data.source,
        requestJson: {
          title: data.title ?? null,
          scopeType: data.scopeType ?? data.scope?.scopeType ?? null,
          scopeId: data.scopeId ?? data.scope?.scopeId ?? null,
          owner: data.owner ?? null,
          sensitivityLabel: data.sensitivityLabel,
          reviewState: data.reviewState,
          expiresAt: data.expiresAt ? new Date(data.expiresAt).toISOString() : null,
          metadata: data.metadata ?? {},
        },
        policyDecision: {
          captureAllowed: true,
          sensitivityLabel: data.sensitivityLabel,
          reviewState: data.reviewState,
        },
        resultJson: {
          recordIds: records.map((record) => record.id),
          providerResult: providerResultJson,
        },
        recordCount: records.length,
        usage,
      });
      return { operation, records } satisfies MemoryCaptureResult;
    },

    forget: async (companyId: string, data: MemoryForget, actor: ActorInfo, triggerKind: MemoryOperation["triggerKind"] = "manual") => {
      const rows = await db
        .select()
        .from(memoryLocalRecords)
        .where(and(eq(memoryLocalRecords.companyId, companyId), inArray(memoryLocalRecords.id, data.recordIds)));
      const recordIds = rows.map((row) => row.id);
      if (recordIds.length === 0) {
        throw notFound("Memory records not found");
      }
      const bindingIds = new Set(rows.map((row) => row.bindingId));
      if (bindingIds.size > 1) {
        throw unprocessable("Memory records must belong to the same binding");
      }
      const binding = await getBindingOrThrow(rows[0].bindingId);
      let usage: MemoryUsage[] = [];
      let providerResultJson: Record<string, unknown> | null = null;
      if (isPluginProvider(binding.providerKey)) {
        if (!pluginMemoryProviders) {
          throw unprocessable(`Unknown memory provider: ${binding.providerKey}`);
        }
        const providerResult = await pluginMemoryProviders.forget(binding.providerKey, {
          binding: mapBinding(binding),
          scope: data.scope ?? {},
          recordIds,
        });
        usage = providerResult.usage ?? [];
        providerResultJson = providerResult.resultJson ?? null;
      }
      await db
        .update(memoryLocalRecords)
        .set({
          deletedAt: new Date(),
          revokedAt: new Date(),
          revokedByActorType: actorPrincipal(actor).type,
          revokedByActorId: actorPrincipal(actor).id,
          revocationReason: data.reason ?? "Record forgotten",
          retentionState: "revoked",
          updatedAt: new Date(),
        })
        .where(and(eq(memoryLocalRecords.companyId, companyId), inArray(memoryLocalRecords.id, recordIds)));
      const operation = await logOperation({
        companyId,
        binding,
        actor,
        operationType: "forget",
        triggerKind,
        scope: data.scope ?? {},
        requestJson: { recordIds, reason: data.reason ?? null },
        revocationSelector: { recordIds },
        resultJson: { forgottenRecordIds: recordIds, providerResult: providerResultJson },
        recordCount: recordIds.length,
        usage,
      });
      return { operation, forgottenRecordIds: recordIds } satisfies MemoryForgetResult;
    },

    revoke: async (companyId: string, data: MemoryRevoke, actor: ActorInfo): Promise<MemoryRevokeResult> => {
      const parsed = memoryRevokeSchema.parse(data);
      const conditions = [eq(memoryLocalRecords.companyId, companyId), isNull(memoryLocalRecords.revokedAt)];
      const selector = parsed.selector;
      if (selector.recordIds?.length) conditions.push(inArray(memoryLocalRecords.id, selector.recordIds));
      if (selector.scopeType) conditions.push(eq(memoryLocalRecords.scopeType, selector.scopeType));
      if (selector.scopeId !== undefined) {
        conditions.push(selector.scopeId === null ? isNull(memoryLocalRecords.scopeId) : eq(memoryLocalRecords.scopeId, selector.scopeId));
      }
      if (selector.agentId) conditions.push(eq(memoryLocalRecords.scopeAgentId, selector.agentId));
      if (selector.workspaceId) conditions.push(eq(memoryLocalRecords.scopeWorkspaceId, selector.workspaceId));
      if (selector.projectId) conditions.push(eq(memoryLocalRecords.scopeProjectId, selector.projectId));
      if (selector.teamId) conditions.push(eq(memoryLocalRecords.scopeTeamId, selector.teamId));
      if (selector.issueId) {
        conditions.push(or(eq(memoryLocalRecords.scopeIssueId, selector.issueId), eq(memoryLocalRecords.sourceIssueId, selector.issueId))!);
      }
      if (selector.runId) {
        conditions.push(or(eq(memoryLocalRecords.scopeRunId, selector.runId), eq(memoryLocalRecords.sourceRunId, selector.runId))!);
      }
      if (selector.source) {
        conditions.push(eq(memoryLocalRecords.sourceKind, selector.source.kind));
        if (selector.source.issueId) conditions.push(eq(memoryLocalRecords.sourceIssueId, selector.source.issueId));
        if (selector.source.commentId) conditions.push(eq(memoryLocalRecords.sourceCommentId, selector.source.commentId));
        if (selector.source.documentKey) conditions.push(eq(memoryLocalRecords.sourceDocumentKey, selector.source.documentKey));
        if (selector.source.runId) conditions.push(eq(memoryLocalRecords.sourceRunId, selector.source.runId));
        if (selector.source.activityId) conditions.push(eq(memoryLocalRecords.sourceActivityId, selector.source.activityId));
        if (selector.source.externalRef) conditions.push(eq(memoryLocalRecords.sourceExternalRef, selector.source.externalRef));
      }

      const rows = await db.select().from(memoryLocalRecords).where(and(...conditions));
      if (rows.length === 0) throw notFound("No memory records matched revocation selector");

      const revokedAt = new Date();
      const principal = actorPrincipal(actor);
      const revokedRecordIds = rows.map((row) => row.id);
      const operations: MemoryOperation[] = [];
      const rowsByBinding = new Map<string, RecordRow[]>();
      for (const row of rows) {
        rowsByBinding.set(row.bindingId, [...(rowsByBinding.get(row.bindingId) ?? []), row]);
      }

      for (const [bindingId, bindingRows] of rowsByBinding) {
        const binding = await getBindingOrThrow(bindingId);
        let usage: MemoryUsage[] = [];
        let providerResultJson: Record<string, unknown> | null = null;
        const bindingRecordIds = bindingRows.map((row) => row.id);
        if (isPluginProvider(binding.providerKey)) {
          if (!pluginMemoryProviders) {
            throw unprocessable(`Unknown memory provider: ${binding.providerKey}`);
          }
          const providerResult = await pluginMemoryProviders.forget(binding.providerKey, {
            binding: mapBinding(binding),
            scope: {},
            recordIds: bindingRecordIds,
          });
          usage = providerResult.usage ?? [];
          providerResultJson = providerResult.resultJson ?? null;
        }
        await db
          .update(memoryLocalRecords)
          .set({
            revokedAt,
            revokedByActorType: principal.type,
            revokedByActorId: principal.id,
            revocationReason: parsed.reason,
            retentionState: "revoked",
            updatedAt: revokedAt,
          })
          .where(and(eq(memoryLocalRecords.companyId, companyId), inArray(memoryLocalRecords.id, bindingRecordIds)));

        operations.push(
          await logOperation({
            companyId,
            binding,
            actor,
            operationType: "revoke",
            triggerKind: "manual",
            scope: {},
            requestJson: { reason: parsed.reason },
            revocationSelector: selector,
            resultJson: { revokedRecordIds: bindingRecordIds, providerResult: providerResultJson },
            recordCount: bindingRecordIds.length,
            usage,
          }),
        );
      }

      return { operations, revokedRecordIds } satisfies MemoryRevokeResult;
    },

    correct: async (
      companyId: string,
      recordId: string,
      data: MemoryCorrect,
      actor: ActorInfo,
    ): Promise<MemoryCorrectResult> => {
      const parsed = memoryCorrectSchema.parse(data);
      const originalRow = await db
        .select()
        .from(memoryLocalRecords)
        .where(and(eq(memoryLocalRecords.companyId, companyId), eq(memoryLocalRecords.id, recordId)))
        .then((rows) => rows[0] ?? null);
      if (!originalRow) throw notFound("Memory record not found");
      if (originalRow.revokedAt || originalRow.retentionState === "revoked") {
        throw conflict("Revoked memory records cannot be corrected");
      }
      if (originalRow.supersededByRecordId) {
        throw conflict("Memory record has already been corrected");
      }
      const binding = await getBindingOrThrow(originalRow.bindingId);
      const operationId = randomUUID();
      const principal = actorPrincipal(actor);
      const correctedRecordId = randomUUID();
      const correctedAt = new Date();
      const [correctedRow] = await db
        .insert(memoryLocalRecords)
        .values({
          id: correctedRecordId,
          companyId,
          bindingId: originalRow.bindingId,
          providerKey: originalRow.providerKey,
          scopeAgentId: originalRow.scopeAgentId,
          scopeProjectId: originalRow.scopeProjectId,
          scopeIssueId: originalRow.scopeIssueId,
          scopeRunId: originalRow.scopeRunId,
          scopeSubjectId: originalRow.scopeSubjectId,
          scopeType: originalRow.scopeType,
          scopeId: originalRow.scopeId,
          scopeWorkspaceId: originalRow.scopeWorkspaceId,
          scopeTeamId: originalRow.scopeTeamId,
          sourceKind: originalRow.sourceKind,
          sourceIssueId: originalRow.sourceIssueId,
          sourceCommentId: originalRow.sourceCommentId,
          sourceDocumentKey: originalRow.sourceDocumentKey,
          sourceRunId: originalRow.sourceRunId,
          sourceActivityId: originalRow.sourceActivityId,
          sourceExternalRef: originalRow.sourceExternalRef,
          title: parsed.title === undefined ? originalRow.title : parsed.title ?? null,
          content: parsed.content,
          summary: parsed.summary === undefined ? originalRow.summary : parsed.summary ?? null,
          metadata: {
            ...(originalRow.metadata ?? {}),
            correctionReason: parsed.reason,
            correctedFromRecordId: originalRow.id,
          },
          ownerType: originalRow.ownerType,
          ownerId: originalRow.ownerId,
          createdByActorType: principal.type,
          createdByActorId: principal.id,
          sensitivityLabel: parsed.sensitivityLabel ?? originalRow.sensitivityLabel,
          retentionPolicy: parsed.retentionPolicy === undefined ? originalRow.retentionPolicy : parsed.retentionPolicy,
          expiresAt: parsed.expiresAt === undefined ? originalRow.expiresAt : parsed.expiresAt,
          retentionState: "active",
          reviewState: "accepted",
          reviewedAt: correctedAt,
          reviewedByActorType: principal.type,
          reviewedByActorId: principal.id,
          reviewNote: parsed.reason,
          citationJson: parsed.citation === undefined ? originalRow.citationJson : normalizeCitation(parsed.citation),
          supersedesRecordId: originalRow.id,
          createdByOperationId: operationId,
          createdAt: correctedAt,
          updatedAt: correctedAt,
        })
        .returning();
      await db
        .update(memoryLocalRecords)
        .set({ supersededByRecordId: correctedRecordId, updatedAt: correctedAt })
        .where(and(eq(memoryLocalRecords.companyId, companyId), eq(memoryLocalRecords.id, originalRow.id)));

      const operation = await logOperation({
        id: operationId,
        companyId,
        binding,
        actor,
        operationType: "correct",
        triggerKind: "manual",
        scope: scopeFromRow(originalRow),
        source: sourceFromRow(originalRow),
        requestJson: {
          recordId,
          reason: parsed.reason,
          sensitivityLabel: parsed.sensitivityLabel ?? null,
          expiresAt: parsed.expiresAt ? parsed.expiresAt.toISOString() : null,
        },
        resultJson: {
          originalRecordId: originalRow.id,
          correctedRecordId,
        },
        recordCount: 1,
      });

      return {
        operation,
        originalRecord: mapRecord({ ...originalRow, supersededByRecordId: correctedRecordId, updatedAt: correctedAt }),
        correctedRecord: mapRecord(correctedRow),
      } satisfies MemoryCorrectResult;
    },

    review: async (
      companyId: string,
      recordId: string,
      data: MemoryReview,
      actor: ActorInfo,
    ): Promise<MemoryReviewResult> => {
      const parsed = memoryReviewSchema.parse(data);
      const row = await db
        .select()
        .from(memoryLocalRecords)
        .where(and(eq(memoryLocalRecords.companyId, companyId), eq(memoryLocalRecords.id, recordId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Memory record not found");
      if (row.deletedAt || row.revokedAt || row.retentionState === "revoked") {
        throw conflict("Revoked memory records cannot be reviewed");
      }

      const binding = await getBindingOrThrow(row.bindingId);
      const reviewedAt = new Date();
      const principal = actorPrincipal(actor);
      const [updatedRow] = await db
        .update(memoryLocalRecords)
        .set({
          reviewState: parsed.reviewState,
          reviewedAt,
          reviewedByActorType: principal.type,
          reviewedByActorId: principal.id,
          reviewNote: parsed.note ?? null,
          updatedAt: reviewedAt,
        })
        .where(and(eq(memoryLocalRecords.companyId, companyId), eq(memoryLocalRecords.id, recordId)))
        .returning();

      const operation = await logOperation({
        companyId,
        binding,
        actor,
        operationType: "review",
        triggerKind: "manual",
        scope: scopeFromRow(row),
        source: sourceFromRow(row),
        requestJson: {
          recordId,
          reviewState: parsed.reviewState,
          note: parsed.note ?? null,
        },
        resultJson: {
          recordId,
          reviewState: parsed.reviewState,
        },
        recordCount: 1,
      });

      return { operation, record: mapRecord(updatedRow) } satisfies MemoryReviewResult;
    },

    sweepRetention: async (
      companyId: string,
      data: MemoryRetentionSweep,
      actor: ActorInfo,
    ): Promise<MemoryRetentionSweepResult> => {
      const parsed = memoryRetentionSweepSchema.parse(data);
      const now = parsed.now ?? new Date();
      const conditions = [
        eq(memoryLocalRecords.companyId, companyId),
        eq(memoryLocalRecords.retentionState, "active"),
        isNull(memoryLocalRecords.revokedAt),
        isNotNull(memoryLocalRecords.expiresAt),
        lte(memoryLocalRecords.expiresAt, now),
      ];
      if (parsed.bindingId) conditions.push(eq(memoryLocalRecords.bindingId, parsed.bindingId));
      const rows = await db
        .select()
        .from(memoryLocalRecords)
        .where(and(...conditions))
        .orderBy(memoryLocalRecords.expiresAt)
        .limit(parsed.limit);
      if (rows.length === 0) return { operations: [], expiredRecordIds: [] };

      const expiredRecordIds = rows.map((row) => row.id);
      await db
        .update(memoryLocalRecords)
        .set({ retentionState: "expired", updatedAt: now })
        .where(and(eq(memoryLocalRecords.companyId, companyId), inArray(memoryLocalRecords.id, expiredRecordIds)));

      const operations: MemoryOperation[] = [];
      const rowsByBinding = new Map<string, RecordRow[]>();
      for (const row of rows) {
        rowsByBinding.set(row.bindingId, [...(rowsByBinding.get(row.bindingId) ?? []), row]);
      }
      for (const [bindingId, bindingRows] of rowsByBinding) {
        const binding = await getBindingOrThrow(bindingId);
        operations.push(
          await logOperation({
            companyId,
            binding,
            actor,
            operationType: "retention_sweep",
            triggerKind: "manual",
            scope: {},
            retentionAction: {
              now: now.toISOString(),
              expiredRecordIds: bindingRows.map((row) => row.id),
            },
            resultJson: {
              expiredRecordIds: bindingRows.map((row) => row.id),
            },
            recordCount: bindingRows.length,
          }),
        );
      }

      return { operations, expiredRecordIds } satisfies MemoryRetentionSweepResult;
    },

    listRecords: async (companyId: string, filters: MemoryListRecordsQuery, actor: ActorInfo) =>
      listLocalBasic(companyId, filters, actor),

    getRecord: async (companyId: string, recordId: string, actor?: ActorInfo) => {
      const row = await db
        .select()
        .from(memoryLocalRecords)
        .where(and(eq(memoryLocalRecords.companyId, companyId), eq(memoryLocalRecords.id, recordId)))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const record = mapRecord(row);
      if (actor && !canReadRecord(companyId, record, actor, record.scope)) return null;
      return record;
    },

    listOperations: async (companyId: string, filters: MemoryListOperationsQuery) => {
      const conditions = [eq(memoryOperations.companyId, companyId)];
      if (filters.bindingId) conditions.push(eq(memoryOperations.bindingId, filters.bindingId));
      if (filters.operationType) conditions.push(eq(memoryOperations.operationType, filters.operationType));
      if (filters.status) conditions.push(eq(memoryOperations.status, filters.status));
      if (filters.hookKind) conditions.push(eq(memoryOperations.hookKind, filters.hookKind));
      if (filters.agentId) conditions.push(eq(memoryOperations.scopeAgentId, filters.agentId));
      if (filters.issueId) conditions.push(eq(memoryOperations.scopeIssueId, filters.issueId));
      if (filters.runId) conditions.push(eq(memoryOperations.scopeRunId, filters.runId));
      const rows = await db
        .select()
        .from(memoryOperations)
        .where(and(...conditions))
        .orderBy(desc(memoryOperations.occurredAt), desc(memoryOperations.createdAt))
        .limit(filters.limit);
      return rows.map((row) => mapOperation(row));
    },

    listExtractionJobs: async (companyId: string, filters: MemoryListExtractionJobsQuery) => {
      const conditions = [eq(memoryExtractionJobs.companyId, companyId)];
      if (filters.bindingId) conditions.push(eq(memoryExtractionJobs.bindingId, filters.bindingId));
      const rows = await db
        .select()
        .from(memoryExtractionJobs)
        .where(and(...conditions))
        .orderBy(desc(memoryExtractionJobs.createdAt))
        .limit(filters.limit);
      return rows.map((row) => mapExtractionJob(row));
    },

    preRunHydrate: async (input: {
      companyId: string;
      agentId: string;
      projectId?: string | null;
      issueId?: string | null;
      runId: string;
      query: string;
    }): Promise<MemoryPreRunHydrateResult> => {
      const resolved = await resolveBindingInternal(
        input.companyId,
        {
          agentId: input.agentId,
          projectId: input.projectId ?? null,
          issueId: input.issueId ?? null,
          runId: input.runId,
        },
        null,
      );
      if (!resolved.binding || !resolved.binding.enabled) {
        return {
          preamble: null,
          trace: buildSkippedMemoryHookTrace({
            hookKind: "pre_run_hydrate",
            reason: resolved.binding ? "binding_disabled" : "no_binding",
            binding: resolved.binding ? mapBinding(resolved.binding) : null,
          }),
        };
      }
      if (!isHookEnabled(resolved.binding, "preRunHydrate")) {
        return {
          preamble: null,
          trace: buildSkippedMemoryHookTrace({
            hookKind: "pre_run_hydrate",
            reason: "hook_disabled",
            binding: mapBinding(resolved.binding),
          }),
        };
      }
      const result = await service.query(
        input.companyId,
        {
          scope: {
            scopeType: "run",
            scopeId: input.runId,
            agentId: input.agentId,
            projectId: input.projectId ?? null,
            issueId: input.issueId ?? null,
            runId: input.runId,
          },
          query: input.query,
          topK: getHydrateTopK(resolved.binding),
          intent: "agent_preamble",
        },
        {
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          userId: null,
          runId: input.runId,
        },
        "hook",
        "pre_run_hydrate",
      );
      return {
        preamble: result.preamble,
        trace: buildPreRunHydrateTrace(mapBinding(resolved.binding), result),
      };
    },

    captureRunSummary: async (input: {
      companyId: string;
      agentId: string;
      projectId?: string | null;
      issueId?: string | null;
      runId: string;
      title?: string | null;
      summary: string;
    }): Promise<MemoryPostRunCaptureResult> => {
      const resolved = await resolveBindingInternal(
        input.companyId,
        {
          agentId: input.agentId,
          projectId: input.projectId ?? null,
          issueId: input.issueId ?? null,
          runId: input.runId,
        },
        null,
      );
      if (!resolved.binding || !resolved.binding.enabled) {
        return {
          trace: buildSkippedMemoryHookTrace({
            hookKind: "post_run_capture",
            reason: resolved.binding ? "binding_disabled" : "no_binding",
            binding: resolved.binding ? mapBinding(resolved.binding) : null,
          }),
        };
      }
      if (!isHookEnabled(resolved.binding, "postRunCapture")) {
        return {
          trace: buildSkippedMemoryHookTrace({
            hookKind: "post_run_capture",
            reason: "hook_disabled",
            binding: mapBinding(resolved.binding),
          }),
        };
      }
      const result = await service.capture(
        input.companyId,
        {
          scope: {
            scopeType: "run",
            scopeId: input.runId,
            agentId: input.agentId,
            projectId: input.projectId ?? null,
            issueId: input.issueId ?? null,
            runId: input.runId,
          },
          scopeType: "run",
          scopeId: input.runId,
          source: {
            kind: "run",
            issueId: input.issueId ?? null,
            runId: input.runId,
          },
          sensitivityLabel: "internal",
          citation: {
            label: "Run summary",
            sourceTitle: input.title ?? "Run summary",
          },
          title: input.title ?? "Run summary",
          content: input.summary,
          summary: input.summary,
          reviewState: "accepted",
        },
        {
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          userId: null,
          runId: input.runId,
        },
        "hook",
        "post_run_capture",
      );
      return {
        trace: buildPostRunCaptureTrace(mapBinding(resolved.binding), result),
      };
    },

    captureIssueComment: async (input: {
      companyId: string;
      issueId: string;
      commentId: string;
      agentId?: string | null;
      projectId?: string | null;
      body: string;
      actor: ActorInfo;
    }) => {
      const resolved = await resolveBindingInternal(
        input.companyId,
        {
          agentId: input.agentId ?? null,
          projectId: input.projectId ?? null,
          issueId: input.issueId,
        },
        null,
      );
      if (!resolved.binding || !resolved.binding.enabled) return null;
      if (!isHookEnabled(resolved.binding, "issueCommentCapture")) return null;
      return service.capture(
        input.companyId,
        {
          scope: {
            scopeType: input.projectId ? "project" : input.agentId ? "agent" : "org",
            scopeId: input.projectId ?? input.agentId ?? input.companyId,
            agentId: input.agentId ?? null,
            projectId: input.projectId ?? null,
            issueId: input.issueId,
          },
          scopeType: input.projectId ? "project" : input.agentId ? "agent" : "org",
          scopeId: input.projectId ?? input.agentId ?? input.companyId,
          source: {
            kind: "issue_comment",
            issueId: input.issueId,
            commentId: input.commentId,
          },
          citation: {
            label: "Issue comment",
            sourceTitle: `Issue comment ${input.commentId}`,
          },
          sensitivityLabel: "internal",
          title: "Issue comment",
          content: input.body,
          summary: input.body.replace(/\s+/g, " ").slice(0, 240),
          reviewState: "accepted",
        },
        input.actor,
        "hook",
        "issue_comment_capture",
      );
    },

    captureIssueDocument: async (input: {
      companyId: string;
      issueId: string;
      agentId?: string | null;
      projectId?: string | null;
      key: string;
      title?: string | null;
      body: string;
      actor: ActorInfo;
    }) => {
      const resolved = await resolveBindingInternal(
        input.companyId,
        {
          agentId: input.agentId ?? null,
          projectId: input.projectId ?? null,
          issueId: input.issueId,
        },
        null,
      );
      if (!resolved.binding || !resolved.binding.enabled) return null;
      if (!isHookEnabled(resolved.binding, "issueDocumentCapture")) return null;
      return service.capture(
        input.companyId,
        {
          scope: {
            scopeType: input.projectId ? "project" : input.agentId ? "agent" : "org",
            scopeId: input.projectId ?? input.agentId ?? input.companyId,
            agentId: input.agentId ?? null,
            projectId: input.projectId ?? null,
            issueId: input.issueId,
          },
          scopeType: input.projectId ? "project" : input.agentId ? "agent" : "org",
          scopeId: input.projectId ?? input.agentId ?? input.companyId,
          source: {
            kind: "issue_document",
            issueId: input.issueId,
            documentKey: input.key,
          },
          citation: {
            label: "Issue document",
            sourceTitle: input.title ?? input.key,
          },
          sensitivityLabel: "internal",
          title: input.title ?? `Issue document: ${input.key}`,
          content: input.body,
          summary: input.body.replace(/\s+/g, " ").slice(0, 240),
          reviewState: "accepted",
        },
        input.actor,
        "hook",
        "issue_document_capture",
      );
    },
  };

  return service;
}
