import { expect, test } from 'vitest'
import type { StoredEvent } from '../src/events.ts'
import { closestPath, rankFixes } from '../src/fixes.ts'
import { groupIntents, keywords } from '../src/intents.ts'
import { buildSessions, type Session } from '../src/journey.ts'
import { breakdown, byAgent, overview } from '../src/metrics.ts'

const T = 1_760_000_000_000
let seq = 0
const ev = (e: Partial<StoredEvent> & Pick<StoredEvent, 'kind' | 'ts'>): StoredEvent => ({ id: `a${++seq}`, siteId: 'site', source: 'http', ...e })

/** One session per call, each on its own address. */
const session = (o: { ua?: string; intent?: string; pay?: number; fail?: boolean; at?: number }): StoredEvent[] => {
  const ip = `ip-${++seq}`
  const at = T + (o.at ?? 0)
  const ua = o.ua ?? 'codex_cli_rs/0.46.0'
  const out = [
    ev({ kind: 'request', ts: at, path: '/docs/api-keys', status: 200, userAgent: ua, ipHash: ip }),
    ev({ kind: 'step', ts: at + 1000, step: 'signed_in', ipHash: ip, userAgent: ua }),
  ]
  if (o.intent) out.push(ev({ kind: 'intent', ts: at + 500, text: o.intent, ipHash: ip, userAgent: ua }))
  if (o.fail) out.push(ev({ kind: 'request', ts: at + 2000, method: 'POST', host: 'api.x.test', path: '/v1/meters', status: 401, ipHash: ip, userAgent: ua }))
  if (o.pay) out.push(ev({ kind: 'payment', ts: at + 3000, amount: o.pay, ipHash: ip, userAgent: ua }))
  return out
}

const build = (...groups: StoredEvent[][]): Session[] => buildSessions(groups.flat())

test('keywords drop stopwords, numbers and redaction tokens, and stem plurals', () => {
  expect(keywords('Refund the last 2 charges for [EMAIL_1]')).toEqual(['refund', 'last', 'charge'])
})

test('intents group by workspace definitions first, then by shared words', () => {
  const sessions = build(
    session({ intent: 'Bill API calls with usage-based billing', pay: 100 }),
    session({ intent: 'Set up a subscription for usage billing' }),
    session({ intent: 'Refund the last charge for a customer' }),
    session({ intent: 'Refund an order and email them', pay: 50 }),
    session({ intent: 'Translate my website' }),
    session({}),
  )
  const groups = groupIntents(sessions, { definitions: [{ id: 'subs', label: 'Subscriptions', keywords: ['subscription', 'usage'] }] })
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]))
  expect(byId.subs).toMatchObject({ sessions: 2, converted: 1, conversion: 0.5, revenue: 100 })
  expect(byId['kw:refund']).toMatchObject({ label: 'Refund', sessions: 2, converted: 1 })
  expect(byId.other).toMatchObject({ sessions: 1 })
  expect(groups.reduce((n, g) => n + g.sessions, 0)).toBe(5)
})

test('overview counts live sessions and compares with the previous window', () => {
  const current = build(session({ pay: 100, at: 0 }), session({ at: 0 }), session({ at: 0 }), session({ pay: 10, at: 0 }))
  const previous = build(session({ at: 0 }), session({ pay: 1, at: 0 }))
  const o = overview(current, previous, T + 4 * 60_000)
  expect(o).toMatchObject({ sessions: 4, live: 4, converted: 2, conversion: 0.5, revenue: 110, sessionsChange: 1, conversionChange: 0 })
  expect(overview(current, undefined, T + 3_600_000).live).toBe(0)
})

test('breakdown by agent sums revenue and conversion', () => {
  const sessions = build(session({ pay: 100 }), session({ ua: 'Cursor/1.7', pay: 30 }), session({ ua: 'Cursor/1.7' }))
  const rows = breakdown(sessions, byAgent)
  expect(rows.map((r) => [r.label, r.sessions, r.converted, r.revenue])).toEqual([
    ['Codex', 1, 1, 100],
    ['Cursor', 2, 1, 30],
  ])
})

test('fixes are ranked by the revenue they put at risk, with the observed count beside it', () => {
  const sessions = build(
    session({ fail: true }),
    session({ fail: true }),
    session({ fail: true }),
    session({ pay: 6000 }),
    session({ pay: 6000 }),
  )
  const [top] = rankFixes(sessions, { windowMs: 30 * 86_400_000 })
  expect(top).toMatchObject({
    kind: 'failed_call',
    title: 'Agents fail auth on /v1/meters',
    sessionsLost: 3,
    // They stopped before the first payment, and every session that got past it paid.
    beforeStep: 'first_payment',
    conversionPast: 1,
    revenuePerConversion: 6000,
    monthlyValueAtRisk: 18000,
  })
  expect(top!.proposal.needsDraft).toBe(true)
})

test('a missing page is matched to the page agents most likely wanted', () => {
  const known = ['/docs/billing/usage', '/docs/api-keys', '/docs/checkout']
  expect(closestPath('/docs/usage-billing', known)).toBe('/docs/billing/usage')
  expect(closestPath('/careers', known)).toBeUndefined()
})

test('a keyword group is named by the word as agents wrote it, the earliest shared one', () => {
  const sessions = build(
    session({ intent: 'set up usage-based billing: create a meter and check usage' }),
    session({ intent: 'set up usage-based billing with meter events for our API' }),
  )
  const [group] = groupIntents(sessions)
  expect(group).toMatchObject({ id: 'kw:usage', label: 'Usage', sessions: 2 })
})
