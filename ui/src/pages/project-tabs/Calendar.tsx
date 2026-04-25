// Calendar tab — month grid with project issues placed on their due dates.
// No new worker route; reads issues with filters already supported by
// /api/companies/:id/issues. Approvals overlay is a follow-up.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { issuesApi } from "@/api/issues";
import { ensureArray } from "@/lib/ensureArray";
import { AppLoader } from "@/components/AppLoader";

type Issue = {
  id: string;
  title: string;
  status: string;
  dueDate?: string | null;
  due_date?: string | null;
  targetDate?: string | null;
  target_date?: string | null;
};

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function pickDate(i: Issue): string | null {
  return i.dueDate ?? i.due_date ?? i.targetDate ?? i.target_date ?? null;
}

export function CalendarTab({ projectId, companyId }: { projectId: string; companyId: string }) {
  const [cursor, setCursor] = useState<Date>(startOfMonth(new Date()));

  const { data, isLoading } = useQuery({
    queryKey: ["project-tabs", "calendar", companyId, projectId],
    queryFn: () => issuesApi.list(companyId, { projectId, limit: 500 }),
    enabled: Boolean(projectId && companyId),
    select: (d) => ensureArray<Issue>(d),
  });

  const issuesByDay = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const issue of data ?? []) {
      const dt = pickDate(issue);
      if (!dt) continue;
      const day = new Date(dt).toISOString().slice(0, 10);
      const list = map.get(day) ?? [];
      list.push(issue);
      map.set(day, list);
    }
    return map;
  }, [data]);

  const monthLabel = cursor.toLocaleString(undefined, { month: "long", year: "numeric" });
  const firstDow = (cursor.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null as number | null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1 as number | null),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  if (isLoading) return <AppLoader variant="page" label="Loading calendar…" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{monthLabel}</h3>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCursor(startOfMonth(new Date()))}
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="bg-muted/40 px-2 py-1 text-center font-medium text-muted-foreground">
            {d}
          </div>
        ))}
        {cells.map((cell, idx) => {
          if (cell == null) {
            return <div key={idx} className="min-h-[88px] bg-background/40" />;
          }
          const dateKey = new Date(cursor.getFullYear(), cursor.getMonth(), cell).toISOString().slice(0, 10);
          const items = issuesByDay.get(dateKey) ?? [];
          return (
            <div key={idx} className="min-h-[88px] bg-background p-1">
              <div className="text-[11px] text-muted-foreground">{cell}</div>
              <div className="mt-1 space-y-0.5">
                {items.slice(0, 3).map((it) => (
                  <Link
                    key={it.id}
                    to={`/issues/${it.id}`}
                    className="block truncate rounded px-1 py-0.5 text-[11px] hover:bg-accent/40"
                    title={it.title}
                  >
                    {it.title}
                  </Link>
                ))}
                {items.length > 3 ? (
                  <div className="text-[10px] text-muted-foreground">+{items.length - 3}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
