import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { EnvBindings } from '../lib/context'
import { resolveSessionContext } from '../lib/server-auth'
import { newId } from '../lib/ids'
import { CREDIT_PACKAGES, getCreditPackage, getUsageSnapshot, grantUsageCredits } from '../lib/usage'
import { getWorkspaceCapabilities } from '../lib/capabilities'
import { recordRuntimeEvent } from '../lib/runtime-events'

const checkoutSchema = z.object({
  plan: z.enum(['pro', 'team']),
  billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
  email: z.string().email().optional(),
})

const topupCheckoutSchema = z.object({
  packageId: z.string().min(1),
})

type StripeCheckoutResponse = {
  id: string
  url?: string | null
  customer?: string | null
  subscription?: string | null
  error?: {
    message?: string
  }
}

type StripeWebhookEvent = {
  id: string
  type: string
  data?: {
    object?: Record<string, unknown>
  }
}

export const billingRoute = new Hono<{ Bindings: EnvBindings }>()

function resolveOrigin(requestUrl: string, publicAppUrl?: string) {
  return publicAppUrl || new URL(requestUrl).origin
}

function resolvePriceId(env: EnvBindings, plan: 'pro' | 'team', billingCycle: 'monthly' | 'yearly') {
  if (plan === 'pro') {
    return billingCycle === 'yearly' ? env.STRIPE_PRICE_PRO_YEARLY : env.STRIPE_PRICE_PRO_MONTHLY
  }

  return billingCycle === 'yearly' ? env.STRIPE_PRICE_TEAM_YEARLY : env.STRIPE_PRICE_TEAM_MONTHLY
}

async function getOptionalSession(env: EnvBindings, request: Request) {
  const cookieToken = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('taskcenter_session='))
    ?.split('=')
    .slice(1)
    .join('=')

  if (!cookieToken) return null
  return resolveSessionContext(env, cookieToken)
}

async function syncBillingState(
  env: EnvBindings,
  input: {
    tenantId: string
    stripeCustomerId?: string | null
    stripeSubscriptionId: string
    stripeCheckoutSessionId?: string | null
    planKey: string
    status: string
    currentPeriodEnd?: number | null
    cancelAtPeriodEnd?: boolean
    email?: string | null
  }
) {
  const now = Date.now()
  if (input.stripeCustomerId) {
    await env.DB.prepare(
      `INSERT INTO billing_customers (id, tenant_id, stripe_customer_id, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE
       SET stripe_customer_id = excluded.stripe_customer_id,
           email = COALESCE(excluded.email, billing_customers.email),
           updated_at = excluded.updated_at`
    )
      .bind(newId('bcus'), input.tenantId, input.stripeCustomerId, input.email ?? null, now, now)
      .run()
  }

  await env.DB.prepare(
    `INSERT INTO billing_subscriptions (
      id, tenant_id, stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id,
      plan_key, status, current_period_end, cancel_at_period_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stripe_subscription_id) DO UPDATE
    SET tenant_id = excluded.tenant_id,
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_checkout_session_id = COALESCE(excluded.stripe_checkout_session_id, billing_subscriptions.stripe_checkout_session_id),
        plan_key = excluded.plan_key,
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        updated_at = excluded.updated_at`
  )
    .bind(
      newId('bsub'),
      input.tenantId,
      input.stripeCustomerId ?? null,
      input.stripeSubscriptionId,
      input.stripeCheckoutSessionId ?? null,
      input.planKey,
      input.status,
      input.currentPeriodEnd ?? null,
      input.cancelAtPeriodEnd ? 1 : 0,
      now,
      now
    )
    .run()
}

async function resolveTenantIdFromStripeCustomer(env: EnvBindings, stripeCustomerId: string | null | undefined) {
  if (!stripeCustomerId) return null
  const customer = await env.DB.prepare(
    `SELECT tenant_id
     FROM billing_customers
     WHERE stripe_customer_id = ?
     LIMIT 1`
  )
    .bind(stripeCustomerId)
    .first<{ tenant_id: string } | null>()

  return customer?.tenant_id || null
}

