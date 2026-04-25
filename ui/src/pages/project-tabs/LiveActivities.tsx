// Live Activities tab — most recent events scoped to this project.
// Reads from the company_activity table via the existing /companies/:id/activity
// endpoint, then filters client-side by project_id (cheap; activity rows are
// already capped per company).

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { ensureArray } from "@/lib/ensureArray";
import { AppLoader } from "@/components/AppLoader";

type ActivityRow = {
  id: string;
  category: string | null;
  severity: string | null;
  message: string | null;
  subject: string | null;
  projectId?: string | null;
  project_id?: string | null;
  createdAt?: number;
  created_at?: number;
};

export function LiveActivitiesTab({ projectId, companyId }: { projectId: string; companyId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["project-tabs", "activity", companyId, projectId],
    queryFn: () => api.get<ActivityRow[]>(`/companies/${companyId}/activity?limit=100`),
    enabled: Boolean(projectId && companyId),
    refetchInterval: 8000,
    select: (d) => ensureArray<ActivityRow>(d),
  });

  if (isLoading) return <AppLoader variant="page" label="Loading activity…" />;
  if (error) return <p className="text-sm text-destructive">Failed to load activity.</p>;

  const rows = (data ?? []).filter((r) => (r.projectId ?? r.project_id) === projectId);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No project activity yet.</p>;
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {rows.map((r) => {
        const ts = r.createdAt ?? r.created_at ?? 0;
        return (
          <li key={r.id} className="flex items-start gap-3 px-4 py-3">
            <span
              className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${
                r.severity === "error" || r.severity === "critical"
                  ? "bg-destructive"
                  : r.severity === "warning"
                    ? "bg-amber-500"
                    : "bg-emerald-500"
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {r.subject || r.message || r.category || "event"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {r.category ?? ""} · {ts ? new Date(ts).toLocaleString() : ""}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
