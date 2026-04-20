import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { memoryApi } from "../api/memory";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

function sourceLabel(source: string | null | undefined) {
  if (source === "project_override") return "Project override";
  if (source === "company_default") return "Company default";
  if (source === "agent_override") return "Agent override";
  if (source === "binding_key") return "Direct binding key";
  return "Unconfigured";
}

export function ProjectMemorySettings({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [selectedBindingId, setSelectedBindingId] = useState("__inherit__");

  const bindingsQuery = useQuery({
    queryKey: queryKeys.memory.bindings(companyId),
    queryFn: () => memoryApi.listBindings(companyId),
  });

  const resolvedBindingQuery = useQuery({
    queryKey: queryKeys.memory.projectBinding(projectId),
    queryFn: () => memoryApi.getProjectBinding(projectId),
  });

  useEffect(() => {
    const resolved = resolvedBindingQuery.data;
    if (!resolved) return;
    if (resolved.targetType === "project" && resolved.binding) {
      setSelectedBindingId(resolved.binding.id);
      return;
    }
    setSelectedBindingId("__inherit__");
  }, [resolvedBindingQuery.data]);

  const currentSelection = useMemo(() => {
    const resolved = resolvedBindingQuery.data;
    if (!resolved) return "__inherit__";
    if (resolved.targetType === "project" && resolved.binding) return resolved.binding.id;
    return "__inherit__";
  }, [resolvedBindingQuery.data]);

  const saveOverride = useMutation({
    mutationFn: () =>
      memoryApi.setProjectBinding(projectId, selectedBindingId === "__inherit__" ? null : selectedBindingId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory.all });
      pushToast({
        title: "Project memory binding updated",
        body: selectedBindingId === "__inherit__"
          ? "This project now inherits the company default binding."
          : "The project override is active for subsequent memory operations.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update project memory binding",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const loading = bindingsQuery.isLoading || resolvedBindingQuery.isLoading;
  const error = bindingsQuery.error ?? resolvedBindingQuery.error ?? null;
  const resolvedBinding = resolvedBindingQuery.data?.binding ?? null;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="rounded-md border border-border px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-accent text-muted-foreground">
            <Database className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <div className="space-y-1">
              <h2 className="text-sm font-medium">Project memory</h2>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading memory state...</p>
              ) : error ? (
                <p className="text-sm text-destructive">{error.message}</p>
              ) : (
                <>
                  <p className="text-sm">
                    {resolvedBinding ? `${resolvedBinding.name ?? resolvedBinding.key} (${resolvedBinding.providerKey})` : "No memory binding resolves for this project yet."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Source: {sourceLabel(resolvedBindingQuery.data?.source ?? null)}
                  </p>
                </>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Project override</label>
                <select
                  value={selectedBindingId}
                  onChange={(event) => setSelectedBindingId(event.target.value)}
                  disabled={loading || Boolean(error)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none"
                >
                  <option value="__inherit__">Inherit company default</option>
                  {(bindingsQuery.data ?? []).map((binding) => (
                    <option key={binding.id} value={binding.id}>
                      {binding.name ?? binding.key}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                size="sm"
                disabled={loading || Boolean(error) || saveOverride.isPending || selectedBindingId === currentSelection}
                onClick={() => saveOverride.mutate()}
              >
                {saveOverride.isPending ? "Saving..." : "Save override"}
              </Button>
            </div>

            {saveOverride.isError ? (
              <p className="text-xs text-destructive">
                {saveOverride.error instanceof Error ? saveOverride.error.message : "Failed to update project memory binding"}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

