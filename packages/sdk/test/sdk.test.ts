import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from 'vitest'
import { OpenScope, llmsTxtLine } from '../src/index.ts'

const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const collector = (options: Partial<ConstructorParameters<typeof OpenScope>[0]> = {}) => {
  const batches: any[][] = []
  const fake = (async (_url: string, init: RequestInit) => {
    batches.push(JSON.parse(String(init.body)).events)
    return new Response('{}', { status: 202 })
  }) as typeof fetch
  const ar = new OpenScope({ key: 'ar_test', flushIntervalMs: 0, fetch: fake, ...options })
  return { ar, batches, sent: () => batches.flat() }
}

test('the fetch wrapper records agent requests with status, type and error, and drops people', async () => {
  const { ar, sent } = collector()
  const app = ar.handler(async (req: Request) => {
    if (new URL(req.url).pathname === '/v1/meters') return Response.json({ error: { message: 'X-Api-Key rejected' } }, { status: 401 })
    return new Response('# Docs', { headers: { 'content-type': 'text/markdown' } })
  })
  await app(new Request('https://docs.tripe.test/llms.txt', { headers: { 'user-agent': 'codex_cli_rs/0.46.0' } }))
  await app(new Request('https://api.tripe.test/v1/meters?x=1', { method: 'POST', headers: { 'user-agent': 'python-requests/2.32', 'x-openscope-session': 's1' } }))
  await app(new Request('https://docs.tripe.test/docs', { headers: { 'user-agent': CHROME } }))
  await app(new Request('https://docs.tripe.test/app.js', { headers: { 'user-agent': 'codex_cli_rs/0.46.0' } }))
  await ar.flush()
  const events = sent()
  expect(events).toHaveLength(2)
  expect(events[0]).toMatchObject({ kind: 'request', source: 'http', host: 'docs.tripe.test', path: '/llms.txt', status: 200, contentType: 'text/markdown', userAgent: 'codex_cli_rs/0.46.0' })
  expect(events[1]).toMatchObject({ method: 'POST', path: '/v1/meters', query: 'x=1', status: 401, error: 'X-Api-Key rejected', sessionHint: 's1' })
})

test('sendAll records people too, for teams that want it', async () => {
  const { ar, sent } = collector({ sendAll: true })
  await ar.handler(async () => new Response('ok'))(new Request('https://x.test/', { headers: { 'user-agent': CHROME } }))
  await ar.flush()
  expect(sent()).toHaveLength(1)
})

test('a signed request is always sent, so the server can verify it', async () => {
  const { ar, sent } = collector()
  await ar.handler(async () => new Response('ok'))(
    new Request('https://x.test/', { headers: { 'user-agent': CHROME, signature: 'sig1=:abc:', 'signature-input': 'sig1=("@authority")', 'signature-agent': '"https://chatgpt.com"' } }),
  )
  await ar.flush()
  expect(sent()[0]).toMatchObject({ signature: 'sig1=:abc:', signatureAgent: '"https://chatgpt.com"' })
})

test('agents can declare their task at the intake path', async () => {
  const { ar, sent } = collector({ trustProxy: true })
  const app = ar.handler(async () => new Response('never'))
  const res = await app(
    new Request('https://x.test/.well-known/agent-task', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Claude-User', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
      body: JSON.stringify({ task: 'Refund the last charge' }),
    }),
  )
  expect(res.status).toBe(202)
  expect((await app(new Request('https://x.test/.well-known/agent-task'))).status).toBe(200)
  expect((await app(new Request('https://x.test/.well-known/agent-task', { method: 'POST', body: '' }))).status).toBe(400)
  await ar.flush()
  expect(sent()).toEqual([expect.objectContaining({ kind: 'intent', source: 'intake', text: 'Refund the last charge', userAgent: 'Claude-User', ip: '203.0.113.7' })])
})

test('track, identify, intent, search and payment', async () => {
  const { ar, sent } = collector()
  ar.track('installed', { sessionHint: 'cli-1', text: 'npm install @tripe/cli' })
  ar.identify('acct_1', { sessionHint: 'cli-1' })
  ar.intent('Set up billing', { sessionHint: 'cli-1' })
  ar.search('usage billing', { ip: '203.0.113.9' })
  ar.payment({ accountId: 'acct_1', amount: 4900, currency: 'usd' })
  await ar.flush()
  expect(sent().map((e) => e.kind)).toEqual(['step', 'identify', 'intent', 'search', 'payment'])
  expect(sent()[1]).toMatchObject({ accountId: 'acct_1', sessionHint: 'cli-1' })
})

test('a full queue flushes on its own, and a failed send reports instead of throwing', async () => {
  const errors: unknown[] = []
  const ar = new OpenScope({ key: 'k', flushIntervalMs: 0, maxBatch: 2, fetch: (async () => { throw new Error('down') }) as typeof fetch, onError: (e) => errors.push(e) })
  ar.track('a')
  ar.track('b')
  await ar.close()
  expect(errors).toHaveLength(1)
})

