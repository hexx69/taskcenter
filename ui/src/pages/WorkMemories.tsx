import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MEMORY_RETENTION_STATES,
  MEMORY_REVIEW_STATES,
  MEMORY_SCOPE_TYPES,
  MEMORY_SENSITIVITY_LABELS,
  MEMORY_SOURCE_KINDS,
  type Agent,
  type Issue,
  type MemoryListOperationsQuery,
  type MemoryListRecordsQuery,
  type MemoryRecord,
  type MemoryRetentionState,
  type MemoryReviewState,
  type MemoryScopeType,
  type MemorySensitivityLabel,
  type MemorySourceKind,
  type Project,
} from "@paperclipai/shared";
import { Check, Clipboard, Database, RotateCcw, SlidersHorizontal, Trash2, X } from "lucide-react";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { memoryApi } from "../api/memory";
import { projectsApi } from "../api/projects";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, cn, formatDateTime, issueUrl, projectUrl, relativeTime } from "../lib/utils";

type MemoryFilters = {
  q: string;
  providerKey: string;
  reviewState: MemoryReviewState | "";
  retentionState: MemoryRetentionState | "";
  sensitivityLabel: MemorySensitivityLabel | "";
  sourceKind: MemorySourceKind | "";
  scopeType: MemoryScopeType | "";
  projectId: string;
  agentId: string;
  issueId: string;
  runId: string;
  includeRevoked: boolean;
  includeExpired: boolean;
  includeSuperseded: boolean;
};

const DEFAULT_FILTERS: MemoryFilters = {
  q: "",
  providerKey: "",
  reviewState: "pending",
  retentionState: "",
  sensitivityLabel: "",
  sourceKind: "",
  scopeType: "",
  projectId: "",
  agentId: "",
  issueId: "",
  runId: "",
  includeRevoked: false,
  includeExpired: false,
  includeSuperseded: false,
};

function labelize(value: string) {
  return value.replace(/_/g, " ");
}

function summarizeRecord(record: MemoryRecord) {
  const text = (record.summary ?? record.content).replace(/\s+/g, " ").trim();
  return text.length > 360 ? `${text.slice(0, 357)}...` : text;
}

function recordTitle(record: MemoryRecord) {
  return record.title ?? record.citation?.sourceTitle ?? labelize(record.source?.kind ?? "memory");
}

function badgeTone(record: MemoryRecord) {
  if (record.revokedAt || record.retentionState === "revoked") return "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
  if (record.reviewState === "accepted") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (record.reviewState === "rejected") return "bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "bg-amber-500/10 text-amber-800 dark:text-amber-300";
}

function sourceLabel(record: MemoryRecord, issuesById: Map<string, Issue>) {
  const issueId = record.source?.issueId ?? record.scope.issueId ?? null;
  const issue = issueId ? issuesById.get(issueId) : null;
  if (issue) return issue.identifier ?? issue.title;
  if (record.source?.runId ?? record.scope.runId) return `run ${(record.source?.runId ?? record.scope.runId)!.slice(0, 8)}`;
  if (record.source?.externalRef) return record.source.externalRef;
  return labelize(record.source?.kind ?? record.scopeType);
}

function sourceHref(record: MemoryRecord, issuesById: Map<string, Issue>) {
  const issueId = record.source?.issueId ?? record.scope.issueId ?? null;
  const issue = issueId ? issuesById.get(issueId) : null;
  if (issue) {
    const base = issueUrl(issue);
    if (record.source?.commentId) return `${base}#comment-${record.source.commentId}`;
    if (record.source?.documentKey) return `${base}#document-${record.source.documentKey}`;
    return base;
  }
  const runId = record.source?.runId ?? record.scope.runId ?? null;
  const agentId = record.scope.agentId ?? null;
  if (runId && agentId) return `/agents/${agentId}/runs/${runId}`;
  return null;
}

function buildRecordFilters(filters: MemoryFilters): Partial<MemoryListRecordsQuery> {
  return {
    q: filters.q.trim() || undefined,
    providerKey: filters.providerKey || undefined,
    reviewState: filters.reviewState || undefined,
    retentionState: filters.retentionState || undefined,
    sensitivityLabel: filters.sensitivityLabel || undefined,
    sourceKind: filters.sourceKind || undefined,
    scopeType: filters.scopeType || undefined,
    projectId: filters.projectId || undefined,
    agentId: filters.agentId || undefined,
    issueId: filters.issueId || undefined,
    runId: filters.runId.trim() || undefined,
    includeDeleted: false,
    includeRevoked: filters.includeRevoked,
    includeExpired: filters.includeExpired,
    includeSuperseded: filters.includeSuperseded,
    limit: 100,
  };
}

