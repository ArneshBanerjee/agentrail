import type { IncomingEvent } from '@agentrail/core'

/**
 * A month of agent traffic for a made-up payments API called Ledgerly, for the demo workspace and
 * for screenshots. Seeded, so every run makes the same month.
 */

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

type Agent = { ua: string; mcp?: string; weight: number; skill: number; accept?: string }

const AGENTS: Agent[] = [
  { ua: 'Cursor/1.7.38 (darwin arm64)', mcp: 'cursor', weight: 40, skill: 0.62 },
  { ua: 'codex_cli_rs/0.46.0 (Mac OS 15.0; arm64)', mcp: 'codex-mcp-client', weight: 25, skill: 0.7 },
  { ua: 'Claude-User (claude-code/2.1.90; +https://support.anthropic.com/)', mcp: 'claude-code', weight: 18, skill: 0.72, accept: 'text/markdown, text/html;q=0.8' },
  { ua: 'python-requests/2.32.3', weight: 9, skill: 0.35, accept: 'text/markdown' },
  { ua: '', weight: 4, skill: 0.3 },
  { ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)', weight: 3, skill: 0.5 },
  { ua: 'GeminiCLI/0.9.0 (darwin; arm64)', mcp: 'gemini-cli-mcp-client', weight: 1, skill: 0.55 },
]

type Intent = { group: string; tasks: string[]; amount: [number, number]; docs: string[]; endpoint: string }

