import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { newId } from './ids'
import type { EnvBindings, RequestContext } from './context'

type UserRow = {
  id: string
  email: string | null
  name: string | null
}

type SessionRow = {
  id: string
  user_id: string
  tenant_id: string
  expires_at: number
}

export type SessionIdentity = {
  sessionId: string
  tenantId: string
  userId: string
  userEmail: string | null
  userName: string | null
  role: RequestContext['role']
  expiresAt: number
}

export type CreatedSession = {
  token: string
  sessionId: string
  expiresAt: number
}

const SESSION_COOKIE = 'taskcenter_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30
const PASSWORD_HASH_PREFIX = 'pbkdf2_sha256'
const PBKDF2_ITERATIONS = 30000
const LEGACY_PBKDF2_ITERATIONS = 120000

function getForwardedHeader(value?: string | null) {
  return value?.split(',')[0]?.trim() || null
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return encodeBase64Url(new Uint8Array(digest))
}

function getOtpTtlMs(env: EnvBindings) {
  const configured = Number(env.AUTH_OTP_TTL_SECONDS || '')
  const ttlSeconds = Number.isFinite(configured) ? configured : 10 * 60
  return Math.max(60, Math.min(60 * 60, Math.floor(ttlSeconds))) * 1000
}

function maskEmail(email: string) {
  const [local, domain] = email.split('@')
  if (!local || !domain) return email
  const head = local.slice(0, 2)
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${domain}`
}

function buildAuthEmailTemplate(input: {
  preview: string
  headline: string
  body: string
  code?: string
  ctaLabel?: string
  ctaUrl?: string
  footer?: string
}) {
  const codeBlock = input.code
    ? `<div style="margin:24px 0;padding:18px 20px;border-radius:18px;background:#0f172a;color:#f8fafc;font-size:28px;letter-spacing:0.28em;font-weight:700;text-align:center;">${input.code}</div>`
    : ''
  const cta = input.ctaLabel && input.ctaUrl
    ? `<div style="margin-top:24px;"><a href="${input.ctaUrl}" style="display:inline-block;padding:14px 22px;border-radius:999px;background:#10b981;color:#04130d;text-decoration:none;font-weight:700;">${input.ctaLabel}</a></div>`
    : ''
  return {
    text: [input.preview, '', input.headline, input.body, input.code ? `Code: ${input.code}` : null, input.ctaUrl ? input.ctaUrl : null, input.footer || 'TaskCenter'].filter(Boolean).join('\n'),
    html: `<!doctype html>
<html>
  <body style="margin:0;background:#020617;font-family:Inter,Arial,sans-serif;color:#e2e8f0;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${input.preview}</div>
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <div style="border:1px solid rgba(148,163,184,0.16);border-radius:28px;background:linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.98));padding:32px;">
        <div style="font-size:11px;letter-spacing:0.24em;text-transform:uppercase;color:#94a3b8;">TaskCenter</div>
        <h1 style="margin:12px 0 0;font-size:30px;line-height:1.15;color:#f8fafc;">${input.headline}</h1>
        <p style="margin:16px 0 0;font-size:15px;line-height:1.7;color:#cbd5e1;">${input.body}</p>
        ${codeBlock}
        ${cta}
        <p style="margin:28px 0 0;font-size:12px;line-height:1.7;color:#94a3b8;">${input.footer || 'This message came from your TaskCenter workspace.'}</p>
      </div>
    </div>
  </body>
</html>`,
  }
}

async function derivePasswordBits(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const saltView = new Uint8Array(salt)
  return crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltView,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  )
}

function getPasswordIterations(env?: EnvBindings): number {
  const configured = Number(env?.AUTH_PBKDF2_ITERATIONS || '')
  if (!Number.isFinite(configured)) return PBKDF2_ITERATIONS
  return Math.max(10000, Math.min(200000, Math.floor(configured)))
}

function formatStoredPasswordHash(hash: string, iterations: number) {
  return `${PASSWORD_HASH_PREFIX}$${iterations}$${hash}`
}

function parseStoredPasswordHash(value: string): { hash: string; iterations: number | null; versioned: boolean } {
  const [prefix, rawIterations, hash] = value.split('$')
  if (prefix === PASSWORD_HASH_PREFIX && hash) {
    const iterations = Number(rawIterations)
    return {
      hash,
      iterations: Number.isFinite(iterations) ? iterations : PBKDF2_ITERATIONS,
      versioned: true,
    }
  }

  return {
    hash: value,
    iterations: null,
    versioned: false,
  }
}

export async function hashPassword(password: string, env?: EnvBindings): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iterations = getPasswordIterations(env)
  const bits = await derivePasswordBits(password, salt, iterations)
  return {
    hash: formatStoredPasswordHash(encodeBase64Url(new Uint8Array(bits)), iterations),
    salt: encodeBase64Url(salt),
  }
}

export async function verifyPassword(
  env: EnvBindings,
  password: string,
  salt: string,
  expectedHash: string
): Promise<{ valid: boolean; needsRehash: boolean }> {
  const saltBytes = decodeBase64Url(salt)
  const targetIterations = getPasswordIterations(env)
  const stored = parseStoredPasswordHash(expectedHash)

  if (stored.versioned && stored.iterations) {
    const bits = await derivePasswordBits(password, saltBytes, stored.iterations)
    const valid = encodeBase64Url(new Uint8Array(bits)) === stored.hash
    return {
      valid,
      needsRehash: valid && stored.iterations !== targetIterations,
    }
  }

  try {
    const currentBits = await derivePasswordBits(password, saltBytes, 100000)
    if (encodeBase64Url(new Uint8Array(currentBits)) === stored.hash) {
      return { valid: true, needsRehash: true }
    }

    const legacyBits = await derivePasswordBits(password, saltBytes, LEGACY_PBKDF2_ITERATIONS)
    return {
      valid: encodeBase64Url(new Uint8Array(legacyBits)) === stored.hash,
      needsRehash: true,
    }
  } catch {
    return { valid: false, needsRehash: false }
  }
}

function getSessionSecret(env: EnvBindings): string {
  if (!env.AUTH_SESSION_SECRET) {
    throw new Error('AUTH_SESSION_SECRET is not configured')
  }
  return env.AUTH_SESSION_SECRET
}

export function readSessionToken(c: Context): string | null {
  const authHeader = c.req.header('authorization') || c.req.header('Authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
  return bearerToken || getCookie(c, SESSION_COOKIE) || null
}

async function hashSessionToken(env: EnvBindings, token: string): Promise<string> {
  return sha256(`${getSessionSecret(env)}:${token}`)
}

async function hashOtpCode(env: EnvBindings, email: string, code: string) {
  return sha256(`${getSessionSecret(env)}:otp:${email.trim().toLowerCase()}:${code}`)
}

export async function createSession(env: EnvBindings, userId: string, tenantId: string): Promise<CreatedSession> {
  const sessionId = newId('sess')
  const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  const tokenHash = await hashSessionToken(env, token)
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS
  await env.DB.prepare(
    `INSERT INTO auth_sessions (id, user_id, tenant_id, token_hash, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(sessionId, userId, tenantId, tokenHash, expiresAt, now, now)
    .run()
  return { token, sessionId, expiresAt }
}

export function resolveAppOrigin(
  requestUrl: string,
  publicAppUrl?: string | null,
  forwardedProto?: string | null,
  forwardedHost?: string | null
) {
  if (publicAppUrl) {
    return new URL(publicAppUrl).origin
  }

  const base = new URL(requestUrl)
  const proto = getForwardedHeader(forwardedProto)
  const host = getForwardedHeader(forwardedHost)

  if (proto) {
    base.protocol = proto.replace(/:$/, '') + ':'
  }

  if (host) {
    base.host = host
  }

  return base.origin
}

function shouldUseSecureCookie(
  requestUrl: string,
  publicAppUrl?: string | null,
  forwardedProto?: string | null,
  forwardedHost?: string | null
) {
  return new URL(resolveAppOrigin(requestUrl, publicAppUrl, forwardedProto, forwardedHost)).protocol === 'https:'
}

export function setSessionCookie(c: Context, env: EnvBindings, token: string) {
  const secure = shouldUseSecureCookie(
    c.req.url,
    env.PUBLIC_APP_URL,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host')
  )

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export function clearSessionCookie(c: Context, env?: EnvBindings) {
  const secure = shouldUseSecureCookie(
    c.req.url,
    env?.PUBLIC_APP_URL,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host')
  )

  deleteCookie(c, SESSION_COOKIE, {
    path: '/',
    secure,
    sameSite: 'Lax',
  })
}

export async function deleteSession(env: EnvBindings, token: string | null) {
  if (!token) return
  const tokenHash = await hashSessionToken(env, token)
  await env.DB.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).bind(tokenHash).run()
}

export async function resolveSessionContext(
  env: EnvBindings,
  token: string
): Promise<SessionIdentity | null> {
  const tokenHash = await hashSessionToken(env, token)
  const now = Date.now()
  const session = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.tenant_id, s.expires_at, u.email, u.name,
            COALESCE(m.role, 'member') AS role
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
     WHERE s.token_hash = ?
     LIMIT 1`
  )
    .bind(tokenHash)
    .first<(SessionRow & UserRow & { role: RequestContext['role'] }) | null>()

  if (!session) return null
  if (session.expires_at <= now) {
    await env.DB.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).bind(tokenHash).run()
    return null
  }

  await env.DB.prepare(`UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?`).bind(now, session.id).run()

  return {
    sessionId: session.id,
    tenantId: session.tenant_id,
    userId: session.user_id,
    userEmail: session.email,
    userName: session.name,
    role: session.role,
    expiresAt: session.expires_at,
  }
}

export async function ensureTenant(env: EnvBindings, tenantId: string, name = 'Default Workspace') {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)`)
    .bind(tenantId, name, Date.now())
    .run()
}

