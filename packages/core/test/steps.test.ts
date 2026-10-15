import { expect, test } from 'vitest'
import { attribute } from '../src/attribution.ts'
import type { StoredEvent } from '../src/events.ts'
import { rankFixes } from '../src/fixes.ts'
import { buildSessions } from '../src/journey.ts'
import { stepName, versionIn } from '../src/steps.ts'
import { timeline } from '../src/timeline.ts'
import { DEFAULT_FUNNEL } from '../src/funnel.ts'

let n = 0
const T = 1_760_000_000_000
const req = (method: string, path: string, status = 200, extra: Partial<StoredEvent> = {}): StoredEvent => ({
  id: `s${++n}`, siteId: 'site', source: 'http', kind: 'request', ts: T + n * 1000, method, path, status, ipHash: 'ip-1', userAgent: 'Claude-User (claude-code/2.1.288; +https://support.anthropic.com/)', ...extra,
})

test('requests get plain names from rules and from their shape', () => {
  expect(stepName(req('POST', '/api/docs/find'))).toBe('intent declared')
  expect(stepName(req('GET', '/docs/billing/usage-based'))).toBe('read')
  expect(stepName(req('GET', '/dl/v/tripe-cli.tgz'))).toBe('download')
  expect(stepName(req('POST', '/api/cli/init'))).toBe('init')
  expect(stepName(req('POST', '/api/device/start'))).toBe('sign-in started')
  expect(stepName(req('POST', '/api/device/poll', 428))).toBe('poll')
  expect(stepName(req('POST', '/v1/subscriptions'))).toBe('subscription created')
  expect(stepName(req('POST', '/v1/billing/meter_events'))).toBe('meter event')
  expect(stepName(req('GET', '/v1/billing/meters/mtr_8Yx2/event_summaries'))).toBe('event summary read')
  expect(stepName(req('POST', '/v1/webhook_endpoints', 400))).toBe('webhook refused')
  expect(stepName(req('POST', '/v1/meters', 401))).toBe('unauthorized')
  expect(stepName(req('GET', '/docs/nope', 404))).toBe('not found')
  expect(stepName(req('POST', '/v1/charges', 200), [{ path: '/v1/charges', name: 'charged' }])).toBe('charged')
})

test('the agent version comes from its user agent', () => {
  expect(versionIn('Claude-User (claude-code/2.1.288; +https://x)', 'claude-code')).toBe('2.1.288')
  expect(attribute({ userAgent: 'Claude-User (claude-code/2.1.288; +https://x)' })).toMatchObject({ name: 'Claude Code', version: '2.1.288' })
  expect(attribute({ mcpClient: 'cursor', mcpClientVersion: '1.7.0' })).toMatchObject({ version: '1.7.0' })
})

/** The session the demo video shows, made of nothing but HTTP. */
const demoSession = (): StoredEvent[] => {
  n = 0
  return [
    req('POST', '/api/docs/find', 200, { kind: 'intent', source: 'intake', text: 'set up usage-based billing with meter events for our API' }),
    req('GET', '/docs/billing/usage-based'),
    req('GET', '/docs/billing/meters'),
    req('GET', '/docs/sdk/quickstart'),
    req('GET', '/dl/v/tripe-cli.tgz'),
    req('POST', '/api/cli/init'),
    req('POST', '/api/device/start'),
    req('POST', '/api/device/poll', 428),
    req('POST', '/api/device/poll', 428),
    req('POST', '/api/device/poll', 200),
    req('POST', '/v1/subscriptions'),
    req('POST', '/v1/billing/meter_events'),
    req('GET', '/v1/billing/meters/mtr_8Yx2/event_summaries'),
  ]
}

test('a journey made only of HTTP reaches Installed, Signed in and First API call', () => {
  const [s] = buildSessions(demoSession())
  expect(s!.agent).toMatchObject({ name: 'Claude Code', version: '2.1.288' })
  expect(s!.discovery.via).toBe('docs finder')
  expect(Object.keys(s!.reached)).toEqual(['discovered', 'installed', 'signed_in', 'first_api_call'])
  expect(s!.stoppedAt).toBe('first_payment')
})

test('the timeline groups by phase, counts polls and says how the session ended', () => {
  const [s] = buildSessions(demoSession())
  const items = timeline(s!, DEFAULT_FUNNEL, { live: false })
  expect(items.map((i) => [i.phase, i.name])).toEqual([
    ['Discovery', 'intent declared'],
    ['Discovery', 'read'],
    ['Discovery', 'read'],
    ['Discovery', 'read'],
    ['Discovery', 'download'],
    ['Sign-in', 'init'],
    ['Sign-in', 'sign-in started'],
    ['Sign-in', 'poll 1 / 3'],
    ['Sign-in', 'poll 2 / 3'],
    ['Sign-in', 'poll 3 / 3'],
    ['First API call', 'subscription created'],
    ['First payment', 'meter event'],
    ['First payment', 'event summary read'],
    ['First payment', 'session ended'],
  ])
  expect(items[9]!.detail).toBe('POST /api/device/poll 200')
  expect(items.at(-1)!.detail).toBe('Stopped before first payment')
  expect(timeline(s!, DEFAULT_FUNNEL, { live: true }).at(-1)!.name).toBe('event summary read')
})

test('MCP connected is its own column and never where a journey stopped', () => {
  n = 100
  const [s] = buildSessions([req('GET', '/docs'), { ...req('GET', '/x'), kind: 'mcp_connect', mcpClient: 'claude-code' }])
  expect(s!.reached.mcp_connected).toBeDefined()
  expect(s!.reached.installed).toBeUndefined()
  expect(s!.stoppedAt).toBe('installed')
})

test('a fix says what to do and what share of the drop it explains', () => {
  const sessions = buildSessions(
    [0, 1, 2, 3].flatMap((i) => [
      req('GET', '/docs/api-keys', 200, { ipHash: `ip-${i}` }),
      req('POST', '/api/device/poll', 200, { ipHash: `ip-${i}` }),
      req('POST', '/v1/meters', i < 3 ? 401 : 500, { ipHash: `ip-${i}`, error: i < 3 ? 'X-Api-Key rejected' : 'boom' }),
    ]),
  )
  const [auth] = rankFixes(sessions, { windowMs: 30 * 86_400_000 })
  expect(auth).toMatchObject({ action: 'Fix the authentication sample in the API keys guide', sessionsLost: 3, beforeStep: 'first_api_call', dropShare: 0.75 })
})

test('a pending sign-in poll is waiting, not failing, and downloads are not pages', () => {
  n = 300
  const [s] = buildSessions([
    req('GET', '/docs/api-keys'),
    req('GET', '/dl/v/cli.tgz'),
    req('POST', '/api/device/start'),
    req('POST', '/api/device/poll', 428),
    req('POST', '/api/device/poll', 400),
  ])
  expect(s!.blockers.map((b) => b.kind)).toEqual(['human_signin'])
  expect(s!.blockers[0]!.after).toBe('/docs/api-keys')
})

test('with no stated task, the task is inferred from the specific docs read, and kept apart', () => {
  n = 400
  const [s] = buildSessions([req('GET', '/llms.txt'), req('GET', '/docs/quickstart'), req('GET', '/docs/billing/usage-based'), req('GET', '/docs/api-keys')])
  expect(s!.intent).toBeUndefined()
  expect(s!.inferredIntent).toBe('Billing › Usage based')
  expect(attribute({ userAgent: 'codex/0.46.0' })).toMatchObject({ agentId: 'codex', version: '0.46.0' })
})
