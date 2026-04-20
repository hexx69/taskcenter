import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryBinding, MemoryOperation, MemoryRecord } from "@paperclipai/shared";
import { memoryApi } from "../api/memory";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";

function describeResolvedSource(source: string | null | undefined) {
  if (source === "agent_override") return "Agent override";
  if (source === "project_override") return "Project override";
  if (source === "company_default") return "Company default";
  if (source === "binding_key") return "Direct binding key";
  return "Unconfigured";
}

function describeRecordSource(record: MemoryRecord) {
  if (!record.source?.kind) return "memory";
  return record.source.kind.replace(/_/g, " ");
}

function describeBinding(binding: MemoryBinding | null) {
  if (!binding) return "No memory binding resolves for this agent yet.";
  return `${binding.name ?? binding.key} (${binding.providerKey})`;
}

function summarizeRecord(record: MemoryRecord) {
  const body = (record.summary ?? record.content).replace(/\s+/g, " ").trim();
  return body.length > 280 ? `${body.slice(0, 277)}...` : body;
}

function governanceLabel(record: MemoryRecord) {
  const scope = `${record.scopeType}${record.scopeId ? `:${record.scopeId.slice(0, 8)}` : ""}`;
  return `${scope} • ${record.sensitivityLabel} • ${record.retentionState}`;
}

function operationCost(operation: MemoryOperation) {
  const total = operation.usage.reduce((sum, item) => sum + item.costCents, 0);
  return total > 0 ? formatCents(total) : "-";
}

export function AgentMemoryTab({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [selectedBindingId, setSelectedBindingId] = useState("__inherit__");

  const bindingsQuery = useQuery({
    queryKey: queryKeys.memory.bindings(companyId),
    queryFn: () => memoryApi.listBindings(companyId),
  });

  const resolvedBindingQuery = useQuery({
    queryKey: queryKeys.memory.agentBinding(agentId),
    queryFn: () => memoryApi.getAgentBinding(agentId),
  });

  const recordsQuery = useQuery({
    queryKey: queryKeys.memory.records(companyId, { agentId, includeDeleted: false, limit: 20 }),
    queryFn: () => memoryApi.listRecords(companyId, { agentId, includeDeleted: false, limit: 20 }),
  });

  const operationsQuery = useQuery({
    queryKey: queryKeys.memory.operations(companyId, { agentId, limit: 20 }),
    queryFn: () => memoryApi.listOperations(companyId, { agentId, limit: 20 }),
  });

  useEffect(() => {
    const resolved = resolvedBindingQuery.data;
    if (!resolved) return;
    if (resolved.targetType === "agent" && resolved.binding) {
      setSelectedBindingId(resolved.binding.id);
      return;
    }
    setSelectedBindingId("__inherit__");
  }, [resolvedBindingQuery.data]);

  const saveOverride = useMutation({
    mutationFn: () =>
      memoryApi.setAgentBinding(agentId, selectedBindingId === "__inherit__" ? null : selectedBindingId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
      pushToast({
        title: "Agent memory binding updated",
        body: selectedBindingId === "__inherit__"
          ? "This agent now inherits the company default binding."
          : "The agent override is active for subsequent memory operations.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update agent memory binding",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const currentSelection = useMemo(() => {
    const resolved = resolvedBindingQuery.data;
    if (!resolved) return "__inherit__";
    if (resolved.targetType === "agent" && resolved.binding) return resolved.binding.id;
    return "__inherit__";
  }, [resolvedBindingQuery.data]);

  const loading =
    bindingsQuery.isLoading
    || resolvedBindingQuery.isLoading
    || recordsQuery.isLoading
    || operationsQuery.isLoading;
  const error =
    bindingsQuery.error
    ?? resolvedBindingQuery.error
    ?? recordsQuery.error
    ?? operationsQuery.error
    ?? null;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border px-4 py-4">
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-2">
            <div className="text-sm font-medium">Resolved memory</div>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading memory state...</p>
            ) : error ? (
              <p className="text-sm text-destructive">{error.message}</p>
            ) : (
              <>
                <div className="text-sm">{describeBinding(resolvedBindingQuery.data?.binding ?? null)}</div>
                <div className="text-xs text-muted-foreground">
                  Source: {describeResolvedSource(resolvedBindingQuery.data?.source ?? null)}
                </div>
                <div className="text-xs text-muted-foreground">
                  Automatic capture hooks write recent run summaries and issue context into the resolved binding.
                </div>
                <div className="text-xs text-muted-foreground">
                  Hydration can read org memory plus this agent, issue, project, workspace, and run scopes when present. Restricted records are withheld from agent prompts unless explicitly allowed.
                </div>
              </>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">Agent override</div>
            <select
              value={selectedBindingId}
              onChange={(event) => setSelectedBindingId(event.target.value)}
              disabled={loading || Boolean(error)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none"
            >
              <option value="__inherit__">Inherit project/company default</option>
              {(bindingsQuery.data ?? []).map((binding) => (
                <option key={binding.id} value={binding.id}>
                  {binding.name ?? binding.key}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                disabled={loading || Boolean(error) || saveOverride.isPending || selectedBindingId === currentSelection}
                onClick={() => saveOverride.mutate()}
              >
                {saveOverride.isPending ? "Saving..." : "Save override"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent memory records</h3>
          <div className="text-xs text-muted-foreground">Filtered to this agent scope</div>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading records...</p>
        ) : (recordsQuery.data ?? []).length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No memory has been captured for this agent yet.
          </div>
        ) : (
          <div className="space-y-3">
            {(recordsQuery.data ?? []).map((record) => (
              <div key={record.id} className="rounded-lg border border-border px-4 py-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1">
                    <div className="text-sm font-medium">{record.title ?? describeRecordSource(record)}</div>
                    <div className="text-xs text-muted-foreground">
                      {describeRecordSource(record)} • {governanceLabel(record)} • {relativeTime(record.createdAt)}
                    </div>
                    {record.citation?.label || record.citation?.sourceTitle ? (
                      <div className="text-xs text-muted-foreground">
                        Citation: {record.citation.label ?? record.citation.sourceTitle}
                      </div>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {record.scope.issueId ? `Issue ${record.scope.issueId.slice(0, 8)}` : "No issue scope"}
                    {record.scope.runId ? ` • Run ${record.scope.runId.slice(0, 8)}` : ""}
                  </div>
                </div>
                <p className="mt-2 text-sm text-foreground/90">{summarizeRecord(record)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent memory operations</h3>
          <div className="text-xs text-muted-foreground">Queries, captures, and forgets for this agent</div>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading operations...</p>
        ) : (operationsQuery.data ?? []).length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No memory operations logged yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-accent/20 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Operation</th>
                  <th className="px-3 py-2 font-medium">Hook</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Records</th>
                  <th className="px-3 py-2 font-medium text-right">Cost</th>
                  <th className="px-3 py-2 font-medium text-right">When</th>
                </tr>
              </thead>
              <tbody>
                {(operationsQuery.data ?? []).map((operation) => (
                  <tr key={operation.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{operation.operationType}</div>
                      <div className="text-xs text-muted-foreground">{operation.providerKey}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {operation.hookKind ?? operation.triggerKind}
                    </td>
                    <td className="px-3 py-2 text-xs">{operation.status}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{operation.recordCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{operationCost(operation)}</td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                      {relativeTime(operation.occurredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
