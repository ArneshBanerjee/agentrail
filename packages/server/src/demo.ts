import type { IncomingEvent } from '@agentrail/core'

/**
 * A month of agent traffic for a made-up payments API called Ledgerly, for the demo workspace and
 * for screenshots. Seeded, so every run makes the same month.
 *
 * It is all plain HTTP, the way a product sees agents that nobody configured: the docs finder,
 * pages read, a CLI download, a device sign-in that polls until a person approves it, API calls and
 * payments. The problems in it are the ones agents really hit: a wrong auth header in the API keys
 * guide, a path agents guess, markdown asked for and HTML served, a sign-in nobody approves, and a
 * real card used in test mode.
 */

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

type Agent = { ua: string; mcp?: string; weight: number; skill: number; accept?: string; finder: number }

const AGENTS: Agent[] = [
  { ua: 'Cursor/1.7.38 (darwin arm64)', mcp: 'cursor', weight: 40, skill: 0.62, finder: 0.6 },
  { ua: 'codex_cli_rs/0.46.0 (Mac OS 15.0; arm64)', mcp: 'codex-mcp-client', weight: 25, skill: 0.7, finder: 0.65 },
  { ua: 'Claude-User (claude-code/2.1.288; +https://support.anthropic.com/)', mcp: 'claude-code', weight: 18, skill: 0.72, accept: 'text/markdown, text/html;q=0.8', finder: 0.75 },
  { ua: 'python-requests/2.32.3', weight: 9, skill: 0.35, accept: 'text/markdown', finder: 0.3 },
  { ua: 'curl/8.7.1', weight: 4, skill: 0.3, finder: 0.4 },
  { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)', weight: 3, skill: 0.5, finder: 0.5 },
  { ua: 'GeminiCLI/0.9.0 (darwin; arm64)', mcp: 'gemini-cli-mcp-client', weight: 1, skill: 0.55, finder: 0.5 },
]

type Intent = { tasks: string[]; amount: [number, number]; docs: string[]; calls: { method: string; path: string }[] }

const INTENTS: Intent[] = [
  {
    tasks: [
      'set up usage-based billing with meter events for our API',
      'bill API calls at $0.002 each with usage-based billing',
      'create a monthly subscription with a 14 day trial for the Pro plan',
      'charge customers per seat on a monthly subscription',
    ],
    amount: [2900, 14900],
    docs: ['/docs/billing/usage-based', '/docs/billing/meters', '/docs/sdk/quickstart', '/docs/api-keys'],
    calls: [
      { method: 'POST', path: '/v1/subscriptions' },
      { method: 'POST', path: '/v1/billing/meter_events' },
      { method: 'POST', path: '/v1/billing/meter_events' },
      { method: 'GET', path: '/v1/billing/meters/mtr_8Yx2/event_summaries' },
    ],
  },
  {
    tasks: ['set up a Checkout session for a one-time €120 payment and return the URL', 'add a pay button to my Next.js store that opens a hosted checkout', 'create a payment link for a $49 ebook'],
    amount: [4900, 12000],
    docs: ['/docs/checkout', '/docs/checkout/sessions', '/docs/api-keys'],
    calls: [{ method: 'POST', path: '/v1/checkout/sessions' }],
  },
  {
    tasks: ['refund the last charge for cus_8x2Lk and let them know by email', 'refund half of order 1042 to the original card'],
    amount: [900, 2900],
    docs: ['/docs/refunds', '/docs/api-keys'],
    calls: [{ method: 'GET', path: '/v1/charges' }, { method: 'POST', path: '/v1/refunds' }],
  },
  {
    tasks: ['invoice with line items and a due date', 'send an invoice when the contract is signed'],
    amount: [4900, 19900],
    docs: ['/docs/invoices', '/docs/api-keys'],
    calls: [{ method: 'POST', path: '/v1/invoices' }, { method: 'POST', path: '/v1/invoices/in_42/send' }],
  },
  {
    tasks: ['listen for successful payments with a webhook and mark the order paid', 'verify webhook signatures in my Express server'],
    amount: [2900, 4900],
    docs: ['/docs/webhooks', '/docs/webhooks/signatures'],
    calls: [{ method: 'POST', path: '/v1/webhook_endpoints' }],
  },
]

const SEARCH_REFERRERS = ['https://www.google.com/', 'https://www.bing.com/', 'https://duckduckgo.com/', 'https://www.perplexity.ai/', 'https://chatgpt.com/']
const COMPARISON = ['https://devtools.example.com/payments-api-alternatives', 'https://blog.example.org/ledgerly-vs-stripe']

export type DemoOptions = { readonly now: number; readonly days?: number; readonly sessions?: number; readonly seed?: number }