test('Node and Express middleware records on finish with the real status', async () => {
  const { ar, sent } = collector()
  const mw = ar.node()
  const server = createServer((req, res) => {
    mw(req, res, () => {
      if (req.url === '/v1/meters') {
        res.statusCode = 401
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: { message: 'X-Api-Key rejected. Send Authorization: Bearer <key>.' } }))
        return
      }
      res.statusCode = req.url === '/missing' ? 404 : 200
      res.setHeader('content-type', 'text/html')
      res.end('<html></html>')
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  const port = (server.address() as AddressInfo).port
  await fetch(`http://127.0.0.1:${port}/missing`, { headers: { 'user-agent': 'Claude-User', accept: 'text/markdown' } })
  await fetch(`http://127.0.0.1:${port}/v1/meters`, { method: 'POST', headers: { 'user-agent': 'curl/8.7.1' } })
  const intake = await fetch(`http://127.0.0.1:${port}/.well-known/agent-task`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Claude-User' }, body: JSON.stringify({ task: 'Find pricing' }) })
  expect(intake.status).toBe(202)
  await new Promise((r) => setTimeout(r, 20))
  server.close()
  await ar.flush()
  expect(sent()).toEqual([
    expect.objectContaining({ kind: 'request', path: '/missing', status: 404, accept: 'text/markdown', contentType: 'text/html', ip: '127.0.0.1' }),
    expect.objectContaining({ kind: 'request', method: 'POST', path: '/v1/meters', status: 401, error: 'X-Api-Key rejected. Send Authorization: Bearer <key>.' }),
    expect.objectContaining({ kind: 'intent', text: 'Find pricing' }),
  ])
})

test('llms.txt line points agents at the docs finder', () => {
  expect(llmsTxtLine('https://docs.tripe.test/')).toContain('https://docs.tripe.test/api/docs/find')
})

const LLMS = `# Ledgerly
> Payments API.

## Docs
- [Usage-based billing](/docs/billing/usage-based): Charge for what customers use, with meters and meter events.
- [API keys](/docs/api-keys): Authenticate your requests.
- [Refunds](https://docs.ledgerly.test/docs/refunds): Refund a charge in full or in part.
- [Status page](https://status.example.com): Outside link.
`

test('the docs finder answers from llms.txt, and the query becomes the intent', async () => {
  const { ar, sent } = collector()
  const app = ar.handler(async (req: Request) =>
    new URL(req.url).pathname === '/llms.txt' ? new Response(LLMS) : new Response('page'),
  )
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => app(new Request(String(input)))) as typeof fetch
  try {
    const res = await app(
      new Request('https://docs.ledgerly.test/api/docs/find', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Claude-User (claude-code/2.1.288)' },
        body: JSON.stringify({ query: 'set up usage-based billing with meter events for our API' }),
      }),
    )
    const body = (await res.json()) as { results: { path: string; url: string }[] }
    expect(body.results[0]).toMatchObject({ path: '/docs/billing/usage-based', url: 'https://docs.ledgerly.test/docs/billing/usage-based' })
    expect(body.results.map((r) => r.path)).not.toContain('https://status.example.com')
    const get = await app(new Request('https://docs.ledgerly.test/api/docs/find?q=refund%20a%20charge', { headers: { 'user-agent': 'curl/8.7.1' } }))
    expect(((await get.json()) as { results: { path: string }[] }).results[0]!.path).toBe('/docs/refunds')
  } finally {
    globalThis.fetch = realFetch
  }
  await ar.flush()
  const intents = sent().filter((e) => e.kind === 'intent')
  expect(intents.map((e) => e.text)).toEqual(['set up usage-based billing with meter events for our API', 'refund a charge'])
  expect(intents[0]).toMatchObject({ source: 'intake', method: 'POST', path: '/api/docs/find', status: 200, userAgent: 'Claude-User (claude-code/2.1.288)' })
  // The finder records the intent and not a second request event for the same call.
  expect(sent().filter((e) => e.path === '/api/docs/find' && e.kind === 'request')).toHaveLength(0)
})

test('published corrected pages go to agents as markdown, and people still get the page', async () => {
  const fake = (async (url: string) => {
    if (String(url).endsWith('/v1/fixes/live')) return Response.json({ redirects: [], pages: [{ path: '/docs/api-keys', content: '# API keys\nUse Authorization: Bearer.', contentType: 'text/markdown; charset=utf-8' }] })
    return new Response('{}', { status: 202 })
  }) as typeof fetch
  const ar = new OpenScope({ key: 'k', flushIntervalMs: 0, applyFixes: true, fetch: fake })
  await ar.refreshFixes(true)
  const app = ar.handler(async () => new Response('<html>old page</html>', { headers: { 'content-type': 'text/html' } }))
  const agent = await app(new Request('https://docs.x.test/docs/api-keys', { headers: { 'user-agent': 'Claude-User (claude-code/2.1.288)' } }))
  expect(await agent.text()).toContain('Authorization: Bearer')
  expect(agent.headers.get('x-openscope-fix')).toBe('live')
  const person = await app(new Request('https://docs.x.test/docs/api-keys', { headers: { 'user-agent': CHROME } }))
  expect(await person.text()).toBe('<html>old page</html>')
})
