import { expect, test } from 'vitest'
import { setup, T0 } from './helpers.ts'

const CODEX = 'codex_cli_rs/0.46.0 (Mac OS 15.0; arm64)'

const codexJourney = [
  { id: '1', ts: T0, source: 'http', kind: 'request', path: '/llms.txt', status: 200, userAgent: CODEX, ip: '203.0.113.5' },
  { id: '2', ts: T0 + 1000, source: 'intake', kind: 'intent', text: 'Set up usage billing and email me at priya@example.com', userAgent: CODEX, ip: '203.0.113.5' },
  { id: '3', ts: T0 + 4000, source: 'http', kind: 'request', path: '/docs/billing/usage', query: 'q=usage&token=abc', status: 200, userAgent: CODEX, ip: '203.0.113.5' },
  { id: '4', ts: T0 + 21000, source: 'track', kind: 'step', step: 'installed', text: 'npm install @tripe/cli', ip: '203.0.113.5', sessionHint: 'cli-1', userAgent: 'node' },
  { id: '5', ts: T0 + 48000, source: 'track', kind: 'step', step: 'signed_in', sessionHint: 'cli-1', accountId: 'acct_42' },
  { id: '6', ts: T0 + 72000, source: 'http', kind: 'request', method: 'POST', host: 'api.tripe.test', path: '/v1/meters', status: 401, error: 'X-Api-Key rejected', accountId: 'acct_42' },
]

test('ingest needs a valid key and a valid batch', async () => {
  const { post, site } = setup()
  expect((await post('/v1/events', { events: codexJourney })).status).toBe(401)
  expect((await post('/v1/events', { events: codexJourney }, { 'x-agentrail-key': 'nope' })).status).toBe(401)
  expect((await post('/v1/events', { events: [{ id: 'x' }] }, { 'x-agentrail-key': site.ingestKey })).status).toBe(400)
  expect((await post('/v1/events', 'not json', { 'x-agentrail-key': site.ingestKey })).status).toBe(400)
})

test('stored events are redacted and hashed before they reach the database', async () => {
  const { send, store, site } = setup()
  const res = await send(codexJourney)
  expect(res.status).toBe(202)
  expect(await res.json()).toEqual({ ok: true, accepted: 6, stored: 6 })
  const stored = store.events([site.id], 0, Number.MAX_SAFE_INTEGER)
  const raw = JSON.stringify(stored)
  expect(raw).not.toContain('203.0.113.5')
  expect(raw).not.toContain('priya@example.com')
  expect(raw).not.toContain('acct_42')
  expect(raw).not.toContain('token=abc')
  expect(stored.find((e) => e.id === '2')?.text).toBe('Set up usage billing and email me at [EMAIL_1]')
  expect(stored.find((e) => e.id === '3')?.query).toBe('q=usage&token=[REDACTED]')
})

test('a retried batch is stored once', async () => {
  const { send } = setup()
  await send(codexJourney)
  expect(await (await send(codexJourney)).json()).toMatchObject({ stored: 0 })
})

test('the summary shows the journey, its funnel, intent and the fix it needs', async () => {
  const { send, get } = setup()
  await send(codexJourney)
  const { body } = await get('/api/summary?days=7')
  expect(body.overview).toMatchObject({ sessions: 1, live: 1, withIntent: 1 })
  expect(body.funnel.map((r: any) => r.sessions)).toEqual([1, 1, 1, 0, 0, 0, 0])
  expect(body.agents[0]).toMatchObject({ label: 'Codex', sessions: 1 })
  expect(body.fixes[0]).toMatchObject({ kind: 'failed_call', sessionsLost: 1, title: 'Agents fail auth: X-Api-Key rejected', sourcePage: '/docs/billing/usage' })
})

test('sessions list and a session timeline', async () => {
  const { send, get } = setup()
  await send(codexJourney)
  const list = await get('/api/sessions?days=7')
  expect(list.body.total).toBe(1)
  const id = list.body.sessions[0].id
  const detail = await get(`/api/sessions/${id}?days=7`)
  expect(detail.body.timeline.map((i: any) => i.text)).toEqual([
    'read /llms.txt',
    'task: "Set up usage billing and email me at [EMAIL_1]"',
    'read /docs/billing/usage?q=usage&token=[REDACTED]',
    'npm install @tripe/cli',
    'signed in',
    'POST /v1/meters  401  X-Api-Key rejected',
  ])
  expect(detail.body.timeline[3].marks).toEqual([{ kind: 'step', label: 'Installed' }])
  // Still live, so it has not stopped yet.
  expect(detail.body.timeline[5].marks.map((m: any) => m.kind)).toEqual(['blocked'])
  expect(detail.body).toMatchObject({ gotTo: { id: 'signed_in' }, stoppedAtLabel: 'First API call', failedCalls: { failed: 1, of: 1 } })
})

test('settings never return secrets, and a masked value keeps the stored one', async () => {
  const { app, store, workspace } = setup()
  const put = (body: unknown) => app.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const first: any = await (await put({ llm: { provider: 'anthropic', apiKey: 'sk-ant-real' } })).json()
  expect(first.llm).toEqual({ provider: 'anthropic', apiKey: 'set' })
  await put({ llm: { provider: 'anthropic', apiKey: 'set', model: 'claude-sonnet-5-5' } })
  expect(store.settings(workspace.id).llm).toEqual({ provider: 'anthropic', apiKey: 'sk-ant-real', model: 'claude-sonnet-5-5' })
  await put({ llm: { apiKey: '' } })
  expect(store.settings(workspace.id).llm.apiKey).toBeUndefined()
})

test('an admin token locks the API but not ingest', async () => {
  const { get, send } = setup({ config: { adminToken: 'letmein' } })
  expect((await get('/api/summary')).status).toBe(401)
  expect((await get('/api/summary', { authorization: 'Bearer letmein' })).status).toBe(200)
  expect((await send(codexJourney)).status).toBe(202)
})

test('arrivals are pushed live for agents only', async () => {
  const { ctx, send } = setup()
  const seen: string[] = []
  ctx.live.on('arrival', (a) => seen.push(`${a.agent}:${a.kind}`))
  await send([
    ...codexJourney.slice(0, 1),
    { id: 'h', ts: T0, source: 'http', kind: 'request', path: '/', status: 200, userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', ip: '198.51.100.1' },
  ])
  expect(seen).toEqual(['Codex:request'])
})

test('fix drafting and the session gap are workspace settings', async () => {
  const { app, store, workspace } = setup()
  await app.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoDraft: false, sessionGapMinutes: 5 }) })
  expect(store.settings(workspace.id)).toMatchObject({ autoDraft: false, sessionGapMinutes: 5 })
})

test('an exact from and to window wins over days', async () => {
  const { send, get } = setup()
  await send(codexJourney)
  expect((await get(`/api/summary?from=${T0 - 1000}&to=${T0 + 100_000}`)).body.overview.sessions).toBe(1)
  expect((await get(`/api/summary?from=${T0 + 10_000}&to=${T0 + 100_000}`)).body.overview.sessions).toBe(0)
})