const INTENTS: Intent[] = [
  {
    group: 'subscriptions',
    tasks: [
      'Bill API calls at $0.002 each with usage-based billing.',
      'Set up usage-based billing with meter events for our API.',
      'Create a monthly subscription with a 14 day trial for the Pro plan.',
      'Charge customers per seat on a monthly subscription.',
    ],
    amount: [2900, 14900],
    docs: ['/docs/billing/usage', '/docs/subscriptions', '/docs/api-keys'],
    endpoint: '/v1/meters',
  },
  {
    group: 'checkout',
    tasks: [
      'Set up a Checkout session for a one-time €120 payment and return the URL.',
      'Add a pay button to my Next.js store that opens a hosted checkout.',
      'Create a payment link for a $49 ebook.',
    ],
    amount: [4900, 12000],
    docs: ['/docs/checkout', '/docs/checkout/sessions', '/docs/api-keys'],
    endpoint: '/v1/checkout/sessions',
  },
  {
    group: 'refunds',
    tasks: [
      'Refund the last charge for cus_8x2Lk and let them know by email.',
      'Refund half of order 1042 to the original card.',
    ],
    amount: [900, 2900],
    docs: ['/docs/refunds', '/docs/api-keys'],
    endpoint: '/v1/refunds',
  },
  {
    group: 'webhooks',
    tasks: ['Listen for successful payments with a webhook and mark the order paid.', 'Verify webhook signatures in my Express server.'],
    amount: [2900, 4900],
    docs: ['/docs/webhooks', '/docs/webhooks/signatures'],
    endpoint: '/v1/webhook_endpoints',
  },
  {
    group: 'payouts',
    tasks: ['Send weekly payouts to my sellers in India.', 'Split a payment between two sellers on my marketplace.'],
    amount: [9900, 29900],
    docs: ['/docs/connect', '/docs/payouts', '/docs/api-keys'],
    endpoint: '/v1/transfers',
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
    const at = i < 4 ? options.now - between(20, 200) * 1000 : start + Math.pow(rand(), 0.8) * (days * 86_400_000 - 3_600_000)
    let t = Math.round(at)
    const ip = `198.51.${100 + (i % 50)}.${(i * 7) % 250}`
    const hint = `cli-${i}`
    const account = `acct_${1000 + i}`
    const base = { ...(agent.ua ? { userAgent: agent.ua } : {}), ip }
    const push = (e: Omit<IncomingEvent, 'id' | 'ts'>, gapSec: [number, number] = [2, 20]) => {
      t += between(gapSec[0], gapSec[1]) * 1000
      events.push({ id: id(), ts: t, ...e } as IncomingEvent)
    }
    const read = (path: string, status = 200, extra: Partial<IncomingEvent> = {}) =>
      push({ source: 'http', kind: 'request', method: 'GET', host: 'docs.ledgerly.dev', path, status, contentType: path.endsWith('.txt') || path.endsWith('.md') ? 'text/markdown' : 'text/html; charset=utf-8', ...(agent.accept ? { accept: agent.accept } : {}), ...base, ...extra })

    // How it found the product.
    const via = rand()
    if (via < 0.24) read('/llms.txt')
    else if (via < 0.48) read(pick(intent.docs), 200, { referrer: pick(SEARCH_REFERRERS) })
    else if (via < 0.6) push({ source: 'track', kind: 'search', text: pick(intent.tasks).replace(/\.$/, '').toLowerCase().split(' ').slice(0, 5).join(' '), ...base })
    else if (via < 0.7) read('/docs', 200, { referrer: pick(COMPARISON) })
    else if (via < 0.8) read('/sitemap.xml')
    else if (agent.mcp && via < 0.88) push({ source: 'mcp', kind: 'mcp_connect', mcpClient: agent.mcp, sessionHint: hint, ...base })
    else read('/docs')

    const task = pick(intent.tasks)
    if (chance(0.63)) push({ source: 'intake', kind: 'intent', text: task, ...base, ...(agent.mcp ? { sessionHint: hint } : {}) }, [1, 3])

    // Reading the docs. A guessed path that does not exist, and markdown asked for and HTML given.
    if (intent.group === 'subscriptions' && chance(0.3)) read('/docs/usage-billing', 404)
    for (const path of intent.docs.slice(0, between(1, intent.docs.length))) read(path)
    if (agent.accept && chance(0.25)) read('/docs/quickstart', 200)

    if (!chance(0.62 + agent.skill * 0.15)) continue
    push({ source: 'track', kind: 'step', step: 'installed', text: chance(0.7) ? 'npm install @ledgerly/node' : 'pip install ledgerly', sessionHint: hint, ...base }, [10, 40])

    if (chance(0.09)) {
      push({ source: 'track', kind: 'step', step: 'signin_started', text: 'ledgerly login (waiting for browser approval)', sessionHint: hint, ...base }, [5, 15])
      continue
    }
    if (!chance(0.85)) continue
    push({ source: 'track', kind: 'step', step: 'signed_in', text: 'ledgerly login, approved by a person', sessionHint: hint, accountId: account }, [15, 60])
    if (agent.mcp && chance(0.3)) push({ source: 'mcp', kind: 'mcp_connect', mcpClient: agent.mcp, sessionHint: hint, accountId: account }, [3, 10])

    const api = (path: string, status: number, error?: string) =>
      push({ source: 'http', kind: 'request', method: 'POST', host: 'api.ledgerly.dev', path, status, ...(error ? { error } : {}), accountId: account, ...base }, [5, 25])

    // The documented header is wrong in the API keys guide, and agents that read it copy it.
    const readKeysGuide = intent.docs.includes('/docs/api-keys')
    if (readKeysGuide && chance(0.55 - agent.skill * 0.25)) {
      api(intent.endpoint, 401, 'X-Api-Key rejected')
      if (chance(0.6)) {
        read('/docs/api-keys')
        api(intent.endpoint, 401, 'X-Api-Key rejected')
      }
      if (chance(0.75)) continue
    }
    if (agent.mcp && chance(0.06)) {
      push({ source: 'mcp', kind: 'mcp_tool', tool: 'create_meter_event', ok: false, error: 'missing field: event_name', sessionHint: hint, accountId: account, mcpClient: agent.mcp }, [3, 10])
      if (chance(0.7)) continue
    }
    api(intent.endpoint, 200)
    push({ source: 'track', kind: 'step', step: 'first_api_call', sessionHint: hint, accountId: account }, [0, 1])

    // A real card in test mode is declined, and agents rarely know the test card numbers.
    if (chance(0.16)) {
      push({ source: 'stripe', kind: 'payment', ok: false, error: 'card_declined: live card used in test mode', accountId: account, currency: 'usd' }, [20, 90])
      if (chance(0.8)) continue
    }
    if (!chance(0.72)) continue
    const amount = between(intent.amount[0], intent.amount[1])
    push({ source: 'stripe', kind: 'payment', amount, currency: 'usd', accountId: account }, [600, 7200])
    const renewal = t + 30 * 86_400_000
    if (renewal < options.now && chance(0.85)) events.push({ id: id(), ts: renewal, source: 'stripe', kind: 'payment', amount, currency: 'usd', accountId: account } as IncomingEvent)
    else if (chance(0.45)) push({ source: 'stripe', kind: 'payment', amount, currency: 'usd', accountId: account }, [86_400, 5 * 86_400])
  }
  return events.filter((e) => e.ts <= options.now).sort((a, b) => a.ts - b.ts)
}
