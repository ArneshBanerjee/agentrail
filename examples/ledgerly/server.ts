import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Agentrail, llmsTxtAgentNote, llmsTxtLine } from '@agentrail/sdk'

/**
 * Ledgerly: a small, fake usage-billing API with docs, used to show Agentrail end to end. Point a
 * plain coding agent at it with an ordinary task, and watch the journey in the dashboard.
 *
 * It has the same flaw on purpose that the demo shows: the API keys guide documents the wrong auth
 * header. The API only accepts `Authorization: Bearer`, and its 401 says so.
 *
 *   AGENTRAIL_KEY=ar_... node examples/ledgerly/server.ts
 */

const PORT = Number(process.env.PORT ?? 4400)
const ORIGIN = process.env.LEDGERLY_ORIGIN ?? `http://localhost:${PORT}`
/** A person approves the device sign-in after this many polls. 0 means never. */
const APPROVE_AFTER = Number(process.env.APPROVE_AFTER ?? 3)

const keys = new Map<string, string>() // api key -> account
const devices = new Map<string, { polls: number; account: string; key?: string }>()
const meters = new Map<string, { id: string; account: string; event_name: string; events: number; value: number }>()

const agentrail = new Agentrail({
  key: process.env.AGENTRAIL_KEY ?? 'missing-key',
  endpoint: process.env.AGENTRAIL_ENDPOINT ?? 'http://localhost:4318',
  applyFixes: true,
  accountOf: (request) => keys.get((request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')),
  onError: (error) => console.error('agentrail:', (error as Error).message),
})
const collect = agentrail.node()

const DOCS: Record<string, { title: string; description: string; body: string }> = {
  '/docs/quickstart': {
    title: 'Quickstart',
    description: 'Register a project, sign in, and make your first call.',
    body: `# Quickstart

1. Register your project: \`POST ${ORIGIN}/api/cli/init\`. It returns a \`project_id\`.
2. Sign in with the device flow in [Sign in](/docs/sign-in) to get an API key.
3. Authenticate as the [API keys](/docs/api-keys) guide shows.
4. Create a meter and send meter events, as [Usage-based billing](/docs/billing/usage-based) shows.
`,
  },
  '/docs/sign-in': {
    title: 'Sign in',
    description: 'Get an API key with the device flow. A person approves it once.',
    body: `# Sign in

1. \`POST ${ORIGIN}/api/device/start\` returns \`device_code\`, \`user_code\` and \`verification_uri\`.
2. Ask the person to open \`verification_uri\` and approve.
3. Poll \`POST ${ORIGIN}/api/device/poll\` with \`{"device_code": "..."}\` every 2 seconds.
   It answers \`428 authorization_pending\` until the person approves, then \`200\` with \`api_key\`.
`,
  },
  '/docs/api-keys': {
    title: 'API keys',
    description: 'Authenticate your requests.',
    body: `# API keys

## Authenticate your requests

Pass your secret key in the X-Api-Key header:

\`\`\`bash
curl ${ORIGIN}/v1/meters \\
  -H "X-Api-Key: sk_test_..."
\`\`\`
`,
  },
  '/docs/billing/usage-based': {
    title: 'Usage-based billing',
    description: 'Charge for what customers use, with meters and meter events.',
    body: `# Usage-based billing

1. Create a meter: \`POST ${ORIGIN}/v1/meters\` with \`{"event_name": "api_call"}\`.
2. Report usage: \`POST ${ORIGIN}/v1/billing/meter_events\` with \`{"event_name": "api_call", "value": 1}\`.
3. Start the subscription that bills it: \`POST ${ORIGIN}/v1/subscriptions\` with \`{"price_per_unit": 0.002}\`.
4. Read usage: \`GET ${ORIGIN}/v1/billing/meters/{meter_id}/event_summaries\`.

Every call needs an API key, as the [API keys](/docs/api-keys) guide shows.
`,
  },
}

const llmsTxt = () => `# Ledgerly

> Usage-based billing for APIs. Meters, meter events and subscriptions.

${llmsTxtAgentNote(ORIGIN)}

${llmsTxtLine(ORIGIN)}

## Docs

${Object.entries(DOCS)
  .map(([path, d]) => `- [${d.title}](${path}): ${d.description}`)
  .join('\n')}
`

const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    let data = ''
    req.on('data', (c: Buffer) => (data += c.toString()))
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
  })