function detailOperationFilters(record: MemoryRecord | null): MemoryListOperationsQuery | undefined {
  if (!record) return undefined;
  if (record.scope.runId ?? record.source?.runId) {
    return { runId: record.scope.runId ?? record.source?.runId ?? undefined, limit: 20 };
  }
  if (record.scope.issueId ?? record.source?.issueId) {
    return { issueId: record.scope.issueId ?? record.source?.issueId ?? undefined, limit: 20 };
  }
  if (record.scope.agentId) return { agentId: record.scope.agentId, limit: 20 };
  return { limit: 20 };
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="space-y-1 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm font-normal text-foreground shadow-xs outline-none"
      >
        {options.map((option) => (
          <option key={option.value || "__all__"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ReviewBadge({ record }: { record: MemoryRecord }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", badgeTone(record))}>
      {record.revokedAt ? "revoked" : record.reviewState}
    </span>
  );
}

function MemoryDetailSheet({
  companyId,
  record,
  agentsById,
  issuesById,
  projectsById,
  onClose,
}: {
  companyId: string;
  record: MemoryRecord | null;
  agentsById: Map<string, Agent>;
  issuesById: Map<string, Issue>;
  projectsById: Map<string, Project>;
  onClose: () => void;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [reviewNote, setReviewNote] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [correctionContent, setCorrectionContent] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");

  useEffect(() => {
    setReviewNote(record?.reviewNote ?? "");
    setRevokeReason("");
    setCorrectionContent(record?.content ?? "");
    setCorrectionReason("");
  }, [record]);

  const operationFilters = useMemo(() => detailOperationFilters(record), [record]);
  const operationsQuery = useQuery({
    queryKey: record && operationFilters ? queryKeys.memory.operations(companyId, operationFilters) : ["memory", companyId, "operations", "none"],
    queryFn: () => memoryApi.listOperations(companyId, operationFilters),
    enabled: Boolean(record && operationFilters),
  });

  const invalidateMemory = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
  };

  const reviewRecord = useMutation({
    mutationFn: (reviewState: "pending" | "accepted" | "rejected") => {
      if (!record) throw new Error("No memory record selected");
      return memoryApi.reviewRecord(companyId, record.id, {
        reviewState,
        note: reviewNote.trim() || null,
      });
    },
    onSuccess: async () => {
      await invalidateMemory();
      pushToast({ title: "Memory review saved", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to review memory",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const correctRecord = useMutation({
    mutationFn: () => {
      if (!record) throw new Error("No memory record selected");
      return memoryApi.correctRecord(companyId, record.id, {
        content: correctionContent,
        reason: correctionReason,
      });
    },
    onSuccess: async () => {
      setCorrectionReason("");
      await invalidateMemory();
      pushToast({ title: "Memory corrected", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to correct memory",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const revokeRecord = useMutation({
    mutationFn: () => {
      if (!record) throw new Error("No memory record selected");
      return memoryApi.revoke(companyId, {
        selector: { recordIds: [record.id] },
        reason: revokeReason,
      });
    },
    onSuccess: async () => {
      setRevokeReason("");
      await invalidateMemory();
      pushToast({ title: "Memory revoked", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to revoke memory",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!record) {
    return (
      <Sheet open={false} onOpenChange={onClose}>
        <SheetContent />
      </Sheet>
    );
  }

  const sourceUrl = sourceHref(record, issuesById);
  const agent = record.scope.agentId ? agentsById.get(record.scope.agentId) : null;
  const project = record.scope.projectId ? projectsById.get(record.scope.projectId) : null;
  const canMutate = record.retentionState === "active" && !record.revokedAt && !record.supersededByRecordId;
  const sourceReference = [
    record.source?.kind ?? "memory",
    record.source?.issueId ? `issue:${record.source.issueId}` : null,
    record.source?.commentId ? `comment:${record.source.commentId}` : null,
    record.source?.documentKey ? `document:${record.source.documentKey}` : null,
    record.source?.runId ? `run:${record.source.runId}` : null,
  ].filter(Boolean).join(" ");

  return (
    <Sheet open={Boolean(record)} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="text-base">{recordTitle(record)}</SheetTitle>
          <SheetDescription>
            {record.providerKey} · {record.sensitivityLabel} · {record.retentionState}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-5 space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <ReviewBadge record={record} />
            <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">
              {record.scopeType}
            </span>
            <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">
              {labelize(record.source?.kind ?? "memory")}
            </span>
          </div>

          <div className="rounded-md border border-border px-4 py-3">
            <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Content</div>
            <p className="whitespace-pre-wrap text-sm leading-6">{record.content}</p>
            {record.summary ? (
              <div className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
                {record.summary}
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-md border border-border px-3 py-3">
              <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Provenance</div>
              <div className="space-y-1">
                {sourceUrl ? (
                  <Link className="text-primary hover:underline" to={sourceUrl}>
                    {sourceLabel(record, issuesById)}
                  </Link>
                ) : (
                  <div>{sourceLabel(record, issuesById)}</div>
                )}
                {record.citation?.label || record.citation?.sourceTitle ? (
                  <div className="text-xs text-muted-foreground">
                    {record.citation.label ?? record.citation.sourceTitle}
                  </div>
                ) : null}
                {record.citation?.url ? (
                  <a className="block break-all text-xs text-primary hover:underline" href={record.citation.url}>
                    {record.citation.url}
                  </a>
                ) : null}
              </div>
            </div>
            <div className="rounded-md border border-border px-3 py-3">
              <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Scope</div>
              <div className="space-y-1 text-xs">
                {project ? <Link className="block text-primary hover:underline" to={projectUrl(project)}>{project.name}</Link> : null}
                {agent ? <Link className="block text-primary hover:underline" to={agentUrl(agent)}>{agent.name}</Link> : null}
                <div className="break-all text-muted-foreground">{record.scopeId ?? record.scopeType}</div>
                <div className="text-muted-foreground">Created {formatDateTime(record.createdAt)}</div>
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border px-4 py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Review</div>
                <div className="text-xs text-muted-foreground">
                  {record.reviewedAt ? `Last reviewed ${relativeTime(record.reviewedAt)}` : "Not reviewed yet"}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(sourceReference);
                  pushToast({ title: "Source reference copied", tone: "success" });
                }}
              >
                <Clipboard className="mr-2 h-4 w-4" />
                Copy
              </Button>
            </div>
            <Textarea
              value={reviewNote}
              onChange={(event) => setReviewNote(event.target.value)}
              placeholder="Optional review note"
              className="min-h-20"
            />
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!canMutate || reviewRecord.isPending}
                onClick={() => reviewRecord.mutate("pending")}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Pending
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canMutate || reviewRecord.isPending}
                onClick={() => reviewRecord.mutate("rejected")}
              >
                <X className="mr-2 h-4 w-4" />
                Reject
              </Button>
              <Button
                size="sm"
                disabled={!canMutate || reviewRecord.isPending}
                onClick={() => reviewRecord.mutate("accepted")}
              >
                <Check className="mr-2 h-4 w-4" />
                Accept
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-border px-4 py-4">
            <div className="mb-3 text-sm font-medium">Correct</div>
            <Textarea
              value={correctionContent}
              onChange={(event) => setCorrectionContent(event.target.value)}
              className="min-h-32"
            />
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value)}
                placeholder="Correction reason"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!canMutate || !correctionContent.trim() || !correctionReason.trim() || correctRecord.isPending}
                onClick={() => correctRecord.mutate()}
              >
                Save correction
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-border px-4 py-4">
            <div className="mb-3 text-sm font-medium">Revoke</div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                value={revokeReason}
                onChange={(event) => setRevokeReason(event.target.value)}
                placeholder="Revocation reason"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!canMutate || !revokeReason.trim() || revokeRecord.isPending}
                onClick={() => revokeRecord.mutate()}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Revoke
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-border px-4 py-4">
            <div className="mb-3 text-sm font-medium">Operations</div>
            {operationsQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading operations...</div>
            ) : (operationsQuery.data ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">No related operations found.</div>
            ) : (
              <div className="divide-y divide-border">
                {(operationsQuery.data ?? []).map((operation) => (
                  <div key={operation.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div>
                      <div className="font-medium">{operation.operationType}</div>
                      <div className="text-xs text-muted-foreground">{operation.hookKind ?? operation.triggerKind}</div>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <div>{operation.status}</div>
                      <div>{relativeTime(operation.occurredAt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function WorkMemories() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [filters, setFilters] = useState<MemoryFilters>(DEFAULT_FILTERS);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Memories" }]);
  }, [setBreadcrumbs]);

  const providersQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.memory.providers(selectedCompanyId) : ["memory", "providers", "none"],
    queryFn: () => memoryApi.providers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const bindingsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.memory.bindings(selectedCompanyId) : ["memory", "bindings", "none"],
    queryFn: () => memoryApi.listBindings(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const projectsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.list(selectedCompanyId) : ["projects", "none"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const issuesQuery = useQuery({
    queryKey: selectedCompanyId ? [...queryKeys.issues.list(selectedCompanyId), "memory-filter"] : ["issues", "none"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { includeRoutineExecutions: true, limit: 300 }),
    enabled: !!selectedCompanyId,
  });

  const recordFilters = useMemo(() => buildRecordFilters(filters), [filters]);
  const recordsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.memory.records(selectedCompanyId, recordFilters) : ["memory", "records", "none"],
    queryFn: () => memoryApi.listRecords(selectedCompanyId!, recordFilters),
    enabled: !!selectedCompanyId,
  });

  const agentsById = useMemo(() => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent])), [agentsQuery.data]);
  const projectsById = useMemo(() => new Map((projectsQuery.data ?? []).map((project) => [project.id, project])), [projectsQuery.data]);
  const issuesById = useMemo(() => new Map((issuesQuery.data ?? []).map((issue) => [issue.id, issue])), [issuesQuery.data]);
  const selectedRecord = (recordsQuery.data ?? []).find((record) => record.id === selectedRecordId) ?? null;

  const counts = useMemo(() => {
    const records = recordsQuery.data ?? [];
    return {
      total: records.length,
      pending: records.filter((record) => record.reviewState === "pending").length,
      accepted: records.filter((record) => record.reviewState === "accepted").length,
      rejected: records.filter((record) => record.reviewState === "rejected").length,
    };
  }, [recordsQuery.data]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Database} message="Select a company to view memories." />;
  }

  const providerOptions = [
    { value: "", label: "Any provider" },
    ...(providersQuery.data ?? []).map((provider) => ({ value: provider.key, label: provider.displayName })),
  ];
  const bindingById = new Map((bindingsQuery.data ?? []).map((binding) => [binding.id, binding]));

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Memories</h1>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="rounded-full bg-accent px-2.5 py-1 text-xs text-muted-foreground">{counts.total} visible</span>
            <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs text-amber-800 dark:text-amber-300">{counts.pending} pending</span>
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-700 dark:text-emerald-300">{counts.accepted} accepted</span>
            <span className="rounded-full bg-rose-500/10 px-2.5 py-1 text-xs text-rose-700 dark:text-rose-300">{counts.rejected} rejected</span>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setFilters(DEFAULT_FILTERS)}>
          <RotateCcw className="mr-2 h-4 w-4" />
          Reset
        </Button>
      </div>

      <div className="rounded-md border border-border px-4 py-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          Filters
        </div>
        <div className="grid gap-3 lg:grid-cols-4">
          <label className="space-y-1 text-xs font-medium text-muted-foreground lg:col-span-2">
            <span>Search</span>
            <Input
              value={filters.q}
              onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))}
              placeholder="Search title, summary, or content"
            />
          </label>
          <FilterSelect
            label="Review"
            value={filters.reviewState}
            onChange={(reviewState) =>
              setFilters((current) => ({ ...current, reviewState: reviewState as MemoryFilters["reviewState"] }))
            }
            options={[
              { value: "", label: "Any review state" },
              ...MEMORY_REVIEW_STATES.map((state) => ({ value: state, label: state })),
            ]}
          />
          <FilterSelect
            label="Provider"
            value={filters.providerKey}
            onChange={(providerKey) => setFilters((current) => ({ ...current, providerKey }))}
            options={providerOptions}
          />
          <FilterSelect
            label="Project"
            value={filters.projectId}
            onChange={(projectId) => setFilters((current) => ({ ...current, projectId }))}
            options={[
              { value: "", label: "Any project" },
              ...(projectsQuery.data ?? []).map((project) => ({ value: project.id, label: project.name })),
            ]}
          />
          <FilterSelect
            label="Agent"
            value={filters.agentId}
            onChange={(agentId) => setFilters((current) => ({ ...current, agentId }))}
            options={[
              { value: "", label: "Any agent" },
              ...(agentsQuery.data ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
            ]}
          />
          <FilterSelect
            label="Task"
            value={filters.issueId}
            onChange={(issueId) => setFilters((current) => ({ ...current, issueId }))}
            options={[
              { value: "", label: "Any task" },
              ...(issuesQuery.data ?? []).map((issue) => ({
                value: issue.id,
                label: `${issue.identifier ?? issue.id.slice(0, 8)} ${issue.title}`,
              })),
            ]}
          />
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            <span>Run ID</span>
            <Input
              value={filters.runId}
              onChange={(event) => setFilters((current) => ({ ...current, runId: event.target.value }))}
              placeholder="UUID"
            />
          </label>
          <FilterSelect
            label="Source"
            value={filters.sourceKind}
            onChange={(sourceKind) =>
              setFilters((current) => ({ ...current, sourceKind: sourceKind as MemoryFilters["sourceKind"] }))
            }
            options={[
              { value: "", label: "Any source" },
              ...MEMORY_SOURCE_KINDS.map((kind) => ({ value: kind, label: labelize(kind) })),
            ]}
          />
          <FilterSelect
            label="Sensitivity"
            value={filters.sensitivityLabel}
            onChange={(sensitivityLabel) =>
              setFilters((current) => ({
                ...current,
                sensitivityLabel: sensitivityLabel as MemoryFilters["sensitivityLabel"],
              }))
            }
            options={[
              { value: "", label: "Any label" },
              ...MEMORY_SENSITIVITY_LABELS.map((label) => ({ value: label, label })),
            ]}
          />
          <FilterSelect
            label="Retention"
            value={filters.retentionState}
            onChange={(retentionState) =>
              setFilters((current) => ({
                ...current,
                retentionState: retentionState as MemoryFilters["retentionState"],
              }))
            }
            options={[
              { value: "", label: "Active records" },
              ...MEMORY_RETENTION_STATES.map((state) => ({ value: state, label: state })),
            ]}
          />
          <FilterSelect
            label="Scope"
            value={filters.scopeType}
            onChange={(scopeType) =>
              setFilters((current) => ({ ...current, scopeType: scopeType as MemoryFilters["scopeType"] }))
            }
            options={[
              { value: "", label: "Any scope" },
              ...MEMORY_SCOPE_TYPES.map((scope) => ({ value: scope, label: scope })),
            ]}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={filters.includeRevoked}
              onChange={(event) => setFilters((current) => ({ ...current, includeRevoked: event.target.checked }))}
            />
            Include revoked
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={filters.includeExpired}
              onChange={(event) => setFilters((current) => ({ ...current, includeExpired: event.target.checked }))}
            />
            Include expired
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={filters.includeSuperseded}
              onChange={(event) => setFilters((current) => ({ ...current, includeSuperseded: event.target.checked }))}
            />
            Include superseded
          </label>
        </div>
      </div>

      {recordsQuery.isLoading ? (
        <div className="rounded-md border border-border px-4 py-8 text-sm text-muted-foreground">Loading memories...</div>
      ) : recordsQuery.error ? (
        <div className="rounded-md border border-destructive/40 px-4 py-4 text-sm text-destructive">
          {recordsQuery.error.message}
        </div>
      ) : (recordsQuery.data ?? []).length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-10 text-sm text-muted-foreground">
          No memory records match the current filters.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="divide-y divide-border">
            {(recordsQuery.data ?? []).map((record) => {
              const sourceUrl = sourceHref(record, issuesById);
              const agent = record.scope.agentId ? agentsById.get(record.scope.agentId) : null;
              const project = record.scope.projectId ? projectsById.get(record.scope.projectId) : null;
              const binding = bindingById.get(record.bindingId);
              return (
                <button
                  key={record.id}
                  type="button"
                  className="grid w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-accent/30 lg:grid-cols-[1fr_220px_160px]"
                  onClick={() => setSelectedRecordId(record.id)}
                >
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <ReviewBadge record={record} />
                      <span className="text-sm font-medium">{recordTitle(record)}</span>
                      <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">
                        {binding?.name ?? binding?.key ?? record.providerKey}
                      </span>
                    </div>
                    <p className="text-sm leading-6 text-foreground/85">{summarizeRecord(record)}</p>
                  </div>
                  <div className="min-w-0 text-xs text-muted-foreground">
                    <div className="font-medium text-foreground">{sourceLabel(record, issuesById)}</div>
                    <div>{labelize(record.source?.kind ?? record.scopeType)}</div>
                    {sourceUrl ? <div className="mt-1 text-primary">Open source</div> : null}
                  </div>
                  <div className="text-xs text-muted-foreground lg:text-right">
                    {project ? <div className="truncate">{project.name}</div> : null}
                    {agent ? <div className="truncate">{agent.name}</div> : null}
                    <div>{relativeTime(record.createdAt)}</div>
                    <div>{record.sensitivityLabel}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <MemoryDetailSheet
        companyId={selectedCompanyId}
        record={selectedRecord}
        agentsById={agentsById}
        issuesById={issuesById}
        projectsById={projectsById}
        onClose={() => setSelectedRecordId(null)}
      />
    </div>
  );
}
