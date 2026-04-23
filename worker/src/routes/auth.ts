import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings } from '../lib/context'
import {
  clearSessionCookie,
  createLocalUser,
  createSession,
  deleteSession,
  findCredentialByEmail,
  findOrCreateGitHubUser,
  findOrCreateGoogleUser,
  getGitHubRedirectUri,
  getCurrentSession,
  getGoogleRedirectUri,
  readSessionToken,
  resolveAppOrigin,
  sanitizeCallbackUrl,
  sendEmailOtpCode,
  setSessionCookie,
  signOAuthState,
  upgradeCredentialPassword,
  verifyEmailOtpCode,
  verifyOAuthState,
  verifyPassword,
} from '../lib/server-auth'
import { recordSecurityEvent } from '../lib/security-events'

type SessionResponse = {
  session: { expires_at?: number } | null
  user: { id: string; email: string | null; name: string | null; role: 'owner' | 'admin' | 'member' | 'viewer' } | null
}

const emailPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
})

const socialSchema = z.object({
  provider: z.enum(['google', 'github']),
  callbackURL: z.string().optional(),
})

const emailOtpRequestSchema = z.object({
  email: z.string().email(),
})

const emailOtpVerifySchema = z.object({
  email: z.string().email(),
  otp: z.string().trim().regex(/^\d{6}$/),
})

const magicLinkRequestSchema = z.object({
  email: z.string().email(),
  callbackURL: z.string().optional(),
})

export const authRoute = new Hono<{ Bindings: EnvBindings }>()

function jsonAuthPayload(payload: SessionResponse) {
  return {
    data: payload,
    error: null,
  }
}

function buildSessionPayload(input: {
  expiresAt: number
  user: { id: string; email: string | null; name: string | null; role: 'owner' | 'admin' | 'member' | 'viewer' }
}): SessionResponse {
  return {
    session: {
      expires_at: input.expiresAt,
    },
    user: input.user,
  }
}

async function buildSessionResponse(env: EnvBindings, token: string | null): Promise<SessionResponse> {
  const session = await getCurrentSession(env, token)
  if (!session || !token) {
    return { session: null, user: null }
  }

  return {
    session: {
      expires_at: session.expiresAt,
    },
    user: {
      id: session.userId,
      email: session.userEmail,
      name: session.userName,
      role: session.role,
    },
  }
}

authRoute.get('/session', async (c) => {
  const token = readSessionToken(c)
  const payload = await buildSessionResponse(c.env, token)
  if (!payload.user) {
    clearSessionCookie(c, c.env)
  }
  return c.json(jsonAuthPayload(payload))
})

