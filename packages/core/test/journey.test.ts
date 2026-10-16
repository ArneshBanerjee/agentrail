import { expect, test } from 'vitest'
import type { StoredEvent } from '../src/events.ts'
import { computeFunnel } from '../src/funnel.ts'
import { buildSessions, discover } from '../src/journey.ts'

const T = 1_760_000_000_000
const s = (n: number) => T + n * 1000
let seq = 0
const ev = (e: Partial<StoredEvent> & Pick<StoredEvent, 'kind' | 'ts'>): StoredEvent => ({
  id: `e${++seq}`,
  siteId: 'site',
  source: 'http',
  ...e,
})

const CODEX = 'codex_cli_rs/0.46.0 (Mac OS 15.0; arm64)'
const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const codexStuck = (): StoredEvent[] => [
  ev({ kind: 'request', ts: s(0), path: '/llms.txt', status: 200, userAgent: CODEX, ipHash: 'ip-a' }),
  ev({ kind: 'intent', ts: s(1), source: 'intake', text: 'Set up usage-based billing with meter events', ipHash: 'ip-a', userAgent: CODEX }),
  ev({ kind: 'request', ts: s(4), path: '/docs/billing/usage', status: 200, userAgent: CODEX, ipHash: 'ip-a' }),
  ev({ kind: 'step', ts: s(21), source: 'track', step: 'installed', ipHash: 'ip-a', sessionHint: 'cli-1', userAgent: 'node' }),
  ev({ kind: 'step', ts: s(48), source: 'track', step: 'signed_in', sessionHint: 'cli-1', accountId: 'acct-1' }),
  ev({ kind: 'request', ts: s(72), method: 'POST', host: 'api.tripe.test', path: '/v1/meters', status: 401, error: 'X-Api-Key rejected', accountId: 'acct-1' }),
  ev({ kind: 'request', ts: s(75), path: '/docs/api-keys', status: 200, userAgent: CODEX, ipHash: 'ip-a' }),
  ev({ kind: 'request', ts: s(91), method: 'POST', host: 'api.tripe.test', path: '/v1/meters', status: 401, accountId: 'acct-1' }),
]

test('docs, CLI, sign-in and API events join into one journey through shared identities', () => {
  const sessions = buildSessions(codexStuck())
  expect(sessions).toHaveLength(1)
  const [j] = sessions
  expect(j!.agent).toMatchObject({ agentId: 'codex', label: 'declared' })
  expect(j!.discovery.via).toBe('llms.txt')
  expect(j!.intent).toBe('Set up usage-based billing with meter events')
  expect(Object.keys(j!.reached)).toEqual(['discovered', 'installed', 'signed_in'])
  expect(j!.stoppedAt).toBe('first_payment')
  expect(j!.stoppedBy).toMatchObject({ kind: 'failed_call', key: 'failed_call:POST /v1/meters:401' })
  expect(j!.blockers).toHaveLength(2)
})

test('a person in a browser is not a session, and their product steps do not make one', () => {
  const sessions = buildSessions([
    ev({ kind: 'request', ts: s(0), path: '/docs', status: 200, userAgent: CHROME, ipHash: 'ip-h' }),
    ev({ kind: 'step', ts: s(5), step: 'signed_in', ipHash: 'ip-h', userAgent: CHROME }),
  ])
  expect(sessions).toEqual([])
})

test('a payment days later joins the session it came from, and a renewal counts as the second', () => {
  const events = [
    ev({ kind: 'mcp_connect', ts: s(0), source: 'mcp', mcpClient: 'claude-code', sessionHint: 'mcp-1' }),
    ev({ kind: 'identify', ts: s(10), source: 'mcp', sessionHint: 'mcp-1', accountId: 'acct-9' }),
    ev({ kind: 'payment', ts: s(3 * 86400), source: 'stripe', accountId: 'acct-9', amount: 4900, currency: 'usd' }),
    ev({ kind: 'payment', ts: s(33 * 86400), source: 'stripe', accountId: 'acct-9', amount: 4900, currency: 'usd' }),
  ]
  const [j] = buildSessions(events)
  expect(j!.agent.agentId).toBe('claude-code')
  expect(j!.discovery.via).toBe('your MCP server')
  expect(j!.mcpConnected).toBe(true)
  expect(j!.payments).toBe(2)
  expect(j!.revenue).toBe(9800)
  expect(j!.reached.first_payment).toBe(s(3 * 86400))
  expect(j!.reached.second_payment).toBe(s(33 * 86400))
  expect(j!.reached.signed_in).toBe(s(3 * 86400))
})

test('a payment long after the last activity belongs to nobody', () => {
  const events = [
    ev({ kind: 'mcp_connect', ts: s(0), source: 'mcp', mcpClient: 'claude-code', sessionHint: 'mcp-2', accountId: 'acct-8' }),
    ev({ kind: 'payment', ts: s(90 * 86400), source: 'stripe', accountId: 'acct-8', amount: 100 }),
  ]
  expect(buildSessions(events)[0]!.payments).toBe(0)
})

