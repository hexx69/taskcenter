import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryBinding, MemoryRecord, MemoryScope, MemorySourceRef } from "@paperclipai/plugin-sdk";
import { buildFrontmatterMarkdown, parseFrontmatterMarkdown } from "./frontmatter.js";

export interface StoredMemoryRecordInput {
  record: MemoryRecord;
  bindingKey: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeScope(value: unknown): MemoryScope {
  if (!isPlainRecord(value)) return {};
  return {
    scopeType: asString(value.scopeType) as MemoryScope["scopeType"],
    scopeId: asString(value.scopeId),
    agentId: asString(value.agentId),
    workspaceId: asString(value.workspaceId),
    projectId: asString(value.projectId),
    issueId: asString(value.issueId),
    runId: asString(value.runId),
    teamId: asString(value.teamId),
    subjectId: asString(value.subjectId),
    allowedScopes: Array.isArray(value.allowedScopes)
      ? value.allowedScopes
        .filter(isPlainRecord)
        .map((scope) => ({
          type: asString(scope.type) as MemoryRecord["scopeType"],
          id: asString(scope.id),
        }))
        .filter((scope) => Boolean(scope.type))
      : null,
    maxSensitivityLabel: asString(value.maxSensitivityLabel) as MemoryScope["maxSensitivityLabel"],
  };
}

function normalizeScopeType(scope: MemoryScope, value: unknown): MemoryRecord["scopeType"] {
  const raw = asString(value);
  if (raw === "run" || raw === "agent" || raw === "workspace" || raw === "project" || raw === "team" || raw === "org") {
    return raw;
  }
  if (scope.scopeType) return scope.scopeType;
  if (scope.runId) return "run";
  if (scope.agentId) return "agent";
  if (scope.workspaceId) return "workspace";
  if (scope.projectId) return "project";
  if (scope.teamId) return "team";
  return "org";
}

function normalizeScopeId(companyId: string, scopeType: MemoryRecord["scopeType"], scope: MemoryScope, value: unknown) {
  const raw = asString(value);
  if (raw) return raw;
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

function normalizePrincipal(value: unknown): MemoryRecord["owner"] {
  if (!isPlainRecord(value)) return null;
  const type = asString(value.type);
  const id = asString(value.id);
  if (!type || !id) return null;
  return { type: type as NonNullable<MemoryRecord["owner"]>["type"], id };
}

function normalizeSensitivityLabel(value: unknown): MemoryRecord["sensitivityLabel"] {
  const raw = asString(value);
  if (raw === "public" || raw === "internal" || raw === "confidential" || raw === "restricted") return raw;
  return "internal";
}

function normalizeRetentionState(value: unknown): MemoryRecord["retentionState"] {
  const raw = asString(value);
  if (raw === "active" || raw === "expired" || raw === "revoked") return raw;
  return "active";
}

function normalizeReviewState(value: unknown): MemoryRecord["reviewState"] {
  const raw = asString(value);
  if (raw === "pending" || raw === "accepted" || raw === "rejected") return raw;
  return "pending";
}

function normalizeCitation(value: unknown): MemoryRecord["citation"] {
  return isPlainRecord(value) ? (value as MemoryRecord["citation"]) : null;
}

function normalizeSource(value: unknown): MemorySourceRef | null {
  if (!isPlainRecord(value)) return null;
  const kind = asString(value.kind);
  if (!kind) return null;
  return {
    kind: kind as MemorySourceRef["kind"],
    issueId: asString(value.issueId),
    commentId: asString(value.commentId),
    documentKey: asString(value.documentKey),
    runId: asString(value.runId),
    activityId: asString(value.activityId),
    externalRef: asString(value.externalRef),
  };
}

function sanitizePathSegment(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
}

export function resolveBindingDir(dataDir: string, binding: MemoryBinding) {
  return path.join(
    dataDir,
    "companies",
    binding.companyId,
    "bindings",
    sanitizePathSegment(binding.key),
  );
}

export function resolveRecordsDir(dataDir: string, binding: MemoryBinding) {
  return path.join(resolveBindingDir(dataDir, binding), "records");
}

export function resolveRecordPath(dataDir: string, binding: MemoryBinding, recordId: string) {
  return path.join(resolveRecordsDir(dataDir, binding), `${recordId}.md`);
}

export async function ensureBindingDirs(dataDir: string, binding: MemoryBinding) {
  await mkdir(resolveRecordsDir(dataDir, binding), { recursive: true });
}

export async function listRecordFiles(dataDir: string, binding: MemoryBinding) {
  const recordsDir = resolveRecordsDir(dataDir, binding);
  try {
    const entries = await readdir(recordsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(recordsDir, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeStoredRecord(dataDir: string, binding: MemoryBinding, input: StoredMemoryRecordInput) {
  await ensureBindingDirs(dataDir, binding);
  const frontmatter = {
    recordId: input.record.id,
    companyId: input.record.companyId,
    bindingId: input.record.bindingId,
    bindingKey: input.bindingKey,
    providerKey: input.record.providerKey,
    scope: input.record.scope,
    source: input.record.source,
    scopeType: input.record.scopeType,
    scopeId: input.record.scopeId,
    owner: input.record.owner,
    createdBy: input.record.createdBy,
    sensitivityLabel: input.record.sensitivityLabel,
    retentionPolicy: input.record.retentionPolicy,
    expiresAt: input.record.expiresAt?.toISOString() ?? null,
    retentionState: input.record.retentionState,
    reviewState: input.record.reviewState,
    reviewedAt: input.record.reviewedAt?.toISOString() ?? null,
    reviewedBy: input.record.reviewedBy,
    reviewNote: input.record.reviewNote,
    citation: input.record.citation,
    supersedesRecordId: input.record.supersedesRecordId,
    supersededByRecordId: input.record.supersededByRecordId,
    revokedAt: input.record.revokedAt?.toISOString() ?? null,
    revokedBy: input.record.revokedBy,
    revocationReason: input.record.revocationReason,
    title: input.record.title,
    summary: input.record.summary,
    metadata: input.record.metadata,
    createdAt: input.record.createdAt.toISOString(),
    updatedAt: input.record.updatedAt.toISOString(),
    deletedAt: input.record.deletedAt?.toISOString() ?? null,
  };
  await writeFile(
    resolveRecordPath(dataDir, binding, input.record.id),
    buildFrontmatterMarkdown(frontmatter, input.record.content),
    "utf8",
  );
}

export async function readStoredRecord(filePath: string): Promise<MemoryRecord | null> {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseFrontmatterMarkdown(raw);
  const frontmatter = parsed.frontmatter;
  const id = asString(frontmatter.recordId);
  const companyId = asString(frontmatter.companyId);
  const bindingId = asString(frontmatter.bindingId);
  const providerKey = asString(frontmatter.providerKey);
  const createdAt = parseDate(frontmatter.createdAt);
  const updatedAt = parseDate(frontmatter.updatedAt);
  if (!id || !companyId || !bindingId || !providerKey || !createdAt || !updatedAt) {
    return null;
  }
  const scope = normalizeScope(frontmatter.scope);
  const scopeType = normalizeScopeType(scope, frontmatter.scopeType);
  const scopeId = normalizeScopeId(companyId, scopeType, scope, frontmatter.scopeId);

  return {
    id,
    companyId,
    bindingId,
    providerKey,
    scope,
    source: normalizeSource(frontmatter.source),
    scopeType,
    scopeId,
    owner: normalizePrincipal(frontmatter.owner),
    createdBy: normalizePrincipal(frontmatter.createdBy),
    sensitivityLabel: normalizeSensitivityLabel(frontmatter.sensitivityLabel),
    retentionPolicy: isPlainRecord(frontmatter.retentionPolicy) ? frontmatter.retentionPolicy : null,
    expiresAt: parseDate(frontmatter.expiresAt),
    retentionState: normalizeRetentionState(frontmatter.retentionState),
    reviewState: normalizeReviewState(frontmatter.reviewState),
    reviewedAt: parseDate(frontmatter.reviewedAt),
    reviewedBy: normalizePrincipal(frontmatter.reviewedBy),
    reviewNote: asString(frontmatter.reviewNote),
    citation: normalizeCitation(frontmatter.citation),
    supersedesRecordId: asString(frontmatter.supersedesRecordId),
    supersededByRecordId: asString(frontmatter.supersededByRecordId),
    revokedAt: parseDate(frontmatter.revokedAt),
    revokedBy: normalizePrincipal(frontmatter.revokedBy),
    revocationReason: asString(frontmatter.revocationReason),
    title: asString(frontmatter.title),
    content: parsed.body,
    summary: asString(frontmatter.summary),
    metadata: isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : {},
    createdByOperationId: null,
    deletedAt: parseDate(frontmatter.deletedAt),
    createdAt,
    updatedAt,
  };
}

export async function readStoredRecordById(dataDir: string, binding: MemoryBinding, recordId: string) {
  try {
    return await readStoredRecord(resolveRecordPath(dataDir, binding, recordId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function removeStoredRecords(dataDir: string, binding: MemoryBinding, recordIds: string[]) {
  await Promise.all(
    recordIds.map(async (recordId) => {
      try {
        await rm(resolveRecordPath(dataDir, binding, recordId), { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }),
  );
}

export function resolveRecordFileFromHit(
  bindingDir: string,
  hit: Record<string, unknown>,
  recordIdFallbackDir = path.join(bindingDir, "records"),
) {
  const directPath = asString(hit.path) ?? asString(hit.file) ?? asString(hit.filePath);
  if (directPath) {
    return path.isAbsolute(directPath) ? directPath : path.join(bindingDir, directPath);
  }

  const metadata = isPlainRecord(hit.metadata) ? hit.metadata : null;
  const nestedPath =
    (metadata && (asString(metadata.path) ?? asString(metadata.file) ?? asString(metadata.filePath)))
    ?? null;
  if (nestedPath) {
    return path.isAbsolute(nestedPath) ? nestedPath : path.join(bindingDir, nestedPath);
  }

  const recordId =
    asString(hit.recordId)
    ?? asString(hit.id)
    ?? (metadata ? asString(metadata.recordId) ?? asString(metadata.id) : null);
  if (!recordId) return null;
  return path.join(recordIdFallbackDir, `${recordId}.md`);
}