authRoute.post('/sign-up', zValidator('json', emailPasswordSchema), async (c) => {
  const payload = c.req.valid('json')
  const existing = await findCredentialByEmail(c.env, payload.email)
  if (existing) {
    return c.json({ data: null, error: { message: 'An account with that email already exists.' } }, 409)
  }

  const user = await createLocalUser(c.env, payload)
  const createdSession = await createSession(c.env, user.userId, user.tenantId)
  setSessionCookie(c, c.env, createdSession.token)
  const sessionPayload = buildSessionPayload({
    expiresAt: createdSession.expiresAt,
    user: {
      id: user.userId,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  })
  await recordSecurityEvent(c.env, {
    tenantId: user.tenantId,
    userId: user.userId,
    eventType: 'account.created',
    description: 'Account created with email and password.',
    request: c.req.raw,
  })
  await recordSecurityEvent(c.env, {
    tenantId: user.tenantId,
    userId: user.userId,
    sessionId: createdSession.sessionId,
    eventType: 'session.created',
    description: 'Signed in after account creation.',
    request: c.req.raw,
  })

  return c.json(jsonAuthPayload(sessionPayload))
})

authRoute.post('/sign-in', zValidator('json', emailPasswordSchema.pick({ email: true, password: true })), async (c) => {
  const payload = c.req.valid('json')
  const credential = await findCredentialByEmail(c.env, payload.email)
  if (!credential) {
    return c.json({ data: null, error: { message: 'Invalid email or password.' } }, 401)
  }

  const verification = await verifyPassword(c.env, payload.password, credential.password_salt, credential.password_hash)
  if (!verification.valid) {
    return c.json({ data: null, error: { message: 'Invalid email or password.' } }, 401)
  }

  const user = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.tenant_id, COALESCE(m.role, 'member') AS role
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = u.tenant_id
     WHERE u.id = ?
     LIMIT 1`
  )
    .bind(credential.user_id)
    .first<{ id: string; email: string | null; name: string | null; tenant_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' } | null>()

  if (!user) {
    return c.json({ data: null, error: { message: 'Account not found.' } }, 404)
  }

  if (verification.needsRehash) {
    await upgradeCredentialPassword(c.env, credential.user_id, payload.password).catch(() => {})
  }

  const createdSession = await createSession(c.env, user.id, user.tenant_id)
  setSessionCookie(c, c.env, createdSession.token)
  const sessionPayload = buildSessionPayload({
    expiresAt: createdSession.expiresAt,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  })
  await recordSecurityEvent(c.env, {
    tenantId: user.tenant_id,
    userId: user.id,
    sessionId: createdSession.sessionId,
    eventType: 'session.created',
    description: 'Signed in with email and password.',
    request: c.req.raw,
  })

  return c.json(jsonAuthPayload(sessionPayload))
})

authRoute.post('/sign-out', async (c) => {
  const token = readSessionToken(c)
  const currentSession = token ? await getCurrentSession(c.env, token) : null
  if (currentSession) {
    await recordSecurityEvent(c.env, {
      tenantId: currentSession.tenantId,
      userId: currentSession.userId,
      sessionId: currentSession.sessionId,
      eventType: 'session.signed_out',
      description: 'Signed out of TaskCenter.',
      request: c.req.raw,
    })
  }
  await deleteSession(c.env, token)
  clearSessionCookie(c, c.env)
  return c.json({ data: { success: true }, error: null })
})

authRoute.post('/email-otp/request', zValidator('json', emailOtpRequestSchema), async (c) => {
  const payload = c.req.valid('json')
  const credential = await findCredentialByEmail(c.env, payload.email)

  if (!credential) {
    return c.json({
      data: {
        accepted: true,
        message: 'If that email exists, a sign-in code is on the way.',
      },
      error: null,
    })
  }

  try {
    const delivery = await sendEmailOtpCode(c.env, {
      email: payload.email,
      purpose: 'sign_in',
    })
    return c.json({
      data: {
        accepted: true,
        maskedEmail: delivery.maskedEmail,
        expires_at: delivery.expiresAt,
        message: 'A sign-in code has been sent to your email.',
      },
      error: null,
    })
  } catch (error) {
    return c.json(
      {
        data: null,
        error: {
          message: error instanceof Error ? error.message : 'Unable to send sign-in code.',
        },
      },
      503
    )
  }
})

authRoute.post('/email-otp/verify', zValidator('json', emailOtpVerifySchema), async (c) => {
  const payload = c.req.valid('json')
  const verification = await verifyEmailOtpCode(c.env, {
    email: payload.email,
    code: payload.otp,
    purpose: 'sign_in',
  })

  if (!verification.valid) {
    return c.json({ data: null, error: { message: 'Invalid or expired email code.' } }, 401)
  }

  const user = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.tenant_id, COALESCE(m.role, 'member') AS role
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = u.tenant_id
     WHERE u.id = ?
     LIMIT 1`
  )
    .bind(verification.userId)
    .first<{ id: string; email: string | null; name: string | null; tenant_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' } | null>()

  if (!user) {
    return c.json({ data: null, error: { message: 'Account not found for this email code.' } }, 404)
  }

  const createdSession = await createSession(c.env, user.id, user.tenant_id)
  setSessionCookie(c, c.env, createdSession.token)
  const sessionPayload = buildSessionPayload({
    expiresAt: createdSession.expiresAt,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  })
  await recordSecurityEvent(c.env, {
    tenantId: user.tenant_id,
    userId: user.id,
    sessionId: createdSession.sessionId,
    eventType: 'session.created',
    description: 'Signed in with email OTP.',
    request: c.req.raw,
    metadata: { provider: 'email_otp' },
  })

  return c.json(jsonAuthPayload(sessionPayload))
})

authRoute.post('/magic-link/request', zValidator('json', magicLinkRequestSchema), async (c) => {
  const payload = c.req.valid('json')
  const credential = await findCredentialByEmail(c.env, payload.email)

  if (!credential) {
    return c.json({
      data: {
        accepted: true,
        message: 'If that email exists, a magic link is on the way.',
      },
      error: null,
    })
  }

  if (!c.env.RESEND_API_KEY || !c.env.AUTH_EMAIL_FROM) {
    return c.json({ data: null, error: { message: 'Magic link email is not configured yet.' } }, 503)
  }

  const callbackURL = sanitizeCallbackUrl(
    c.req.url,
    c.env.PUBLIC_APP_URL,
    payload.callbackURL,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host')
  )
  const token = await signOAuthState(c.env, {
    purpose: 'magic_link',
    email: payload.email.trim().toLowerCase(),
    callbackURL,
    createdAt: Date.now(),
  })
  const appOrigin = resolveAppOrigin(
    c.req.url,
    c.env.PUBLIC_APP_URL,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host')
  )
  const link = new URL('/api/auth/magic-link/verify', appOrigin)
  link.searchParams.set('token', token)

  const emailResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: c.env.AUTH_EMAIL_FROM,
      to: [payload.email.trim().toLowerCase()],
      subject: 'Your TaskCenter magic link',
      text: `Open this TaskCenter magic link to sign in:\n\n${link.toString()}\n\nThis link expires in 15 minutes.`,
      html: `<!doctype html><html><body style="margin:0;background:#020617;font-family:Inter,Arial,sans-serif;color:#e2e8f0;"><div style="max-width:640px;margin:0 auto;padding:32px 20px;"><div style="border:1px solid rgba(148,163,184,0.16);border-radius:28px;background:linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.98));padding:32px;"><div style="font-size:11px;letter-spacing:0.24em;text-transform:uppercase;color:#94a3b8;">TaskCenter</div><h1 style="margin:12px 0 0;font-size:30px;line-height:1.15;color:#f8fafc;">Open your magic link</h1><p style="margin:16px 0 0;font-size:15px;line-height:1.7;color:#cbd5e1;">Use this link to sign in to TaskCenter. It expires in 15 minutes.</p><div style="margin-top:24px;"><a href="${link.toString()}" style="display:inline-block;padding:14px 22px;border-radius:999px;background:#10b981;color:#04130d;text-decoration:none;font-weight:700;">Sign in to TaskCenter</a></div><p style="margin:28px 0 0;font-size:12px;line-height:1.7;color:#94a3b8;">If you did not request this link, you can safely ignore this email.</p></div></div></body></html>`,
    }),
  })

  if (!emailResponse.ok) {
    const message = await emailResponse.text().catch(() => '')
    return c.json({ data: null, error: { message: message || 'Unable to send magic link email.' } }, 502)
  }

  return c.json({
    data: {
      accepted: true,
      message: 'A magic link has been sent to your email.',
    },
    error: null,
  })
})

