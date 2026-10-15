import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Agentrail } from '@agentrail/sdk'
import { extend } from '../src/features.ts'
import { parseDraft } from '../src/fixes.ts'
import { runApiAgent, RUN_HEADER } from '../src/runner.ts'
import { setup, T0 } from './helpers.ts'

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures/fake-claude.mjs')
const CODEX = 'codex_cli_rs/0.46.0'

/** Three agents stopped by a wrong auth header, one that found a missing page, and two that paid. */
const traffic = () => {
  const events: unknown[] = []
  let n = 0
  const add = (e: Record<string, unknown>) => events.push({ id: `f${++n}`, source: 'http', ...e })
  for (let i = 0; i < 3; i++) {
    const ip = `203.0.113.${i}`
    add({ ts: T0 + i * 1000, kind: 'intent', text: 'Set up usage billing', userAgent: CODEX, ip })
    add({ ts: T0 + i * 1000 + 1, kind: 'request', path: '/docs/api-keys', status: 200, userAgent: CODEX, ip })
    add({ ts: T0 + i * 1000 + 2, kind: 'step', step: 'signed_in', userAgent: CODEX, ip })
    add({ ts: T0 + i * 1000 + 3, kind: 'request', method: 'POST', host: 'api.x.test', path: '/v1/meters', status: 401, error: 'X-Api-Key rejected', userAgent: CODEX, ip })
  }
  add({ ts: T0 + 5000, kind: 'request', path: '/docs/billing/usage', status: 200, userAgent: CODEX, ip: '198.51.100.1' })
  add({ ts: T0 + 5001, kind: 'request', path: '/docs/usage-billing', status: 404, userAgent: CODEX, ip: '198.51.100.2' })
  for (let i = 0; i < 2; i++) {
    const ip = `192.0.2.${i}`
    add({ ts: T0 + 6000 + i, kind: 'request', path: '/docs/api-keys', status: 200, userAgent: CODEX, ip })
    add({ ts: T0 + 6010 + i, kind: 'step', step: 'first_api_call', userAgent: CODEX, ip })
    add({ ts: T0 + 6020 + i, kind: 'payment', amount: 5000, currency: 'usd', userAgent: CODEX, ip })
  }
  return events
}

const AUTH_KEY = 'failed_call:auth:401:X-Api-Key rejected'

const withFixes = (extra: Parameters<typeof extend>[2] = {}) => {
  const env = { AGENTRAIL_CLAUDE_BIN: FAKE_CLAUDE }
  return setup({ extend: (app, ctx) => extend(app, ctx, { env, ...extra }) })
}

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out')
}

test('fixes list and detail carry the evidence', async () => {
  const { send, get } = withFixes()
  await send(traffic())
  const list = await get('/api/fixes?days=7')
  const auth = list.body.fixes.find((f: any) => f.key === AUTH_KEY)
  expect(auth).toMatchObject({ sessionsLost: 3, sourcePage: '/docs/api-keys', beforeStep: 'first_api_call' })
  const detail = await get(`/api/fixes/${encodeURIComponent(AUTH_KEY)}?days=7`)
  expect(detail.body.sessions).toHaveLength(3)
  expect(detail.body.runSummary).toEqual({ before: { runs: 0, converted: 0 }, after: { runs: 0, converted: 0 } })
  expect((await get('/api/fixes/nope')).status).toBe(404)
})

test('providers list Claude Code as ready when the CLI is found', async () => {
  const { get } = withFixes()
  const { body } = await get('/api/providers')
  expect(body.selected).toBe('claude-code')
  expect(body.agents[0]).toMatchObject({ id: 'claude-code', ready: true })
})