const authenticate = (req: IncomingMessage, res: ServerResponse): string | undefined => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
  const account = bearer ? keys.get(bearer) : undefined
  if (account) return account
  const message = req.headers['x-api-key'] ? 'X-Api-Key rejected. Send Authorization: Bearer <key>.' : 'Missing API key. Send Authorization: Bearer <key>.'
  send(res, 401, { error: { type: 'authentication_error', message } })
  return undefined
}

const app = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', ORIGIN)
  const path = url.pathname.replace(/\.md$/, '')
  const wantsMarkdown = /markdown|text\/plain/i.test(req.headers.accept ?? '') || url.pathname.endsWith('.md')

  if (req.method === 'GET' && path === '/llms.txt') return send(res, 200, llmsTxt(), 'text/plain; charset=utf-8')
  if (req.method === 'GET' && (path === '/' || path === '/docs')) return send(res, 200, `# Ledgerly docs\n\n${llmsTxt()}`, 'text/markdown; charset=utf-8')
  const doc = DOCS[path]
  if (req.method === 'GET' && doc) {
    return wantsMarkdown
      ? send(res, 200, doc.body, 'text/markdown; charset=utf-8')
      : send(res, 200, `<!doctype html><title>${doc.title}</title><pre>${doc.body.replace(/</g, '&lt;')}</pre>`, 'text/html; charset=utf-8')
  }

  if (req.method === 'POST' && path === '/api/cli/init') return send(res, 200, { project_id: `proj_${randomBytes(4).toString('hex')}` })
  if (req.method === 'POST' && path === '/api/device/start') {
    const device_code = randomBytes(8).toString('hex')
    devices.set(device_code, { polls: 0, account: `acct_${randomBytes(4).toString('hex')}` })
    return send(res, 200, { device_code, user_code: device_code.slice(0, 6).toUpperCase(), verification_uri: `${ORIGIN}/device`, interval: 2 })
  }
  if (req.method === 'POST' && path === '/api/device/poll') {
    const { device_code } = await readJson(req)
    const device = typeof device_code === 'string' ? devices.get(device_code) : undefined
    if (!device) return send(res, 400, { error: 'invalid_device_code' })
    device.polls++
    if (APPROVE_AFTER === 0 || device.polls < APPROVE_AFTER) return send(res, 428, { error: 'authorization_pending' })
    device.key ??= `sk_test_${randomBytes(12).toString('hex')}`
    keys.set(device.key, device.account)
    agentrail.identify(device.account, { userAgent: req.headers['user-agent'] ?? '', ...(req.socket.remoteAddress ? { ip: req.socket.remoteAddress.replace(/^::ffff:/, '') } : {}) })
    return send(res, 200, { api_key: device.key, account: device.account })
  }

  if (path.startsWith('/v1/')) {
    const account = authenticate(req, res)
    if (!account) return
    if (req.method === 'POST' && path === '/v1/meters') {
      const body = await readJson(req)
      const meter = { id: `mtr_${randomBytes(4).toString('hex')}`, account, event_name: String(body.event_name ?? 'api_call'), events: 0, value: 0 }
      meters.set(meter.id, meter)
      return send(res, 200, meter)
    }
    if (req.method === 'POST' && path === '/v1/billing/meter_events') {
      const body = await readJson(req)
      const meter = [...meters.values()].reverse().find((m) => m.account === account && m.event_name === body.event_name)
      if (!meter) return send(res, 400, { error: { message: `No meter for event_name "${String(body.event_name)}". Create one first.` } })
      meter.events++
      meter.value += Number(body.value ?? 1)
      return send(res, 200, { ok: true, meter: meter.id })
    }
    const summary = /^\/v1\/billing\/meters\/([^/]+)\/event_summaries$/.exec(path)
    if (req.method === 'GET' && summary) {
      const meter = meters.get(summary[1]!)
      return meter && meter.account === account ? send(res, 200, { meter: meter.id, events: meter.events, value: meter.value }) : send(res, 404, { error: { message: 'No such meter.' } })
    }
    if (req.method === 'POST' && path === '/v1/subscriptions') {
      const body = await readJson(req)
      // Test mode: the first invoice is paid at once, so the journey reaches its first payment.
      agentrail.payment({ accountId: account, amount: 2900, currency: 'usd' })
      return send(res, 200, { id: `sub_${randomBytes(4).toString('hex')}`, status: 'active', price_per_unit: body.price_per_unit ?? 0.002 })
    }
  }
  send(res, 404, { error: { message: `No route for ${req.method} ${url.pathname}. Read ${ORIGIN}/llms.txt.` } })
}

createServer((req, res) => collect(req, res, () => void app(req, res))).listen(PORT, () => console.log(`Ledgerly on ${ORIGIN}`))
