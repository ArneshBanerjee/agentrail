import { createHmac, timingSafeEqual } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { isAgentTraffic, parseCloudflareLog, parseVercelLog, type IncomingEvent } from '@openscope/core'
import type { Context, Hono } from 'hono'
import type { AppContext } from './app.ts'
import { ingestEvents } from './ingest.ts'

const MAX_BATCH = 500

/** Drain bodies arrive as JSON arrays, NDJSON, or either one gzipped. */
const readRecords = async (c: Context): Promise<unknown[]> => {
  let bytes = Buffer.from(await c.req.arrayBuffer())
  if (c.req.header('content-encoding') === 'gzip' || (bytes[0] === 0x1f && bytes[1] === 0x8b)) bytes = gunzipSync(bytes)
  const text = bytes.toString('utf8').trim()
  if (!text) return []
  if (text.startsWith('[')) return JSON.parse(text) as unknown[]
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown)
}

const store = async (ctx: AppContext, key: string, events: (IncomingEvent | undefined)[]) => {
  const site = ctx.store.siteByKey(key)
  if (!site) return { status: 401 as const, body: { error: 'unknown ingest key' } }
  const kept = events.filter((e): e is IncomingEvent => !!e && isAgentTraffic(e))
  let stored = 0
  for (let i = 0; i < kept.length; i += MAX_BATCH) {
    const r = await ingestEvents(ctx.ingestDeps, site, kept.slice(i, i + MAX_BATCH))
    if (r.ok) stored += r.stored
  }
  return { status: 202 as const, body: { received: events.length, agents: kept.length, stored } }
}

/** Stripe's signature: HMAC-SHA256 over `${t}.${body}`, in the `v1` part of the header. */
export const verifyStripe = (body: string, header: string | undefined, secret: string, now: number, toleranceSec = 300): boolean => {
  if (!header) return false
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]))
  const t = Number(parts.t)
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest()
  return header
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .some((p) => {
      const given = Buffer.from(p.slice(3), 'hex')
      return given.length === expected.length && timingSafeEqual(given, expected)
    })
}

type StripeCharge = {
  amount?: number
  currency?: string
  customer?: string | null
  failure_code?: string | null
  failure_message?: string | null
  metadata?: Record<string, string>
}

export const registerDrains = (app: Hono, ctx: AppContext) => {
  // Vercel checks a new drain by asking for this header back.
  app.get('/v1/drains/vercel/:key', (c) => c.body(null, 200, process.env.OPENSCOPE_VERCEL_VERIFY ? { 'x-vercel-verify': process.env.OPENSCOPE_VERCEL_VERIFY } : {}))

  app.post('/v1/drains/vercel/:key', async (c) => {
    let records: unknown[]
    try {
      records = await readRecords(c)
    } catch {
      return c.json({ error: 'body is not JSON or NDJSON' }, 400)
    }
    const r = await store(ctx, c.req.param('key'), records.map((x) => parseVercelLog(x as Parameters<typeof parseVercelLog>[0])))
    return c.json(r.body, r.status)
  })

  app.post('/v1/drains/cloudflare/:key', async (c) => {
    let records: unknown[]
    try {
      records = await readRecords(c)
    } catch {
      return c.json({ error: 'body is not JSON or NDJSON' }, 400)
    }
    // Logpush sends a test object with a `content` field when a job is created.
    const real = records.filter((x) => typeof x === 'object' && x !== null && !('content' in x && Object.keys(x).length === 1))
    const r = await store(ctx, c.req.param('key'), real.map((x) => parseCloudflareLog(x as Parameters<typeof parseCloudflareLog>[0])))
    return c.json(r.body, r.status)
  })

  /**
   * Payments from Stripe. A charge is the unit, because a subscription renewal also produces a
   * charge, and counting invoices too would count it twice. The account is the customer's
   * `metadata.openscope_account`, which should be the id passed to `identify()`, or the customer id.
   */
  app.post('/v1/stripe/:key', async (c) => {
    const site = ctx.store.siteByKey(c.req.param('key'))
    if (!site) return c.json({ error: 'unknown ingest key' }, 401)
    const secret = ctx.store.settings(site.workspaceId).stripe.webhookSecret
    if (!secret) return c.json({ error: 'Set the Stripe webhook secret in Settings first.' }, 400)
    const body = await c.req.text()
    if (!verifyStripe(body, c.req.header('stripe-signature'), secret, ctx.now())) return c.json({ error: 'signature does not match' }, 400)
    const event = JSON.parse(body) as { id: string; type: string; created: number; data: { object: StripeCharge } }
    if (event.type !== 'charge.succeeded' && event.type !== 'charge.failed') return c.json({ ignored: event.type })
    const charge = event.data.object
    const account = charge.metadata?.openscope_account ?? charge.customer ?? undefined
    if (!account) return c.json({ ignored: 'charge has no customer' })
    const ok = event.type === 'charge.succeeded'
    const failure = [charge.failure_code, charge.failure_message].filter(Boolean).join(': ')
    const r = await ingestEvents(ctx.ingestDeps, site, [
      {
        id: `stripe-${event.id}`,
        ts: event.created * 1000,
        source: 'stripe',
        kind: 'payment',
        ok,
        accountId: account,
        ...(ok && charge.amount !== undefined ? { amount: charge.amount } : {}),
        ...(charge.currency ? { currency: charge.currency } : {}),
        ...(!ok && failure ? { error: failure } : {}),
      },
    ])
    return c.json(r.ok ? { stored: r.stored } : { error: r.error }, r.ok ? 200 : 400)
  })
}