test('a long gap starts a new session', () => {
  const events = [
    ev({ kind: 'request', ts: s(0), path: '/llms.txt', status: 200, userAgent: CODEX, ipHash: 'ip-b' }),
    ev({ kind: 'request', ts: s(3600), path: '/docs', status: 200, userAgent: CODEX, ipHash: 'ip-b' }),
  ]
  expect(buildSessions(events)).toHaveLength(2)
})

test('runner sessions never join real traffic', () => {
  const events = [
    ev({ kind: 'request', ts: s(0), path: '/docs', status: 200, userAgent: CODEX, ipHash: 'ip-c' }),
    ev({ kind: 'request', ts: s(1), path: '/docs', status: 200, userAgent: CODEX, ipHash: 'ip-c', runId: 'run-1' }),
  ]
  const sessions = buildSessions(events)
  expect(sessions).toHaveLength(2)
  expect(sessions.filter((x) => x.runId === 'run-1')).toHaveLength(1)
})

test('blockers: missing docs, markdown served as HTML, MCP errors, declined payment, waiting sign-in', () => {
  const events = [
    ev({ kind: 'request', ts: s(0), path: '/docs/usage-billing', status: 404, userAgent: CODEX, ipHash: 'ip-d' }),
    ev({ kind: 'request', ts: s(1), path: '/docs/quickstart', status: 200, accept: 'text/markdown', contentType: 'text/html; charset=utf-8', userAgent: CODEX, ipHash: 'ip-d' }),
    ev({ kind: 'mcp_tool', ts: s(2), tool: 'create_meter', ok: false, error: 'missing field: event_name', ipHash: 'ip-d', userAgent: CODEX }),
    ev({ kind: 'step', ts: s(3), step: 'signin_started', ipHash: 'ip-d', userAgent: CODEX }),
    ev({ kind: 'payment', ts: s(4), ok: false, error: 'card_declined', ipHash: 'ip-d', userAgent: CODEX }),
  ]
  const kinds = buildSessions(events)[0]!.blockers.map((b) => b.kind)
  expect(kinds).toEqual(['not_found', 'markdown_served_html', 'mcp_tool_error', 'human_signin', 'payment_failed'])
})

test('discovery reads the first event', () => {
  expect(discover(ev({ kind: 'request', ts: 0, path: '/docs', referrer: 'https://www.google.com/' })).via).toBe('a search result')
  expect(discover(ev({ kind: 'request', ts: 0, path: '/docs', referrer: 'https://blog.example.com/stripe-vs-tripe' })).via).toBe('a comparison page')
  expect(discover(ev({ kind: 'request', ts: 0, path: '/sitemap.xml' })).via).toBe('sitemap.xml')
  expect(discover(ev({ kind: 'request', ts: 0, path: '/docs' })).via).toBe('a direct visit')
})

test('the funnel counts each step by agent, with the drop from the step before', () => {
  const stuck = buildSessions(codexStuck())
  const paying = buildSessions([
    ev({ kind: 'mcp_connect', ts: s(0), source: 'mcp', mcpClient: 'cursor', sessionHint: 'm2' }),
    ev({ kind: 'payment', ts: s(5), sessionHint: 'm2', amount: 100 }),
  ])
  const rows = computeFunnel([...stuck, ...paying].map((x) => ({ agentId: x.agent.agentId, reached: x.reached })), [
    { id: 'discovered', label: 'Discovered', match: [{ any: true }] },
    { id: 'signed_in', label: 'Signed in', match: [{ step: 'signed_in' }] },
    { id: 'first_payment', label: 'First payment', match: [{ nthPayment: 1 }] },
  ])
  expect(rows.map((r) => r.sessions)).toEqual([2, 2, 1])
  expect(rows[2]!.dropFromPrevious).toBe(0.5)
  expect(rows[2]!.byAgent).toEqual({ cursor: 1 })
})

test('a payment for an account made in a test run joins that run, not real traffic', () => {
  const events = [
    ev({ kind: 'request', ts: s(0), path: '/docs', status: 200, userAgent: CODEX, runId: 'run-9', accountId: 'acct-run' }),
    ev({ kind: 'identify', ts: s(3), source: 'track', accountId: 'acct-run', ipHash: 'shared-ip' }),
    ev({ kind: 'payment', ts: s(5), source: 'track', accountId: 'acct-run', amount: 2900 }),
    ev({ kind: 'request', ts: s(1), path: '/docs', status: 200, userAgent: CODEX, ipHash: 'shared-ip' }),
  ]
  const sessions = buildSessions(events)
  expect(sessions).toHaveLength(2)
  expect(sessions.find((x) => x.runId)).toMatchObject({ runId: 'run-9', payments: 1 })
})

test('a missing page is not also a markdown problem', () => {
  const [j] = buildSessions([ev({ kind: 'request', ts: s(0), path: '/docs/nope', status: 404, accept: 'text/markdown', contentType: 'text/html', userAgent: CODEX, ipHash: 'ip-m' })])
  expect(j!.blockers.map((b) => b.kind)).toEqual(['not_found'])
})
