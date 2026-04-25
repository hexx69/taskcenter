// Members tab — humans who can collaborate on this project alongside
// agents. Invite flow mirrors the agent-hire approval pattern.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Mail, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { projectMembersApi, type ProjectMemberRole } from "@/api/projectMembers";
import { ensureArray } from "@/lib/ensureArray";
import { AppLoader } from "@/components/AppLoader";

const ROLES: ProjectMemberRole[] = ["owner", "editor", "viewer"];

export function MembersTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectMemberRole>("editor");
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => projectMembersApi.list(projectId),
    enabled: Boolean(projectId),
    select: (d) => ensureArray<NonNullable<typeof d> extends Array<infer U> ? U : never>(d),
  });

  const invite = useMutation({
    mutationFn: (input: { email: string; role: ProjectMemberRole }) =>
      projectMembersApi.invite(projectId, input),
    onSuccess: () => {
      setOpen(false);
      setEmail("");
      setRole("editor");
      setError(null);
      qc.invalidateQueries({ queryKey: ["project-members", projectId] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Invite failed."),
  });

  const remove = useMutation({
    mutationFn: (memberId: string) => projectMembersApi.remove(projectId, memberId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-members", projectId] }),
  });

  if (list.isLoading) return <AppLoader variant="page" label="Loading members…" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Humans on this project. Invites are gated by the company CEO approval.
        </p>
        <Button size="sm" onClick={() => setOpen(true)}>
          <UserPlus className="mr-1.5 h-4 w-4" /> Invite member
        </Button>
      </div>

      {(list.data ?? []).length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">No members yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Click "Invite member" to add a teammate.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {(list.data ?? []).map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.name ?? m.email}</p>
                <p className="text-xs text-muted-foreground">
                  {m.email} · {m.role}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] uppercase tracking-wide ${
                    m.inviteStatus === "accepted"
                      ? "bg-emerald-500/15 text-emerald-600"
                      : m.inviteStatus === "pending"
                        ? "bg-amber-500/15 text-amber-600"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {m.inviteStatus}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => remove.mutate(m.id)}
                  aria-label="Remove member"
                  disabled={remove.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>
              They'll get an email with a join link once the CEO approves the invite.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Email</label>
              <Input
                type="email"
                placeholder="teammate@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Role</label>
              <div className="mt-1 flex gap-1">
                {ROLES.map((r) => (
                  <Button
                    key={r}
                    size="sm"
                    variant={role === r ? "default" : "outline"}
                    onClick={() => setRole(r)}
                  >
                    {r}
                  </Button>
                ))}
              </div>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={!email || invite.isPending}
              onClick={() => invite.mutate({ email, role })}
            >
              {invite.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Mail className="mr-1.5 h-4 w-4" />
              )}
              Send invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
