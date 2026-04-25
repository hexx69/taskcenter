// Epics tab — shows the epic plan + child issues for this project.
// Phase-1: read-only list rendered from issues with kind="epic". A richer
// epic-plan viewer will replace this once the worker exposes a dedicated
// /api/projects/:id/epics endpoint.

import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "@/api/issues";
import { ensureArray } from "@/lib/ensureArray";
import { AppLoader } from "@/components/AppLoader";

export function EpicsTab({ projectId, companyId }: { projectId: string; companyId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["project-tabs", "epics", companyId, projectId],
    queryFn: () => issuesApi.list(companyId, { projectId, limit: 200 }),
    enabled: Boolean(projectId && companyId),
    select: (d) => ensureArray<{ id: string; kind?: string | null; title: string; status: string; description?: string | null }>(d),
  });

  if (isLoading) return <AppLoader variant="page" label="Loading epics…" />;
  if (error) return <p className="text-sm text-destructive">Failed to load epics.</p>;

  const epics = (data ?? []).filter((it) => (it.kind ?? "").toLowerCase() === "epic");

  if (epics.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted-foreground">No epics yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Create an issue with kind=epic to start grouping work into milestones.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {epics.map((epic) => (
        <div key={epic.id} className="rounded-md border border-border p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{epic.title}</h3>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              {epic.status}
            </span>
          </div>
          {epic.description ? (
            <p className="mt-2 text-sm text-muted-foreground">{epic.description}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
