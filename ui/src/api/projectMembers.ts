// Project-members API client. Mirrors the agents/approvals shape so the
// UI can talk to the worker without the Paperclip-shared types covering
// these (yet) — types are local to keep the @paperclipai/shared diff zero.

import { api } from "./client";

export type ProjectMemberRole = "owner" | "editor" | "viewer";
export type ProjectMemberInviteStatus = "pending" | "accepted" | "revoked";

export interface ProjectMember {
  id: string;
  userId: string | null;
  email: string;
  name: string | null;
  role: ProjectMemberRole;
  invitedBy: string;
  inviteStatus: ProjectMemberInviteStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMemberInviteResponse {
  ok: boolean;
  memberId: string;
  approvalId: string;
  inviteToken: string;
}

export const projectMembersApi = {
  list: (projectId: string) =>
    api.get<ProjectMember[]>(`/projects/${projectId}/members`),
  invite: (projectId: string, data: { email: string; role: ProjectMemberRole }) =>
    api.post<ProjectMemberInviteResponse>(`/projects/${projectId}/member-invites`, data),
  remove: (projectId: string, memberId: string) =>
    api.delete<{ ok: boolean }>(`/projects/${projectId}/members/${memberId}`),
};

export const inviteAcceptApi = {
  preview: (token: string) =>
    api.get<{
      projectId: string;
      email: string;
      role: ProjectMemberRole;
      inviteStatus: ProjectMemberInviteStatus;
    }>(`/invites/${encodeURIComponent(token)}`),
  accept: (token: string) =>
    api.post<{ ok: boolean; projectId: string }>(
      `/invites/${encodeURIComponent(token)}/accept`,
      {},
    ),
};