async function resolveExistingSubscription(env: EnvBindings, stripeSubscriptionId: string | null | undefined) {
  if (!stripeSubscriptionId) return null
  return env.DB.prepare(
    `SELECT tenant_id, plan_key, stripe_customer_id
     FROM billing_subscriptions
     WHERE stripe_subscription_id = ?
     LIMIT 1`
  )
    .bind(stripeSubscriptionId)
    .first<{ tenant_id: string; plan_key: string; stripe_customer_id: string | null } | null>()
}

async function verifyStripeSignature(secret: string, payload: string, header: string | null) {
  if (!header) return false
  const parts = header.split(',').map((part) => part.trim())
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2)
  const signature = parts.find((part) => part.startsWith('v1='))?.slice(3)
  if (!timestamp || !signature) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`))
  const hex = [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return hex === signature
}

billingRoute.get('/state', async (c) => {
  const session = await getOptionalSession(c.env, c.req.raw)
  const tenantId = session?.tenantId
  const capabilities = await getWorkspaceCapabilities(c.env, { tenantId: tenantId || null })

  if (!tenantId) {
    return c.json({
      planKey: 'starter',
      status: 'inactive',
      subscription: null,
      usage: null,
      creditPackages: CREDIT_PACKAGES,
      capabilities,
    })
  }

  const subscription = await c.env.DB.prepare(
    `SELECT plan_key, status, current_period_end, cancel_at_period_end, stripe_subscription_id
     FROM billing_subscriptions
     WHERE tenant_id = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`
  )
    .bind(tenantId)
    .first<{
      plan_key: string
      status: string
      current_period_end: number | null
      cancel_at_period_end: number
      stripe_subscription_id: string
    } | null>()

  const usage = session?.userId ? await getUsageSnapshot(c.env, tenantId, session.userId) : null

  return c.json({
    planKey: subscription?.plan_key || 'starter',
    status: subscription?.status || 'inactive',
    subscription: subscription
      ? {
          stripeSubscriptionId: subscription.stripe_subscription_id,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        }
      : null,
    usage,
    creditPackages: CREDIT_PACKAGES,
    capabilities,
  })
})

billingRoute.post('/checkout', zValidator('json', checkoutSchema), async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(
      {
        error: 'stripe_not_configured',
        message: 'Stripe secret key is missing. Set STRIPE_SECRET_KEY and the price IDs first.',
      },
      501
    )
  }

  const payload = c.req.valid('json')
  const session = await getOptionalSession(c.env, c.req.raw)
  if (!session?.tenantId || !session.userId) {
    return c.json({ error: 'authentication_required', message: 'Sign in before starting a paid workspace checkout.' }, 401)
  }

  const priceId = resolvePriceId(c.env, payload.plan, payload.billingCycle)

  if (!priceId) {
    return c.json(
      {
        error: 'missing_price_id',
        message: `Missing Stripe price ID for ${payload.plan} (${payload.billingCycle}).`,
      },
      400
    )
  }

  const tenantId = session.tenantId
  const userId = session.userId
  const origin = resolveOrigin(c.req.url, c.env.PUBLIC_APP_URL)
  const body = new URLSearchParams()
  body.set('mode', 'subscription')
  body.set('success_url', `${origin}/pricing/success?session_id={CHECKOUT_SESSION_ID}`)
  body.set('cancel_url', `${origin}/pricing?canceled=1`)
  body.set('allow_promotion_codes', 'true')
  body.set('billing_address_collection', 'auto')
  body.set('line_items[0][price]', priceId)
  body.set('line_items[0][quantity]', '1')
  body.set('metadata[plan]', payload.plan)
  body.set('metadata[billingCycle]', payload.billingCycle)
  body.set('metadata[tenantId]', tenantId)
  body.set('metadata[userId]', userId)
  body.set('client_reference_id', tenantId)

  if (payload.email || session?.userEmail) {
    body.set('customer_email', payload.email || session?.userEmail || '')
  }

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  const data = (await response.json().catch(() => null)) as StripeCheckoutResponse | null

  if (!response.ok || !data?.url) {
    await recordRuntimeEvent(c.env, {
      tenantId,
      userId,
      routeKey: 'billing.checkout',
      category: 'stripe_checkout',
      severity: 'error',
      message: data?.error?.message || 'Stripe subscription checkout could not be created.',
      metadata: { plan: payload.plan, billingCycle: payload.billingCycle, status: response.status },
    }).catch(() => {})
    return c.json(
      {
        error: 'stripe_checkout_failed',
        message: data?.error?.message || 'Stripe checkout could not be created.',
      },
      502
    )
  }

  return c.json({ url: data.url, sessionId: data.id })
})

billingRoute.post('/checkout/topup', zValidator('json', topupCheckoutSchema), async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(
      {
        error: 'stripe_not_configured',
        message: 'Stripe secret key is missing. Add STRIPE_SECRET_KEY before taking top-up payments.',
      },
      501
    )
  }

  const payload = c.req.valid('json')
  const session = await getOptionalSession(c.env, c.req.raw)
  if (!session?.tenantId || !session.userId) {
    return c.json({ error: 'authentication_required', message: 'Sign in before buying extra credits.' }, 401)
  }

  const selectedPackage = getCreditPackage(payload.packageId)
  if (!selectedPackage) {
    return c.json({ error: 'invalid_credit_package', message: 'Choose a valid credit package first.' }, 400)
  }

  const origin = resolveOrigin(c.req.url, c.env.PUBLIC_APP_URL)
  const body = new URLSearchParams()
  body.set('mode', 'payment')
  body.set('success_url', `${origin}/app?billing=credits-success`)
  body.set('cancel_url', `${origin}/app?billing=credits-canceled`)
  body.set('allow_promotion_codes', 'true')
  body.set('billing_address_collection', 'auto')
  body.set('line_items[0][price_data][currency]', 'usd')
  body.set('line_items[0][price_data][unit_amount]', String(selectedPackage.amountCents))
  body.set('line_items[0][price_data][product_data][name]', `TaskCenter ${selectedPackage.label}`)
  body.set('line_items[0][price_data][product_data][description]', selectedPackage.description)
  body.set('line_items[0][quantity]', '1')
  body.set('metadata[kind]', 'credit_topup')
  body.set('metadata[packageId]', selectedPackage.id)
  body.set('metadata[tenantId]', session.tenantId)
  body.set('metadata[userId]', session.userId)
  body.set('metadata[requestsGranted]', String(selectedPackage.requestsGranted))
  body.set('metadata[tokensGranted]', String(selectedPackage.tokensGranted))

  if (session.userEmail) {
    body.set('customer_email', session.userEmail)
  }

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  const data = (await response.json().catch(() => null)) as StripeCheckoutResponse | null

  if (!response.ok || !data?.url) {
    await recordRuntimeEvent(c.env, {
      tenantId: session.tenantId,
      userId: session.userId,
      routeKey: 'billing.topup',
      category: 'stripe_checkout',
      severity: 'error',
      message: data?.error?.message || 'Stripe credit top-up checkout could not be created.',
      metadata: { packageId: selectedPackage.id, status: response.status },
    }).catch(() => {})
    return c.json(
      {
        error: 'stripe_checkout_failed',
        message: data?.error?.message || 'Stripe checkout could not be created.',
      },
      502
    )
  }

  return c.json({ url: data.url, sessionId: data.id })
})

billingRoute.post('/webhook', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    await recordRuntimeEvent(c.env, {
      routeKey: 'billing.webhook',
      category: 'stripe_webhook',
      severity: 'error',
      message: 'Stripe webhook secret is missing.',
    }).catch(() => {})
    return c.json({ error: 'stripe_webhook_not_configured' }, 501)
  }

  const payload = await c.req.raw.clone().text()
  const signature = c.req.header('stripe-signature') || null
  const verified = await verifyStripeSignature(c.env.STRIPE_WEBHOOK_SECRET, payload, signature)
  if (!verified) {
    await recordRuntimeEvent(c.env, {
      routeKey: 'billing.webhook',
      category: 'stripe_webhook',
      severity: 'warning',
      message: 'Rejected Stripe webhook because the signature did not verify.',
    }).catch(() => {})
    return c.json({ error: 'invalid_signature' }, 400)
  }

  const event = JSON.parse(payload) as StripeWebhookEvent
  const object = event.data?.object || {}
  const metadata = (object.metadata || {}) as Record<string, unknown>
  const stripeCustomerId = typeof object.customer === 'string' ? object.customer : null
  const stripeSubscriptionId = typeof object.subscription === 'string'
    ? object.subscription
    : typeof object.id === 'string' && event.type.startsWith('customer.subscription')
      ? object.id
      : null
  const existingSubscription = await resolveExistingSubscription(c.env, stripeSubscriptionId)
  const resolvedTenantId =
    String(metadata.tenantId || '') ||
    existingSubscription?.tenant_id ||
    (await resolveTenantIdFromStripeCustomer(c.env, stripeCustomerId)) ||
    null

  if (event.type === 'checkout.session.completed') {
    if (String(metadata.kind || '') === 'credit_topup') {
      const tenantId = String(metadata.tenantId || object.client_reference_id || resolvedTenantId || '')
      const userId = String(metadata.userId || '')
      if (tenantId && userId) {
        await grantUsageCredits(c.env, {
          tenantId,
          userId,
          sourceType: 'stripe_topup',
          sourceRef: typeof object.id === 'string' ? object.id : null,
          requestsGranted: Number(metadata.requestsGranted || 0),
          tokensGranted: Number(metadata.tokensGranted || 0),
          amountCents: typeof object.amount_total === 'number' ? object.amount_total : null,
          currency: typeof object.currency === 'string' ? object.currency : 'usd',
          note: `Stripe top-up${metadata.packageId ? ` · ${String(metadata.packageId)}` : ''}`,
          createdBy: userId,
        })
      } else {
        await recordRuntimeEvent(c.env, {
          tenantId: tenantId || null,
          userId: userId || null,
          routeKey: 'billing.webhook',
          category: 'stripe_credit_topup',
          severity: 'error',
          message: 'Stripe credit top-up webhook could not be reconciled to a tenant and user.',
          metadata: { eventType: event.type, objectId: typeof object.id === 'string' ? object.id : null },
        }).catch(() => {})
      }
    } else {
      const tenantId = String(metadata.tenantId || object.client_reference_id || resolvedTenantId || '')
      if (!tenantId) {
        await recordRuntimeEvent(c.env, {
          routeKey: 'billing.webhook',
          category: 'stripe_subscription',
          severity: 'error',
          message: 'Stripe subscription checkout completed without a tenant mapping.',
          metadata: { eventType: event.type, objectId: typeof object.id === 'string' ? object.id : null },
        }).catch(() => {})
        return c.json({ ok: true, ignored: 'missing_tenant_mapping' })
      }

      await syncBillingState(c.env, {
        tenantId,
        stripeCustomerId,
        stripeSubscriptionId: typeof object.subscription === 'string' ? object.subscription : `sub_pending_${object.id}`,
        stripeCheckoutSessionId: typeof object.id === 'string' ? object.id : null,
        planKey: String(metadata.plan || existingSubscription?.plan_key || 'starter'),
        status: 'active',
        email: typeof object.customer_email === 'string' ? object.customer_email : null,
      })
    }
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
    if (!resolvedTenantId) {
      await recordRuntimeEvent(c.env, {
        routeKey: 'billing.webhook',
        category: 'stripe_subscription',
        severity: 'error',
        message: 'Stripe subscription event arrived without a tenant mapping.',
        metadata: { eventType: event.type, subscriptionId: stripeSubscriptionId, customerId: stripeCustomerId },
      }).catch(() => {})
      return c.json({ ok: true, ignored: 'missing_tenant_mapping' })
    }

    await syncBillingState(c.env, {
      tenantId: resolvedTenantId,
      stripeCustomerId,
      stripeSubscriptionId: String(object.id),
      planKey: String(metadata.plan || existingSubscription?.plan_key || 'starter'),
      status: String(object.status || 'active'),
      currentPeriodEnd: typeof object.current_period_end === 'number' ? object.current_period_end * 1000 : null,
      cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
    })
  }

  if (event.type === 'customer.subscription.deleted') {
    await c.env.DB.prepare(
      `UPDATE billing_subscriptions
       SET status = 'canceled', updated_at = ?
       WHERE stripe_subscription_id = ?`
    )
      .bind(Date.now(), String(object.id))
      .run()
  }

  return c.json({ ok: true })
})