test('drafting with Claude Code, then publishing as a GitHub pull request', async () => {
  const github: { method: string; url: string; body?: any }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    github.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/contents/docs/api-keys.md?ref=main') || url.endsWith('/contents/docs/api-keys.md')) {
      return json({ type: 'file', sha: 'abc', content: Buffer.from('# API keys\n\nSend `X-Api-Key: $KEY`.\n').toString('base64') })
    }
    if (url.includes('/contents/')) {
      if (method === 'PUT') return json({ content: {} })
      return json({ message: 'Not Found' }, 404)
    }
    if (url.endsWith('/repos/acme/docs')) return json({ default_branch: 'main' })
    if (url.includes('/git/ref/heads/')) return json({ object: { sha: 'base-sha' } })
    if (url.endsWith('/git/refs')) return json({ ref: 'x' }, 201)
    if (url.endsWith('/pulls')) return json({ html_url: 'https://github.com/acme/docs/pull/7' }, 201)
    return json({ message: 'unexpected' }, 500)
  }) as typeof fetch
  const { send, app, get, store, workspace } = withFixes({ fetcher })
  store.saveSettings(workspace.id, { ...store.settings(workspace.id), github: { repo: 'acme/docs', token: 'ghp_test', branch: 'main', docsRoot: '' } })
  await send(traffic())
  const path = `/api/fixes/${encodeURIComponent(AUTH_KEY)}`
  const draft = await app.request(`${path}/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(draft.status).toBe(202)
  await waitFor(async () => !(await get(`${path}?days=7`)).body.record?.drafting)
  const drafted = (await get(`${path}?days=7`)).body.record
  expect(drafted).toMatchObject({ status: 'drafted', draft: { file: 'docs/api-keys.md', provider: 'claude-code', summary: 'Use the Authorization header.' } })
  expect(drafted.draft.before).toContain('X-Api-Key')
  expect(drafted.draft.after).toContain('Authorization: Bearer')
  expect(drafted.draft.after).toContain('```bash')

  const published = await app.request(`${path}/publish`, { method: 'POST' })
  expect(await published.json()).toMatchObject({ status: 'published', prUrl: 'https://github.com/acme/docs/pull/7' })
  const put = github.find((g) => g.method === 'PUT')!
  expect(Buffer.from(put.body.content, 'base64').toString()).toContain('Authorization: Bearer')
  expect(put.body.branch).toMatch(/^agentrail\/fix-/)
  expect(github.find((g) => g.url.endsWith('/pulls'))!.body).toMatchObject({ base: 'main' })
  expect((await get(`${path}?days=7`)).body.impact).toBeDefined()
})

test('a missing page publishes as a redirect that the SDK then serves', async () => {
  const { send, app, site } = withFixes()
  await send(traffic())
  const key = 'not_found:/docs/usage-billing'
  const res = await app.request(`/api/fixes/${encodeURIComponent(key)}/publish`, { method: 'POST' })
  expect(res.status).toBe(200)
  const sdk = new Agentrail({ key: site.ingestKey, endpoint: 'http://agentrail.test', applyFixes: true, flushIntervalMs: 0, fetch: ((u: string, i: RequestInit) => app.request(u, i)) as typeof fetch })
  await sdk.refreshFixes(true)
  const handler = sdk.handler(async () => new Response('page'))
  const out = await handler(new Request('https://docs.x.test/docs/usage-billing', { headers: { 'user-agent': CODEX } }))
  expect(out.status).toBe(308)
  expect(out.headers.get('location')).toBe('/docs/billing/usage')
})

test('dismissing and reopening', async () => {
  const { send, app, get } = withFixes()
  await send(traffic())
  const path = `/api/fixes/${encodeURIComponent(AUTH_KEY)}/status`
  await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'dismissed' }) })
  expect((await get('/api/summary?days=7')).body.fixes.some((f: any) => f.key === AUTH_KEY)).toBe(false)
  await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'open' }) })
  expect((await get('/api/summary?days=7')).body.fixes.some((f: any) => f.key === AUTH_KEY)).toBe(true)
})

test('the API agent loop stays on the target, sends the run header, and stops on done', async () => {
  const seen: { url: string; run: string | null }[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), run: new Headers(init?.headers).get(RUN_HEADER) })
    return new Response('# Docs\nUse Authorization: Bearer.', { headers: { 'content-type': 'text/markdown' } })
  }) as typeof fetch
  const replies = [
    '{"action": "http", "url": "https://docs.x.test/llms.txt"}',
    '{"action": "http", "url": "https://evil.example.com/steal"}',
    'thinking out loud',
    '{"action": "http", "method": "POST", "url": "https://api.x.test/v1/meters", "body": "{}"}',
    '{"action": "done", "success": true, "summary": "Created a meter."}',
  ]
  const outcome = await runApiAgent(
    { runId: 'run_1', agent: 'api:anthropic', task: 'Create a meter', targetUrl: 'https://docs.x.test', timeoutMs: 1000, settings: {} as never, fetcher },
    async () => replies.shift()!,
  )
  expect(seen.map((s) => s.url)).toEqual(['https://docs.x.test/llms.txt', 'https://api.x.test/v1/meters'])
  expect(seen.every((s) => s.run === 'run_1')).toBe(true)
  expect(outcome.selfReport).toEqual({ success: true, summary: 'Created a meter.' })
})

test('parseDraft reads bare and fenced JSON, even when the page has its own fences', () => {
  expect(parseDraft('```json\n{"content": "a"}\n```')).toEqual({ content: 'a' })
  const page = JSON.stringify({ file: 'x.md', content: '# X\n\n```bash\necho hi\n```\n' })
  expect(parseDraft(page)?.content).toContain('echo hi')
  expect(parseDraft('```json\n' + page + '\n```')?.content).toContain('echo hi')
  expect(parseDraft('Here: {"file": "x.md", "content": "b"} done')).toEqual({ file: 'x.md', content: 'b' })
  expect(parseDraft('no json')).toBeUndefined()
})
