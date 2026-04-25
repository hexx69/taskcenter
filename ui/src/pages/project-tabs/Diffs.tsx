// Diffs tab — recent commits + diff viewer for the project's linked GitHub
// repo. Worker route `/api/projects/:id/repo/commits` is added in this cycle.
// Until that ships, this tab is a placeholder that explains why it's empty.

import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "@/api/client";
import { ensureArray } from "@/lib/ensureArray";
import { AppLoader } from "@/components/AppLoader";

type Commit = {
  sha: string;
  message: string;
  authorName: string | null;
  authoredAt: string | null;
  url: string | null;
};

export function DiffsTab({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["project-tabs", "diffs", projectId],
    queryFn: () => api.get<Commit[]>(`/projects/${projectId}/repo/commits?limit=30`),
    enabled: Boolean(projectId),
    select: (d) => ensureArray<Commit>(d),
    retry: false,
  });

  if (isLoading) return <AppLoader variant="page" label="Loading commits…" />;
  if (error) {
    const isNotConfigured = error instanceof ApiError && (error.status === 404 || error.status === 400);
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <p className="text-sm font-medium">Connect a GitHub repository</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {isNotConfigured
            ? "Link this project to a GitHub repo from Project Settings → Integrations to see commits and diffs here."
            : "Couldn't reach GitHub. Check the project's GitHub link in Project Settings."}
        </p>
      </div>
    );
  }
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No recent commits.</p>;
  }

  return (
    <div className="space-y-2">
      {data.map((c) => (
        <a
          key={c.sha}
          href={c.url ?? "#"}
          target="_blank"
          rel="noreferrer noopener"
          className="block rounded-md border border-border bg-card p-3 hover:bg-accent/30"
        >
          <p className="text-sm font-medium">{c.message.split("\n")[0]}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {c.sha.slice(0, 7)} · {c.authorName ?? "unknown"}
            {c.authoredAt ? ` · ${new Date(c.authoredAt).toLocaleDateString()}` : ""}
          </p>
        </a>
      ))}
    </div>
  );
}
