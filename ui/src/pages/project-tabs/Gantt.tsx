// Gantt tab — pure-CSS timeline (no frappe-gantt yet — keeps the bundle
// lean; can swap to a real lib later). Each issue with a startDate +
// dueDate becomes a horizontal bar; the timeline auto-fits the project's
// span.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { issuesApi } from "@/api/issues";
import { ensureArray } from "@/lib/ensureArray";
import { AppLoader } from "@/components/AppLoader";

type Issue = {
  id: string;
  title: string;
  status: string;
  startDate?: string | null;
  start_date?: string | null;
  dueDate?: string | null;
  due_date?: string | null;
  targetDate?: string | null;
  target_date?: string | null;
};

function pickStart(i: Issue): Date | null {
  const v = i.startDate ?? i.start_date ?? null;
  return v ? new Date(v) : null;
}
function pickEnd(i: Issue): Date | null {
  const v = i.dueDate ?? i.due_date ?? i.targetDate ?? i.target_date ?? null;
  return v ? new Date(v) : null;
}

export function GanttTab({ projectId, companyId }: { projectId: string; companyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["project-tabs", "gantt", companyId, projectId],
    queryFn: () => issuesApi.list(companyId, { projectId, limit: 500 }),
    enabled: Boolean(projectId && companyId),
    select: (d) => ensureArray<Issue>(d),
  });

  const { rows, min, max } = useMemo(() => {
    const list = (data ?? [])
      .map((it) => ({ it, start: pickStart(it), end: pickEnd(it) }))
      .filter((r) => r.start && r.end) as { it: Issue; start: Date; end: Date }[];
    if (list.length === 0) return { rows: [], min: 0, max: 0 };
    const min = Math.min(...list.map((r) => r.start.getTime()));
    const max = Math.max(...list.map((r) => r.end.getTime()));
    return { rows: list, min, max };
  }, [data]);

  if (isLoading) return <AppLoader variant="page" label="Loading timeline…" />;
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted-foreground">No issues with start + due dates yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Add a start date and due date to issues to see them on the timeline.
        </p>
      </div>
    );
  }

  const span = Math.max(max - min, 1);
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{new Date(min).toLocaleDateString()}</span>
        <span>{new Date(max).toLocaleDateString()}</span>
      </div>
      <div className="space-y-1">
        {rows.map(({ it, start, end }) => {
          const left = ((start.getTime() - min) / span) * 100;
          const width = Math.max(((end.getTime() - start.getTime()) / span) * 100, 1.5);
          return (
            <Link
              key={it.id}
              to={`/issues/${it.id}`}
              className="relative block h-7 rounded bg-muted/40 hover:bg-muted/60"
            >
              <span
                className="absolute top-0 bottom-0 rounded bg-primary/70"
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${it.title} (${start.toLocaleDateString()} → ${end.toLocaleDateString()})`}
              />
              <span className="relative z-10 ml-2 inline-block translate-y-1 text-xs font-medium">
                {it.title}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
