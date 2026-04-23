import { newId } from './ids'
import type { EnvBindings, RequestContext } from './context'

type Context = {
  tenantId: string
  userId: string
  userEmail: string | null
  userName: string | null
  role: RequestContext['role']
}

export async function ensureProjectExists(
  env: EnvBindings,
  tenantId: string,
  projectId: string
): Promise<{ id: string; name: string; description: string | null; created_by: string } | null> {
  return env.DB.prepare(
    `SELECT id, name, description, created_by
     FROM projects
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`
  )
    .bind(tenantId, projectId)
    .first<{ id: string; name: string; description: string | null; created_by: string } | null>()
}

export async function ensureRequestActor(
  env: EnvBindings,
  context: Context
) {
  const now = Date.now()
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)`)
    .bind(context.tenantId, 'Default Workspace', now)
    .run()

  let canonicalUserId = context.userId
  if (context.userEmail) {
    const existingByEmail = await env.DB.prepare(
      `SELECT id
       FROM users
       WHERE tenant_id = ? AND LOWER(email) = LOWER(?)
       ORDER BY created_at ASC
       LIMIT 1`
    )
      .bind(context.tenantId, context.userEmail)
      .first<{ id: string } | null>()

    if (existingByEmail?.id) {
      canonicalUserId = existingByEmail.id
      await env.DB.prepare(`UPDATE users SET name = COALESCE(?, name) WHERE id = ?`)
        .bind(context.userName, canonicalUserId)
        .run()
    } else {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, name, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(context.userId, context.tenantId, context.userEmail, context.userName, now)
        .run()
    }
  } else {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, name, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(context.userId, context.tenantId, context.userEmail, context.userName, now)
      .run()
  }

  const existingMembership = await env.DB.prepare(
    `SELECT id, role FROM memberships WHERE tenant_id = ? AND user_id = ? LIMIT 1`
  )
    .bind(context.tenantId, canonicalUserId)
    .first<{ id: string; role: RequestContext['role'] } | null>()

  let effectiveRole = context.role

  if (!existingMembership) {
    const memberCount = await env.DB.prepare(`SELECT COUNT(*) AS count FROM memberships WHERE tenant_id = ?`)
      .bind(context.tenantId)
      .first<{ count: number } | null>()

    const initialRole =
      context.role === 'owner' || context.role === 'admin'
        ? context.role
        : (memberCount?.count ?? 0) === 0
          ? 'owner'
          : 'member'

    await env.DB.prepare(
      `INSERT INTO memberships (id, tenant_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(newId('mship'), context.tenantId, canonicalUserId, initialRole, now, now)
      .run()
    effectiveRole = initialRole
  } else {
    effectiveRole = existingMembership.role
  }

  return {
    userId: canonicalUserId,
    role: effectiveRole,
  }
}