authRoute.post('/social', zValidator('json', socialSchema), async (c) => {
  const payload = c.req.valid('json')
  const callbackURL = sanitizeCallbackUrl(
    c.req.url,
    c.env.PUBLIC_APP_URL,
    payload.callbackURL,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host')
  )
  const state = await signOAuthState(c.env, {
    provider: payload.provider,
    callbackURL,
    createdAt: Date.now(),
  })

  const authUrl = new URL(
    payload.provider === 'google'
      ? 'https://accounts.google.com/o/oauth2/v2/auth'
      : 'https://github.com/login/oauth/authorize'
  )

  if (payload.provider === 'google') {
    if (!c.env.GOOGLE_CLIENT_ID) {
      return c.json({ data: null, error: { message: 'Google auth is not configured.' } }, 400)
    }
    const redirectUri = getGoogleRedirectUri(
      c.req.url,
      c.env.PUBLIC_APP_URL,
      c.req.header('x-forwarded-proto'),
      c.req.header('x-forwarded-host')
    )
    authUrl.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', 'openid email profile')
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('prompt', 'select_account')
  } else {
    if (!c.env.GITHUB_CLIENT_ID) {
      return c.json({ data: null, error: { message: 'GitHub auth is not configured.' } }, 400)
    }
    const redirectUri = getGitHubRedirectUri(
      c.req.url,
      c.env.PUBLIC_APP_URL,
      c.req.header('x-forwarded-proto'),
      c.req.header('x-forwarded-host')
    )
    authUrl.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('scope', 'read:user user:email')
    authUrl.searchParams.set('state', state)
  }

  return c.json({ data: { url: authUrl.toString() }, error: null })
})

