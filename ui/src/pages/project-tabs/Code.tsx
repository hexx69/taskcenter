// Code tab — file tree + content viewer for the linked GitHub repo.
// New worker routes /api/projects/:id/repo/tree and /repo/file are added
// in this cycle. Until they ship, this tab degrades to an instructional
// empty state instead of a crash.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { File, Folder, FolderOpen } from "lucide-react";
import { ApiError, api } from "@/api/client";
import { ensureArray } from "@/lib/ensureArray";
import { AppLoader } from "@/components/AppLoader";

type TreeEntry = {
  path: string;
  type: "blob" | "tree";
  size: number | null;
};

export function CodeTab({ projectId }: { projectId: string }) {
  const [selected, setSelected] = useState<string | null>(null);

  const tree = useQuery({
    queryKey: ["project-tabs", "code", "tree", projectId],
    queryFn: () => api.get<TreeEntry[]>(`/projects/${projectId}/repo/tree`),
    enabled: Boolean(projectId),
    select: (d) => ensureArray<TreeEntry>(d),
    retry: false,
  });

  const file = useQuery({
    queryKey: ["project-tabs", "code", "file", projectId, selected],
    queryFn: () =>
      api.get<{ content: string; encoding: string }>(
        `/projects/${projectId}/repo/file?path=${encodeURIComponent(selected!)}`,
      ),
    enabled: Boolean(projectId && selected),
    retry: false,
  });

  if (tree.isLoading) return <AppLoader variant="page" label="Loading repository…" />;
  if (tree.error) {
    const isNotConfigured = tree.error instanceof ApiError && (tree.error.status === 404 || tree.error.status === 400);
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <p className="text-sm font-medium">Connect a GitHub repository</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {isNotConfigured
            ? "Link this project to a GitHub repo from Project Settings → Integrations to browse code here."
            : "Couldn't reach GitHub. Check the project's GitHub link in Project Settings."}
        </p>
      </div>
    );
  }

  const entries = (tree.data ?? []).slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
      <aside className="rounded-md border border-border bg-card p-2">
        <ul className="space-y-0.5 text-sm">
          {entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                onClick={() => e.type === "blob" && setSelected(e.path)}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent/40 ${
                  selected === e.path ? "bg-accent/60" : ""
                }`}
              >
                {e.type === "tree" ? (
                  selected?.startsWith(e.path + "/") ? (
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )
                ) : (
                  <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{e.path}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="min-h-[300px] rounded-md border border-border bg-card p-3">
        {!selected ? (
          <p className="text-sm text-muted-foreground">Pick a file from the tree.</p>
        ) : file.isLoading ? (
          <AppLoader variant="panel" label="Loading file…" />
        ) : file.error ? (
          <p className="text-sm text-destructive">Failed to load file.</p>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs font-mono text-foreground">
            {file.data?.content}
          </pre>
        )}
      </main>
    </div>
  );
}
