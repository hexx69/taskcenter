// Project-members routes — list/invite/remove + invite acceptance.
// Mounted at /api/projects/:projectId/members and /api/invites/:token.

import { Hono } from 'hono'
import { z } from 'zod'
import type { EnvBindings, RequestContext } from '../lib/context'
import {
  bindInviteToUser,
  createProjectMemberInvite,
  findInviteByToken,
  listProjectMembers,
  loadProjectForTenant,
  removeProjectMember,
  type ProjectMemberRole,
} from '../lib/project-members'

export const projectMembersRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()
export const inviteAcceptRoute = new Hono<{ Bindings: EnvBindings; Variables: RequestContext }>()

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'editor', 'viewer']).default('editor'),
})

projectMembersRoute.get('/:projectId/members', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.param('projectId')
  const project = await loadProjectForTenant(c.env, tenantId, projectId)
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  const members = await listProjectMembers(c.env, tenantId, projectId)
  return c.json(members)
})

projectMembersRoute.post('/:projectId/member-invites', async (c) => {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const projectId = c.req.param('projectId')

  const project = await loadProjectForTenant(c.env, tenantId, projectId)
  if (!project) return c.json({ error: 'project_not_found' }, 404)
  if (!project.companyId) {
    return c.json({ error: 'project_company_missing' }, 400)
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = InviteSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400)
  }

  const result = await createProjectMemberInvite(c.env, {
    tenantId,
    projectId,
    companyId: project.companyId,
    requestedBy: userId,
    email: parsed.data.email,
    role: parsed.data.role as ProjectMemberRole,
  })

  return c.json({ ok: true, ...result })
})

projectMembersRoute.delete('/:projectId/members/:memberId', async (c) => {
  const tenantId = c.get('tenantId')
  const projectId = c.req.param('projectId')
  const memberId = c.req.param('memberId')

  const project = await loadProjectForTenant(c.env, tenantId, projectId)
  if (!project) return c.json({ error: 'project_not_found' }, 404)

  await removeProjectMember(c.env, { tenantId, projectId, memberId })
  return c.json({ ok: true })
})

// /api/invites/:token/accept — caller must be signed in; binds the invite
// to the current user.
inviteAcceptRoute.post('/:token/accept', async (c) => {
  const userId = c.get('userId')
  const token = c.req.param('token')
  const invite = await findInviteByToken(c.env, token)
  if (!invite) return c.json({ error: 'invite_not_found' }, 404)
  if (invite.invite_status === 'revoked') {
    return c.json({ error: 'invite_revoked' }, 410)
  }
  await bindInviteToUser(c.env, { token, userId })
  return c.json({ ok: true, projectId: invite.project_id })
})

inviteAcceptRoute.get('/:token', async (c) => {
  const token = c.req.param('token')
  const invite = await findInviteByToken(c.env, token)
  if (!invite) return c.json({ error: 'invite_not_found' }, 404)
  return c.json({
    projectId: invite.project_id,
    email: invite.email,
    role: invite.role,
    inviteStatus: invite.invite_status,
  })
})