authRoute.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const appOrigin = resolveAppOrigin(
    c.req.url,
    c.env.PUBLIC_APP_URL,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host')
  )
  if (!code || !state || !c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.redirect(`${appOrigin}/auth?error=google_auth_failed`)
  }

  const verifiedState = await verifyOAuthState<{ provider?: 'google' | 'github'; callbackURL?: string; createdAt?: number }>(c.env, state)
  if (!verifiedState || !verifiedState.createdAt || Date.now() - verifiedState.createdAt > 1000 * 60 * 15) {
    return c.redirect(`${appOrigin}/auth?error=google_auth_state_invalid`)
  }

  const redirectUri = getGoogleRedirectUri(
    c.req.url,
    c.env.PUBLIC_APP_URL,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host')
  )
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })

  if (!tokenRes.ok) {
    return c.redirect(`${appOrigin}/auth?error=google_token_exchange_failed`)
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string; id_token?: string }
  const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token || tokenJson.id_token || ''}`,
    },
  })

  if (!profileRes.ok) {
    return c.redirect(`${appOrigin}/auth?error=google_profile_failed`)
  }

  const profile = (await profileRes.json()) as { sub?: string; email?: string; name?: string }
  if (!profile.sub || !profile.email) {
    return c.redirect(`${appOrigin}/auth?error=google_profile_invalid`)
  }

  const user = await findOrCreateGoogleUser(c.env, {
    email: profile.email,
    name: profile.name,
    googleUserId: profile.sub,
  })
  const createdSession = await createSession(c.env, user.userId, user.tenantId)
  setSessionCookie(c, c.env, createdSession.token)
  await recordSecurityEvent(c.env, {
    tenantId: user.tenantId,
    userId: user.userId,
    sessionId: createdSession.sessionId,
    eventType: 'session.created',
    description: 'Signed in with Google.',
    request: c.req.raw,
    metadata: {
      provider: 'google',
    },
  })

  return c.redirect(
    sanitizeCallbackUrl(
      c.req.url,
      c.env.PUBLIC_APP_URL,
      verifiedState.callbackURL,
      c.req.header('x-forwarded-proto'),
      c.req.header('x-forwarded-host')
    )
  )
})

authRoute.get('/github/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const appOrigin = resolveAppOrigin(
    c.req.url,
    c.env.PUBLIC_APP_URL,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host')
  )
  if (!code || !state || !c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.redirect(`${appOrigin}/auth?error=github_auth_failed`)
  }

  const verifiedState = await verifyOAuthState<{ provider?: 'google' | 'github'; callbackURL?: string; createdAt?: number }>(c.env, state)
  if (!verifiedState || verifiedState.provider !== 'github' || !verifiedState.createdAt || Date.now() - verifiedState.createdAt > 1000 * 60 * 15) {
    return c.redirect(`${appOrigin}/auth?error=github_auth_state_invalid`)
  }

  const redirectUri = getGitHubRedirectUri(
    c.req.url,
    c.env.PUBLIC_APP_URL,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host')
  )
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  })
  if (!tokenRes.ok) {
    return c.redirect(`${appOrigin}/auth?error=github_token_exchange_failed`)
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string }
  if (!tokenJson.access_token) {
    return c.redirect(`${appOrigin}/auth?error=github_token_missing`)
  }

  const headers = {
    Authorization: `Bearer ${tokenJson.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'TaskCenter',
  }
  const profileRes = await fetch('https://api.github.com/user', { headers })
  if (!profileRes.ok) {
    return c.redirect(`${appOrigin}/auth?error=github_profile_failed`)
  }

  const profile = (await profileRes.json()) as { id?: number; email?: string | null; name?: string | null; login?: string | null }
  let email = profile.email?.trim().toLowerCase() || null
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers })
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email?: string; primary?: boolean; verified?: boolean }>
      email =
        emails.find((entry) => entry.primary && entry.verified)?.email?.trim().toLowerCase() ||
        emails.find((entry) => entry.verified)?.email?.trim().toLowerCase() ||
        null
    }
  }

  if (!profile.id || !email) {
    return c.redirect(`${appOrigin}/auth?error=github_profile_invalid`)
  }

  const user = await findOrCreateGitHubUser(c.env, {
    email,
    name: profile.name || profile.login || undefined,
    githubUserId: String(profile.id),
  })
  const createdSession = await createSession(c.env, user.userId, user.tenantId)
  setSessionCookie(c, c.env, createdSession.token)
  await recordSecurityEvent(c.env, {
    tenantId: user.tenantId,
    userId: user.userId,
    sessionId: createdSession.sessionId,
    eventType: 'session.created',
    description: 'Signed in with GitHub.',
    request: c.req.raw,
    metadata: {
      provider: 'github',
      login: profile.login || null,
    },
  })

  return c.redirect(
    sanitizeCallbackUrl(
      c.req.url,
      c.env.PUBLIC_APP_URL,
      verifiedState.callbackURL,
      c.req.header('x-forwarded-proto'),
      c.req.header('x-forwarded-host')
    )
  )
})

