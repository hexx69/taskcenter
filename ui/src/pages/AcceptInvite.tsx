// /accept-invite/:token — landing page for project member invites.
// Requires the user to be signed in; if they aren't, the worker's session
// middleware will 401 and the API client throws — we route to /login with
// a redirect-back token.

import { useEffect } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/api/client";
import { inviteAcceptApi } from "@/api/projectMembers";

export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const preview = useQuery({
    queryKey: ["invite-preview", token],
    queryFn: () => inviteAcceptApi.preview(token!),
    enabled: Boolean(token),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => inviteAcceptApi.accept(token!),
    onSuccess: (data) => navigate(`/projects/${data.projectId}`),
  });

  useEffect(() => {
    if (preview.error instanceof ApiError && preview.error.status === 401) {
      navigate(`/login?redirect=${encodeURIComponent(`/accept-invite/${token}`)}`);
    }
  }, [preview.error, navigate, token]);

  if (preview.isLoading) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading invite…</p>
      </div>
    );
  }

  if (preview.error) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <h1 className="text-lg font-semibold">Invite not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The invite link may have expired or already been used.
        </p>
      </div>
    );
  }

  const data = preview.data!;
  if (data.inviteStatus === "accepted") {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        <h1 className="text-lg font-semibold">You're already in</h1>
        <Button className="mt-4" onClick={() => navigate(`/projects/${data.projectId}`)}>
          Open project
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 py-20 text-center">
      <h1 className="text-lg font-semibold">Join this project</h1>
      <p className="text-sm text-muted-foreground">
        You've been invited as <strong>{data.role}</strong>. Click below to accept.
      </p>
      <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
        {accept.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
        Accept invite
      </Button>
      {accept.error ? (
        <p className="text-xs text-destructive">
          {accept.error instanceof Error ? accept.error.message : "Failed to accept invite."}
        </p>
      ) : null}
    </div>
  );
}

export default AcceptInvitePage;