export const demoEvents = (options: DemoOptions): IncomingEvent[] => {
  const rand = mulberry32(options.seed ?? 7)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const chance = (p: number) => rand() < p
  const between = (a: number, b: number) => Math.round(a + rand() * (b - a))
  const weighted = <T extends { weight: number }>(xs: readonly T[]): T => {
    const total = xs.reduce((s, x) => s + x.weight, 0)
    let r = rand() * total
    for (const x of xs) {
      r -= x.weight
      if (r <= 0) return x
    }
    return xs.at(-1)!
  }

  const days = options.days ?? 30
  const count = options.sessions ?? 1150
  const start = options.now - days * 86_400_000
  const events: IncomingEvent[] = []
  let n = 0
  const id = () => `demo-${++n}`

  for (let i = 0; i < count; i++) {
    const agent = weighted(AGENTS)
    const intent = pick(INTENTS)
    // The last few sessions are minutes old, so the demo has something live.
    const at = i < 5 ? options.now - between(10, 200) * 1000 : start + Math.pow(rand(), 0.8) * (days * 86_400_000 - 3_600_000)
    let t = Math.round(at)
    const ip = `198.51.${100 + (i % 50)}.${(i * 7) % 250}`
    const account = `acct_${1000 + i}`
    const base = { userAgent: agent.ua, ip }
    const docs = 'docs.ledgerly.dev'
    const api = 'api.ledgerly.dev'
    const push = (e: Omit<IncomingEvent, 'id' | 'ts'>, gapSec: [number, number] = [2, 20]) => {
      t += between(gapSec[0], gapSec[1]) * 1000
      if (t > options.now) return false
      events.push({ id: id(), ts: t, ...e } as IncomingEvent)
      return true
    }
    const read = (path: string, status = 200, extra: Partial<IncomingEvent> = {}) =>
      push({ source: 'http', kind: 'request', method: 'GET', host: docs, path, status, contentType: path.endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8', ...(agent.accept ? { accept: agent.accept } : {}), ...base, ...extra })
    const call = (method: string, path: string, status = 200, extra: Partial<IncomingEvent> = {}) =>
      push({ source: 'http', kind: 'request', method, host: api, path, status, accountId: account, ...base, ...extra }, [4, 25])

    // How it found the product, and whether it said what it wants through the docs finder.
    const task = pick(intent.tasks)
    if (chance(agent.finder)) {
      if (chance(0.5)) read('/llms.txt')
      push({ source: 'intake', kind: 'intent', text: task, method: 'POST', host: docs, path: '/api/docs/find', status: 200, ...base }, [1, 4])
    } else {
      const via = rand()
      if (via < 0.35) read(pick(intent.docs), 200, { referrer: pick(SEARCH_REFERRERS) })
      else if (via < 0.5) read('/docs', 200, { referrer: pick(COMPARISON) })
      else if (via < 0.65) read('/sitemap.xml')
      else if (agent.mcp && via < 0.75) push({ source: 'mcp', kind: 'mcp_connect', mcpClient: agent.mcp, sessionHint: `mcp-${i}`, ...base })
      else read('/docs')
    }

    // Reading. A guessed path that does not exist, and markdown asked for and HTML given.
    if (intent.docs[0] === '/docs/billing/usage-based' && chance(0.25)) read('/docs/usage-billing', 404)
    for (const path of intent.docs.slice(0, between(1, intent.docs.length))) read(path)
    if (agent.accept && chance(0.3)) read('/docs/quickstart')

    if (!chance(0.62 + agent.skill * 0.15)) continue
    if (!(chance(0.6) ? read('/dl/v/ledgerly-cli.tgz') : push({ source: 'http', kind: 'request', method: 'POST', host: api, path: '/api/cli/init', status: 200, ...base }, [10, 40]))) continue

    // Device sign-in: the agent polls until a person approves it, and sometimes nobody does.
    push({ source: 'http', kind: 'request', method: 'POST', host: api, path: '/api/cli/init', status: 200, ...base }, [3, 8])
    push({ source: 'http', kind: 'request', method: 'POST', host: api, path: '/api/device/start', status: 200, ...base }, [1, 3])
    const polls = between(2, 7)
    const approved = chance(0.86)
    for (let p = 0; p < polls; p++) push({ source: 'http', kind: 'request', method: 'POST', host: api, path: '/api/device/poll', status: 428, ...base }, [4, 6])
    if (!approved) continue
    if (!push({ source: 'http', kind: 'request', method: 'POST', host: api, path: '/api/device/poll', status: 200, accountId: account, ...base }, [4, 6])) continue
    if (agent.mcp && chance(0.2)) push({ source: 'mcp', kind: 'mcp_connect', mcpClient: agent.mcp, accountId: account, ...base }, [3, 10])

    // The API keys guide shows the wrong header, and agents that read it copy it.
    const readKeysGuide = intent.docs.includes('/docs/api-keys')
    const first = intent.calls[0]!
    if (readKeysGuide && chance(0.55 - agent.skill * 0.25)) {
      call(first.method, first.path, 401, { error: 'X-Api-Key rejected' })
      if (chance(0.6)) {
        read('/docs/api-keys')
        call(first.method, first.path, 401, { error: 'X-Api-Key rejected' })
      }
      if (chance(0.8)) continue
    }
    if (first.path === '/v1/webhook_endpoints' && chance(0.3)) {
      call(first.method, first.path, 400, { error: 'url must be https' })
      if (chance(0.7)) continue
    }
    if (agent.mcp && chance(0.05)) {
      push({ source: 'mcp', kind: 'mcp_tool', tool: 'create_meter_event', ok: false, error: 'missing field: event_name', accountId: account, mcpClient: agent.mcp, ...base }, [3, 10])
      if (chance(0.7)) continue
    }
    for (const c of intent.calls) call(c.method, c.path)

    // A real card in test mode is declined, and agents rarely know the test card numbers.
    if (chance(0.14)) {
      push({ source: 'stripe', kind: 'payment', ok: false, error: 'card_declined: live card used in test mode', accountId: account, currency: 'usd' }, [20, 90])
      if (chance(0.8)) continue
    }
    if (!chance(0.74)) continue
    const amount = between(intent.amount[0], intent.amount[1])
    push({ source: 'stripe', kind: 'payment', amount, currency: 'usd', accountId: account }, [60, 900])
    const renewal = t + 30 * 86_400_000
    if (renewal < options.now && chance(0.85)) events.push({ id: id(), ts: renewal, source: 'stripe', kind: 'payment', amount, currency: 'usd', accountId: account } as IncomingEvent)
    else if (chance(0.5)) push({ source: 'stripe', kind: 'payment', amount, currency: 'usd', accountId: account }, [86_400, 5 * 86_400])
  }
  return events.sort((a, b) => a.ts - b.ts)
}