authRoute.get('/magic-link/verify', async (c) => {
  const token = c.req.query('token')
  const appOrigin = resolveAppOrigin(
    c.req.url,
    c.env.PUBLIC_APP_URL,
    c.req.header('x-forwarded-proto'),
    c.req.header('x-forwarded-host')
  )
  if (!token) {
    return c.redirect(`${appOrigin}/auth?error=magic_link_missing`)
  }

  const verified = await verifyOAuthState<{ purpose?: string; email?: string; callbackURL?: string; createdAt?: number }>(c.env, token)
  if (!verified || verified.purpose !== 'magic_link' || !verified.email || !verified.createdAt || Date.now() - verified.createdAt > 1000 * 60 * 15) {
    return c.redirect(`${appOrigin}/auth?error=magic_link_invalid`)
  }

  const credential = await findCredentialByEmail(c.env, verified.email)
  if (!credential) {
    return c.redirect(`${appOrigin}/auth?error=magic_link_account_missing`)
  }

  const user = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.tenant_id, COALESCE(m.role, 'member') AS role
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = u.tenant_id
     WHERE u.id = ?
     LIMIT 1`
  )
    .bind(credential.user_id)
    .first<{ id: string; email: string | null; name: string | null; tenant_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' } | null>()
  if (!user) {
    return c.redirect(`${appOrigin}/auth?error=magic_link_account_missing`)
  }

  const createdSession = await createSession(c.env, user.id, user.tenant_id)
  setSessionCookie(c, c.env, createdSession.token)
  await recordSecurityEvent(c.env, {
    tenantId: user.tenant_id,
    userId: user.id,
    sessionId: createdSession.sessionId,
    eventType: 'session.created',
    description: 'Signed in with magic link.',
    request: c.req.raw,
    metadata: { provider: 'magic_link' },
  })

  return c.redirect(
    sanitizeCallbackUrl(
      c.req.url,
      c.env.PUBLIC_APP_URL,
      verified.callbackURL,
      c.req.header('x-forwarded-proto'),
      c.req.header('x-forwarded-host')
    )
  )
})

authRoute.post('/request-password-reset', async (c) => {
  const body = await c.req.json().catch(() => null) as { email?: string } | null
  const email = body?.email?.trim().toLowerCase()
  if (email) {
    const credential = await findCredentialByEmail(c.env, email)
    if (credential) {
      const user = await c.env.DB.prepare(`SELECT tenant_id FROM users WHERE id = ? LIMIT 1`)
        .bind(credential.user_id)
        .first<{ tenant_id: string } | null>()

      if (user?.tenant_id) {
        await recordSecurityEvent(c.env, {
          tenantId: user.tenant_id,
          userId: credential.user_id,
          eventType: 'password_reset.requested',
          description: 'Password reset requested.',
          request: c.req.raw,
        })
      }
    }
  }

  return c.json({
    data: {
      accepted: true,
      message: 'Password reset requests are accepted, but delivery still needs to be wired to an email provider.',
    },
    error: null,
  })
})
