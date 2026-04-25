// Board tab — kanban view of the project's issues grouped by status.
// Lightweight CSS-grid implementation (no DnD library yet); cards link to
// the existing issue detail page so we don't reimplement the chrome.

import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "@/api/issues";
import { ensureArray } from "@/lib/ensureArray";
import { AppLoader } from "@/components/AppLoader";

const COLUMNS: { key: string; label: string; tone: string }[] = [
  { key: "backlog", label: "Backlog", tone: "text-muted-foreground" },
  { key: "in_progress", label: "In Progress", tone: "text-blue-500" },
  { key: "blocked", label: "Blocked", tone: "text-red-500" },
  { key: "done", label: "Done", tone: "text-green-500" },
];

type IssueRow = {
  id: string;
  title: string;
  status: string;
  priority?: string | null;
  issueKey?: string | null;
};

function normaliseStatus(status: string): string {
  const s = status.toLowerCase().replace("-", "_");
  if (s === "in_progress" || s === "inprogress") return "in_progress";
  if (s === "done" || s === "completed" || s === "closed") return "done";
  if (s === "blocked") return "blocked";
  return "backlog";
}

export function BoardTab({ projectId, companyId }: { projectId: string; companyId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["project-tabs", "board", companyId, projectId],
    queryFn: () => issuesApi.list(companyId, { projectId, limit: 500 }),
    enabled: Boolean(projectId && companyId),
    select: (d) => ensureArray<IssueRow>(d),
  });

  if (isLoading) return <AppLoader variant="page" label="Loading board…" />;
  if (error) return <p className="text-sm text-destructive">Failed to load board.</p>;

  const grouped = new Map<string, IssueRow[]>();
  for (const col of COLUMNS) grouped.set(col.key, []);
  for (const issue of data ?? []) {
    const col = normaliseStatus(issue.status);
    grouped.get(col)?.push(issue);
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {COLUMNS.map((col) => {
        const items = grouped.get(col.key) ?? [];
        return (
          <div key={col.key} className="rounded-lg border border-border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between">
              <h4 className={`text-xs font-medium uppercase tracking-wide ${col.tone}`}>{col.label}</h4>
              <span className="text-xs text-muted-foreground">{items.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {items.length === 0 ? (
                <p className="text-xs text-muted-foreground">—</p>
              ) : (
                items.map((it) => (
                  <Link
                    key={it.id}
                    to={`/issues/${it.id}`}
                    className="rounded-md border border-border bg-background p-2 text-sm hover:bg-accent/30"
                  >
                    <p className="line-clamp-2 font-medium">{it.title}</p>
                    {it.issueKey ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">{it.issueKey}</p>
                    ) : null}
                  </Link>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