export async function ensureMembership(env: EnvBindings, tenantId: string, userId: string, role?: RequestContext['role']) {
  const now = Date.now()
  const existing = await env.DB.prepare(
    `SELECT id, role FROM memberships WHERE tenant_id = ? AND user_id = ? LIMIT 1`
  )
    .bind(tenantId, userId)
    .first<{ id: string; role: RequestContext['role'] } | null>()

  if (existing) return existing.role

  const members = await env.DB.prepare(`SELECT COUNT(*) AS count FROM memberships WHERE tenant_id = ?`)
    .bind(tenantId)
    .first<{ count: number }>()

  const resolvedRole = role || ((members?.count || 0) === 0 ? 'owner' : 'member')
  await env.DB.prepare(
    `INSERT INTO memberships (id, tenant_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(newId('mship'), tenantId, userId, resolvedRole, now, now)
    .run()

  return resolvedRole
}

export async function findCredentialByEmail(env: EnvBindings, email: string) {
  return env.DB.prepare(
    `SELECT user_id, email, password_hash, password_salt
     FROM auth_credentials
     WHERE email = ?
     LIMIT 1`
  )
    .bind(email.trim().toLowerCase())
    .first<{ user_id: string; email: string; password_hash: string; password_salt: string } | null>()
}

export async function createLocalUser(env: EnvBindings, input: { email: string; password: string; name?: string | null }) {
  const email = input.email.trim().toLowerCase()
  const name = input.name?.trim() || email.split('@')[0] || 'User'
  const tenantId = 'tenant_default'
  const now = Date.now()
  const password = await hashPassword(input.password, env)

  await ensureTenant(env, tenantId)
  const existingUser = await env.DB.prepare(`SELECT id FROM users WHERE tenant_id = ? AND LOWER(email) = LOWER(?) LIMIT 1`)
    .bind(tenantId, email)
    .first<{ id: string } | null>()

  const userId = existingUser?.id || newId('user')

  if (existingUser) {
    await env.DB.prepare(`UPDATE users SET name = COALESCE(?, name) WHERE id = ?`)
      .bind(name, userId)
      .run()
  } else {
    await env.DB.prepare(`INSERT INTO users (id, tenant_id, email, name, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(userId, tenantId, email, name, now)
      .run()
  }
  await env.DB.prepare(
    `INSERT INTO auth_credentials (user_id, email, password_hash, password_salt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, email, password.hash, password.salt, now, now)
    .run()
  const role = await ensureMembership(env, tenantId, userId)
  return { userId, tenantId, email, name, role }
}

export async function upgradeCredentialPassword(env: EnvBindings, userId: string, password: string) {
  const next = await hashPassword(password, env)
  await env.DB.prepare(
    `UPDATE auth_credentials
     SET password_hash = ?, password_salt = ?, updated_at = ?
     WHERE user_id = ?`
  )
    .bind(next.hash, next.salt, Date.now(), userId)
    .run()
}

export async function sendEmailOtpCode(
  env: EnvBindings,
  input: { email: string; purpose?: 'sign_in' | 'verify_email' }
) {
  if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM) {
    throw new Error('Email OTP delivery is not configured. Set RESEND_API_KEY and AUTH_EMAIL_FROM.')
  }

  const email = input.email.trim().toLowerCase()
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const now = Date.now()
  const expiresAt = now + getOtpTtlMs(env)
  const user = await env.DB.prepare(`SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`)
    .bind(email)
    .first<{ id: string } | null>()

  await env.DB.prepare(
    `UPDATE auth_email_otps
     SET consumed_at = ?
     WHERE email = ? AND purpose = ? AND consumed_at IS NULL`
  )
    .bind(now, email, input.purpose || 'sign_in')
    .run()

  await env.DB.prepare(
    `INSERT INTO auth_email_otps (id, email, user_id, purpose, code_hash, expires_at, consumed_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`
  )
    .bind(
      newId('otp'),
      email,
      user?.id || null,
      input.purpose || 'sign_in',
      await hashOtpCode(env, email, code),
      expiresAt,
      now
    )
    .run()

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.AUTH_EMAIL_FROM,
      to: [email],
      subject: 'Your TaskCenter sign-in code',
      ...buildAuthEmailTemplate({
        preview: `Your TaskCenter sign-in code is ${code}.`,
        headline: 'Your sign-in code is ready',
        body: `Use this 6-digit code to sign in to TaskCenter. It expires in ${Math.round((expiresAt - now) / 60000)} minutes.`,
        code,
        footer: 'If you did not request this code, you can safely ignore this email.',
      }),
    }),
  })

  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(`Email OTP delivery failed${message ? `: ${message}` : '.'}`)
  }

  return {
    accepted: true,
    maskedEmail: maskEmail(email),
    expiresAt,
  }
}

export async function verifyEmailOtpCode(
  env: EnvBindings,
  input: { email: string; code: string; purpose?: 'sign_in' | 'verify_email' }
) {
  const email = input.email.trim().toLowerCase()
  const purpose = input.purpose || 'sign_in'
  const now = Date.now()
  const record = await env.DB.prepare(
    `SELECT id, user_id, code_hash, expires_at, attempts
     FROM auth_email_otps
     WHERE email = ? AND purpose = ? AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(email, purpose)
    .first<{ id: string; user_id: string | null; code_hash: string; expires_at: number; attempts: number } | null>()

  if (!record || record.expires_at <= now || record.attempts >= 8) {
    return { valid: false, userId: null as string | null, reason: 'expired_or_missing' as const }
  }

  const expected = await hashOtpCode(env, email, input.code.trim())
  if (expected !== record.code_hash) {
    await env.DB.prepare(`UPDATE auth_email_otps SET attempts = attempts + 1 WHERE id = ?`).bind(record.id).run()
    return { valid: false, userId: null as string | null, reason: 'invalid_code' as const }
  }

  await env.DB.prepare(`UPDATE auth_email_otps SET consumed_at = ? WHERE id = ?`).bind(now, record.id).run()
  return { valid: true, userId: record.user_id, reason: null as null }
}

export async function findOrCreateGoogleUser(
  env: EnvBindings,
  input: { email: string; name?: string | null; googleUserId: string }
) {
  return findOrCreateOAuthUser(env, {
    provider: 'google',
    providerUserId: input.googleUserId,
    email: input.email,
    name: input.name,
  })
}

export async function findOrCreateGitHubUser(
  env: EnvBindings,
  input: { email: string; name?: string | null; githubUserId: string }
) {
  return findOrCreateOAuthUser(env, {
    provider: 'github',
    providerUserId: input.githubUserId,
    email: input.email,
    name: input.name,
  })
}

async function findOrCreateOAuthUser(
  env: EnvBindings,
  input: { provider: 'google' | 'github'; providerUserId: string; email: string; name?: string | null }
) {
  const email = input.email.trim().toLowerCase()
  const now = Date.now()
  const existingOAuth = await env.DB.prepare(
    `SELECT user_id FROM auth_oauth_accounts WHERE provider = ? AND provider_user_id = ? LIMIT 1`
  )
    .bind(input.provider, input.providerUserId)
    .first<{ user_id: string } | null>()

  let userId = existingOAuth?.user_id || null
  let tenantId = 'tenant_default'

  if (!userId) {
    const existingUser = await env.DB.prepare(`SELECT id, tenant_id FROM users WHERE email = ? LIMIT 1`)
      .bind(email)
      .first<{ id: string; tenant_id: string } | null>()

    if (existingUser) {
      userId = existingUser.id
      tenantId = existingUser.tenant_id
      await env.DB.prepare(`UPDATE users SET name = COALESCE(?, name) WHERE id = ?`).bind(input.name || null, userId).run()
    } else {
      await ensureTenant(env, tenantId)
      userId = newId('user')
      await env.DB.prepare(`INSERT INTO users (id, tenant_id, email, name, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(userId, tenantId, email, input.name || email.split('@')[0] || 'User', now)
        .run()
    }

    await env.DB.prepare(
      `INSERT OR REPLACE INTO auth_oauth_accounts (id, user_id, provider, provider_user_id, email, created_at, updated_at)
       VALUES (
         COALESCE((SELECT id FROM auth_oauth_accounts WHERE provider = ? AND provider_user_id = ? LIMIT 1), ?),
         ?, ?, ?, ?,
         COALESCE((SELECT created_at FROM auth_oauth_accounts WHERE provider = ? AND provider_user_id = ? LIMIT 1), ?),
         ?
       )`
    )
      .bind(
        input.provider,
        input.providerUserId,
        newId('oauth'),
        userId,
        input.provider,
        input.providerUserId,
        email,
        input.provider,
        input.providerUserId,
        now,
        now
      )
      .run()
  }

  const role = await ensureMembership(env, tenantId, userId)
  const user = await env.DB.prepare(`SELECT email, name FROM users WHERE id = ? LIMIT 1`)
    .bind(userId)
    .first<{ email: string | null; name: string | null }>()

  return {
    userId,
    tenantId,
    email: user?.email || email,
    name: user?.name || input.name || email.split('@')[0] || 'User',
    role,
  }
}

export async function getCurrentSession(env: EnvBindings, token: string | null) {
  if (!token) return null
  return resolveSessionContext(env, token)
}

function hmacPayload(secret: string, payload: string) {
  return crypto.subtle
    .importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    .then((key) => crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
    .then((signature) => encodeBase64Url(new Uint8Array(signature)))
}

export async function signOAuthState(env: EnvBindings, payload: Record<string, unknown>) {
  const json = JSON.stringify(payload)
  const encoded = encodeBase64Url(new TextEncoder().encode(json))
  const signature = await hmacPayload(getSessionSecret(env), encoded)
  return `${encoded}.${signature}`
}

export async function verifyOAuthState<T>(env: EnvBindings, state: string): Promise<T | null> {
  const [encoded, signature] = state.split('.')
  if (!encoded || !signature) return null
  const expected = await hmacPayload(getSessionSecret(env), encoded)
  if (expected !== signature) return null
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as T
  } catch {
    return null
  }
}

export function getGoogleRedirectUri(
  requestUrl: string,
  publicAppUrl?: string | null,
  forwardedProto?: string | null,
  forwardedHost?: string | null
) {
  return getOAuthRedirectUri('/api/auth/google/callback', requestUrl, publicAppUrl, forwardedProto, forwardedHost)
}

export function getGitHubRedirectUri(
  requestUrl: string,
  publicAppUrl?: string | null,
  forwardedProto?: string | null,
  forwardedHost?: string | null
) {
  return getOAuthRedirectUri('/api/auth/github/callback', requestUrl, publicAppUrl, forwardedProto, forwardedHost)
}

function getOAuthRedirectUri(
  callbackPath: string,
  requestUrl: string,
  publicAppUrl?: string | null,
  forwardedProto?: string | null,
  forwardedHost?: string | null
) {
  return new URL(
    callbackPath,
    resolveAppOrigin(requestUrl, publicAppUrl, forwardedProto, forwardedHost)
  ).toString()
}

export function sanitizeCallbackUrl(
  requestUrl: string,
  publicAppUrl?: string | null,
  candidate?: string | null,
  forwardedProto?: string | null,
  forwardedHost?: string | null
) {
  const origin = resolveAppOrigin(requestUrl, publicAppUrl, forwardedProto, forwardedHost)
  if (!candidate) return `${origin}/dashboard`

  try {
    const url = new URL(candidate, origin)
    if (url.origin !== origin) return `${origin}/dashboard`
    return url.toString()
  } catch {
    return `${origin}/dashboard`
  }
}
