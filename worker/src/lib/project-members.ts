// Project members — humans who collaborate on a project alongside agents.
// Mirrors the agent-hire pattern: invite creates a company_approvals row;
// when the CEO approves, the project_members row activates and an email
// goes out (Resend) with a signed-link the invitee uses to join.

import { newId } from './ids'
import type { EnvBindings } from './context'
import { nanoid } from 'nanoid'

export type ProjectMemberRole = 'owner' | 'editor' | 'viewer'
export type InviteStatus = 'pending' | 'accepted' | 'revoked'

export type ProjectMemberRow = {
  id: string
  tenant_id: string
  project_id: string
  user_id: string | null
  email: string
  role: ProjectMemberRole
  invited_by: string
  invite_token: string | null
  invite_status: InviteStatus
  created_at: number
  updated_at: number
}

// ── Project resolver (tenant-scoped) ──

export async function loadProjectForTenant(
  env: EnvBindings,
  tenantId: string,
  projectId: string,
): Promise<{ id: string; companyId: string | null } | null> {
  const row = await env.DB.prepare(
    `SELECT id, company_id FROM projects WHERE tenant_id = ? AND id = ? LIMIT 1`,
  )
    .bind(tenantId, projectId)
    .first<{ id: string; company_id: string | null } | null>()
  if (!row) return null
  return { id: row.id, companyId: row.company_id }
}

// ── Listing ──

export async function listProjectMembers(
  env: EnvBindings,
  tenantId: string,
  projectId: string,
) {
  const result = await env.DB.prepare(
    `SELECT m.id, m.user_id, m.email, m.role, m.invited_by, m.invite_status,
            m.created_at, m.updated_at,
            u.name AS user_name, u.email AS user_email
     FROM project_members m
     LEFT JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = ? AND m.project_id = ?
     ORDER BY m.created_at ASC`,
  )
    .bind(tenantId, projectId)
    .all<{
      id: string
      user_id: string | null
      email: string
      role: ProjectMemberRole
      invited_by: string
      invite_status: InviteStatus
      created_at: number
      updated_at: number
      user_name: string | null
      user_email: string | null
    }>()

  return (result.results ?? []).map((row) => ({
    id: row.id,
    userId: row.user_id,
    email: row.user_email ?? row.email,
    name: row.user_name,
    role: row.role,
    invitedBy: row.invited_by,
    inviteStatus: row.invite_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

// ── Invite (creates approval row) ──

export async function createProjectMemberInvite(
  env: EnvBindings,
  args: {
    tenantId: string
    projectId: string
    companyId: string
    requestedBy: string
    email: string
    role: ProjectMemberRole
  },
) {
  const now = Date.now()
  const inviteToken = nanoid(32)
  const memberId = newId('pmem')

  // Pre-create the project_members row in 'pending' state so the Members
  // tab can show "Awaiting approval" without waiting for the CEO. The
  // approval execution flips invite_status to 'accepted' (or 'revoked').
  await env.DB.prepare(
    `INSERT INTO project_members
       (id, tenant_id, project_id, user_id, email, role, invited_by,
        invite_token, invite_status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      memberId,
      args.tenantId,
      args.projectId,
      args.email,
      args.role,
      args.requestedBy,
      inviteToken,
      now,
      now,
    )
    .run()

  // Drop a company_approvals row so the CEO sees this in their Inbox
  // alongside agent-hire approvals. Reuses the same approval surface.
  const approvalId = newId('capr')
  await env.DB.prepare(
    `INSERT INTO company_approvals
       (id, tenant_id, company_id, source_type, source_id, status, title,
        summary, payload_json, requested_by, created_at, updated_at)
     VALUES (?, ?, ?, 'project_member_invite', ?, 'pending', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      approvalId,
      args.tenantId,
      args.companyId,
      memberId,
      `Invite ${args.email} to project`,
      `Pending project member invite (${args.role}) requested by user ${args.requestedBy}.`,
      JSON.stringify({
        memberId,
        projectId: args.projectId,
        email: args.email,
        role: args.role,
        inviteToken,
      }),
      args.requestedBy,
      now,
      now,
    )
    .run()

  return { memberId, approvalId, inviteToken }
}

// ── Approval-execution branch ──
// Called from companies.ts:approveCompanyApproval when source_type ===
// 'project_member_invite'. Activates the pending project_members row.

export async function activateProjectMemberFromApproval(
  env: EnvBindings,
  args: { tenantId: string; memberId: string },
) {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE project_members
     SET invite_status = 'accepted', updated_at = ?
     WHERE tenant_id = ? AND id = ?`,
  )
    .bind(now, args.tenantId, args.memberId)
    .run()
}

// ── Token-accept (no auth required for the lookup; handler should bind to
// the signed-in user) ──

export async function findInviteByToken(env: EnvBindings, token: string) {
  return env.DB.prepare(
    `SELECT * FROM project_members WHERE invite_token = ? LIMIT 1`,
  )
    .bind(token)
    .first<ProjectMemberRow | null>()
}

export async function bindInviteToUser(
  env: EnvBindings,
  args: { token: string; userId: string },
) {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE project_members
     SET user_id = ?, invite_token = NULL, invite_status = 'accepted', updated_at = ?
     WHERE invite_token = ?`,
  )
    .bind(args.userId, now, args.token)
    .run()
}

// ── Removal ──

export async function removeProjectMember(
  env: EnvBindings,
  args: { tenantId: string; projectId: string; memberId: string },
) {
  await env.DB.prepare(
    `DELETE FROM project_members
     WHERE tenant_id = ? AND project_id = ? AND id = ?`,
  )
    .bind(args.tenantId, args.projectId, args.memberId)
    .run()
}
