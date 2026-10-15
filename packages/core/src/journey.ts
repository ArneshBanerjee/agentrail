import { attribute, strongest, type Attribution } from './attribution.ts'
import type { AgentRule } from './agents.ts'
import { AGENTS } from './agents.ts'
import type { StoredEvent } from './events.ts'
import { DEFAULT_FUNNEL, reachedSteps, type FunnelStep } from './funnel.ts'
import { looksLikeApi, normalizePath } from './paths.ts'
import { isDownload } from './steps.ts'

export type BlockerKind =
  /** An API call failed: a 4xx or 5xx on an API path, or a step tracked with `ok: false`. */
  | 'failed_call'
  /** A page or docs file that does not exist. */
  | 'not_found'
  /** The agent asked for markdown and got HTML. */
  | 'markdown_served_html'
  | 'mcp_tool_error'
  | 'payment_failed'
  /** Sign-in started and waited for a person who never came. */
  | 'human_signin'

export type Blocker = {
  readonly kind: BlockerKind
  /** Same key, same problem. Fixes are grouped by it. */
  readonly key: string
  readonly at: number
  readonly eventId: string
  readonly detail: string
  readonly path?: string
  readonly status?: number
  readonly tool?: string
  /** The last page the agent read before this happened. Usually the page a fix must edit. */
  readonly after?: string
}

export type Discovery = {
  /** How the agent found the product, in words a person would use. */
  readonly via: string
  readonly detail?: string
}

export type Session = {
  readonly id: string
  readonly siteId: string
  readonly agent: Attribution
  readonly startedAt: number
  readonly endedAt: number
  readonly events: readonly StoredEvent[]
  readonly accountIds: readonly string[]
  readonly discovery: Discovery
  readonly landingPath?: string
  readonly intent?: string
  /**
   * When the agent stated no task: the docs it read, as a guess at the task. Kept apart from
   * `intent` so intent groups and their numbers only count what agents said.
   */
  readonly inferredIntent?: string
  /** How the task reached the product: "docs finder", "intake endpoint", "MCP", "your product". */
  readonly intentVia?: string
  readonly searches: readonly string[]
  /** Step id to the time it was reached. */
  readonly reached: Readonly<Record<string, number>>
  /** The first funnel step not reached, if any. */
  readonly stoppedAt?: string
  readonly blockers: readonly Blocker[]
  /** The blocker after the last step reached: what most likely ended the journey. */
  readonly stoppedBy?: Blocker
  readonly revenue: number
  readonly currency?: string
  readonly payments: number
  readonly mcpConnected: boolean
  readonly runId?: string
}

export type SessionOptions = {
  readonly funnel?: readonly FunnelStep[]
  readonly rules?: readonly AgentRule[]
  /** A gap longer than this starts a new session. */
  readonly gapMs?: number
  /** How long after a session a payment still counts for it. */
  readonly paymentWindowMs?: number
  readonly includeCrawlers?: boolean
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/**
 * Join raw events into one journey per agent session.
 *
 * Events are joined through what they share: an address hash, a session hint (an MCP session, a CLI
 * login), or an account id. That is how a docs read from one host, an install reported by a CLI and
 * a payment from Stripe end up in the same journey. Payments are attached afterwards to the latest
 * session that came before them, because a payment can arrive days after the agent left.
 *
 * A group with no agent signal at all is a person, and it is dropped here, not stored as an agent.
 */
export const buildSessions = (events: readonly StoredEvent[], options: SessionOptions = {}): Session[] => {
  const funnel = options.funnel ?? DEFAULT_FUNNEL
  const rules = options.rules ?? AGENTS
  const gap = options.gapMs ?? 30 * MINUTE
  const window = options.paymentWindowMs ?? 30 * DAY

  const attributionOf = new Map<string, Attribution | undefined>()
  const relevant: StoredEvent[] = []
  for (const e of events) {
    const a = attribute(
      { userAgent: e.userAgent, mcpClient: e.mcpClient, mcpClientVersion: e.mcpClientVersion, verifiedOperator: e.verifiedOperator, accept: e.accept, path: e.path },
      rules,
    )
    attributionOf.set(e.id, a)
    // A request from a person carries nothing an agent journey needs. Product events are kept even
    // without a name, because they are how a journey learns it reached a step.
    if (e.kind === 'request' && !a) continue
    if (a?.kind === 'crawler' && !options.includeCrawlers) continue
    relevant.push(e)
  }

  const groups = joinByIdentity(relevant)
  const sessions: Session[] = []
  for (const group of groups) {
    const sorted = [...group].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
    const payments = sorted.filter((e) => e.kind === 'payment')
    const activity = sorted.filter((e) => e.kind !== 'payment')

    const chunks: StoredEvent[][] = []
    for (const e of activity) {
      const last = chunks.at(-1)
      if (last && e.ts - last.at(-1)!.ts <= gap) last.push(e)
      else chunks.push([e])
    }
    for (const p of payments) {
      const owner = [...chunks].reverse().find((c) => c[0]!.ts <= p.ts && p.ts - c.at(-1)!.ts <= window)
      owner?.push(p)
    }
    for (const chunk of chunks) {
      chunk.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
      const agent = strongest(chunk.map((e) => attributionOf.get(e.id)))
      if (!agent) continue
      sessions.push(toSession(chunk, agent, funnel))
    }
  }
  return sessions.sort((a, b) => b.startedAt - a.startedAt)
}

/** Union-find over identities. Two events share a session group if they share any identity. */
const joinByIdentity = (events: readonly StoredEvent[]): StoredEvent[][] => {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    let node = x
    while (node !== root) {
      const next = parent.get(node)!
      parent.set(node, root)
      node = next
    }
    return root
  }
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x)
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  // Accounts used inside a test run. Their other events (a sign-in, a payment from the product) join
  // the run through the account only, never through an address that real traffic shares.
  const runAccounts = new Set(events.flatMap((e) => (e.runId && e.accountId ? [`${e.siteId}:${e.accountId}`] : [])))

  const idsOf = (e: StoredEvent): string[] => {
    // A test run is its own world. Joining it to real traffic through a shared address would put
    // the runner's sessions in the live funnel.
    // An account a test run signed up with belongs to that run, so its payments join the run too.
    if (e.runId) return e.accountId ? [`run:${e.runId}`, `acct:${e.siteId}:${e.accountId}`] : [`run:${e.runId}`]
    if (e.accountId && runAccounts.has(`${e.siteId}:${e.accountId}`)) return [`acct:${e.siteId}:${e.accountId}`]
    const ids: string[] = []
    if (e.sessionHint) ids.push(`hint:${e.siteId}:${e.sessionHint}`)
    if (e.accountId) ids.push(`acct:${e.siteId}:${e.accountId}`)
    if (e.ipHash) ids.push(`ip:${e.siteId}:${e.ipHash}`)
    if (ids.length === 0) ids.push(`event:${e.id}`)
    return ids
  }

  const firstIdOf = new Map<string, string>()
  for (const e of events) {
    const ids = idsOf(e)
    for (const id of ids) add(id)
    for (const id of ids.slice(1)) union(ids[0]!, id)
    firstIdOf.set(e.id, ids[0]!)
  }
  const groups = new Map<string, StoredEvent[]>()
  for (const e of events) {
    const root = find(firstIdOf.get(e.id)!)
    const g = groups.get(root)
    if (g) g.push(e)
    else groups.set(root, [e])
  }
  return [...groups.values()]
}

/** `URL` is a host global, and `core` uses only the language. The three parts needed are enough. */
const parseUrl = (raw: string): { hostname: string; pathname: string; search: string } | undefined => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)(?::\d+)?([^?#]*)(\?[^#]*)?/i.exec(raw)
  if (!m) return undefined
  return { hostname: m[1]!.toLowerCase(), pathname: m[2] || '/', search: m[3] ?? '' }
}

const SEARCH_ENGINES = /(^|\.)(google|bing|duckduckgo|yahoo|brave|kagi|ecosia|baidu|yandex|perplexity|chatgpt|you)\.[a-z.]+$/i

export const discover = (first: StoredEvent): Discovery => {
  if (first.kind === 'mcp_connect' || first.kind === 'mcp_tool') return { via: 'your MCP server' }
  if (first.kind === 'intent' && first.source === 'intake') return { via: 'docs finder' }
  if (first.kind === 'search') return { via: 'your docs search' }
  const path = first.path ?? ''
  if (path.startsWith('/llms')) return { via: 'llms.txt', detail: path }
  if (path === '/sitemap.xml') return { via: 'sitemap.xml' }
  if (path.startsWith('/.well-known/')) return { via: 'a well-known file', detail: path }
  if (first.referrer) {
    const ref = parseUrl(first.referrer)
    if (ref) {
      if (SEARCH_ENGINES.test(ref.hostname)) return { via: 'a search result', detail: ref.hostname }
      if (/(?:^|[/-])(vs|versus|compare|comparison|alternatives?)(?:[/-]|$)/i.test(ref.pathname)) {
        return { via: 'a comparison page', detail: `${ref.hostname}${ref.pathname}` }
      }
      if (first.host && ref.hostname === first.host && /search/i.test(ref.pathname + ref.search)) {
        return { via: 'your docs search' }
      }
      return { via: `a link on ${ref.hostname}`, detail: first.referrer }
    }
  }
  if (first.kind === 'step' || first.kind === 'identify') return { via: 'your product', detail: first.step ?? first.kind }
  return { via: 'a direct visit' }
}

/** A search typed into the product, or a query string on a search page. */
const searchText = (e: StoredEvent): string | undefined => {
  if (e.kind === 'search') return e.text
  if (e.kind !== 'request' || !e.query || !/search/i.test(e.path ?? '')) return undefined
  const match = /(?:^|&|\?)(?:q|query|search|term)=([^&]*)/i.exec(e.query)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1]!.replaceAll('+', ' '))
  } catch {
    return match[1]
  }
}

export const findBlockers = (events: readonly StoredEvent[]): Blocker[] => {
  const blockers: Blocker[] = []
  const signinStarted: StoredEvent[] = []
  let lastRead: string | undefined
  const push = (b: Blocker) => blockers.push(lastRead ? { ...b, after: lastRead } : b)
  for (const e of events) {
    const path = e.path ? normalizePath(e.path) : undefined
    // A sign-in poll that answers "pending" is waiting for a person, not failing. RFC 8628 answers
    // it with 400 and many APIs with 428; a sign-in nobody approves shows up as human_signin.
    const pendingPoll = e.kind === 'request' && (e.status === 400 || e.status === 428) && /\/(device\/(poll|token)|oauth\/token)$/.test(e.path ?? '')
    if (e.kind === 'request' && e.status !== undefined && e.status >= 400 && !pendingPoll) {
      const api = looksLikeApi(e.path ?? '', e.host)
      if (e.status === 404 && !api) {
        push({ kind: 'not_found', key: `not_found:${path}`, at: e.ts, eventId: e.id, detail: `${path} returned 404`, ...(path ? { path } : {}), status: 404 })
      } else if (api || e.status >= 500 || e.method !== 'GET') {
        const method = e.method ?? 'GET'
        // One wrong header in one guide fails every endpoint an agent tries. Auth failures with the
        // same error are one problem, whatever the endpoint.
        const auth = (e.status === 401 || e.status === 403) && e.error
        push({
          kind: 'failed_call',
          key: auth ? `failed_call:auth:${e.status}:${e.error}` : `failed_call:${method} ${path}:${e.status}`,
          at: e.ts,
          eventId: e.id,
          detail: `${method} ${path} returned ${e.status}${e.error ? `: ${e.error}` : ''}`,
          ...(path ? { path } : {}),
          status: e.status,
        })
      }
    }
    if (
      e.kind === 'request' &&
      e.accept && /text\/(?:x-)?markdown/i.test(e.accept) && !/text\/html/i.test(e.accept.split(',')[0] ?? '') &&
      e.contentType && /text\/html/i.test(e.contentType)
    ) {
      push({ kind: 'markdown_served_html', key: `markdown_served_html:${path}`, at: e.ts, eventId: e.id, detail: `Asked for markdown at ${path} and got HTML`, ...(path ? { path } : {}) })
    }
    if (e.kind === 'step' && e.ok === false) {
      push({ kind: 'failed_call', key: `failed_step:${e.step}`, at: e.ts, eventId: e.id, detail: `${e.step} failed${e.error ? `: ${e.error}` : ''}` })
    }
    if (e.kind === 'mcp_tool' && (e.ok === false || e.error)) {
      push({ kind: 'mcp_tool_error', key: `mcp_tool_error:${e.tool}`, at: e.ts, eventId: e.id, detail: `MCP tool ${e.tool} failed${e.error ? `: ${e.error}` : ''}`, ...(e.tool ? { tool: e.tool } : {}) })
    }
    if (e.kind === 'payment' && e.ok === false) {
      push({ kind: 'payment_failed', key: `payment_failed:${e.error ?? 'declined'}`, at: e.ts, eventId: e.id, detail: `Payment failed${e.error ? `: ${e.error}` : ''}` })
    }
    // A device sign-in is visible in HTTP alone: started, then a poll or token call that succeeds.
    const ok = (e.status ?? 200) < 400
    if ((e.kind === 'step' && e.step === 'signin_started') || (e.kind === 'request' && ok && /\/device\/(start|code)$/.test(e.path ?? ''))) signinStarted.push(e)
    // The page an agent last read, for a fix to edit. Downloads and API reads are not pages.
    if (e.kind === 'request' && (e.method ?? 'GET') === 'GET' && ok && path && !looksLikeApi(e.path ?? '', e.host) && !isDownload(e.path ?? '')) lastRead = path
    if ((e.kind === 'step' && e.step === 'signed_in') || (e.kind === 'request' && ok && e.method === 'POST' && /\/(device\/(poll|token)|oauth\/token)$/.test(e.path ?? ''))) signinStarted.length = 0
  }
  for (const e of signinStarted) {
    push({ kind: 'human_signin', key: 'human_signin', at: e.ts, eventId: e.id, detail: 'Sign-in started and waited for a person' })
  }
  return blockers.sort((a, b) => a.at - b.at)
}

/** Pages every journey reads, which say nothing about the task. */
const GENERIC_PAGE = /^\/docs\/?$|^\/docs\/(quickstart|getting-started|introduction|overview|index|sign-?in|login|auth(entication)?|api-?keys?|keys|cli|sdk)\/?$/i

/** "/docs/billing/usage-based" becomes "Billing › Usage based". */
export const inferIntent = (events: readonly StoredEvent[]): string | undefined => {
  const pages = events.filter((e) => e.kind === 'request' && (e.method ?? 'GET') === 'GET' && (e.status ?? 200) < 400 && /^\/docs\/./.test(e.path ?? '') && !GENERIC_PAGE.test(e.path ?? ''))
  const page = pages[0]?.path
  if (!page) return undefined
  return page
    .replace(/^\/docs\//, '')
    .replace(/\.(md|mdx|html)$/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      const words = part.replace(/[-_]+/g, ' ')
      return words.charAt(0).toUpperCase() + words.slice(1)
    })
    .join(' › ')
}

const toSession = (events: readonly StoredEvent[], agent: Attribution, funnel: readonly FunnelStep[]): Session => {
  const first = events[0]!
  const last = events.at(-1)!
  const reachedMap = reachedSteps(events, funnel)
  const reached = Object.fromEntries(reachedMap)
  // An independent step such as MCP connected is never where a journey stopped.
  const stoppedAt = funnel.find((s) => !s.independent && !reachedMap.has(s.id))?.id
  const blockers = findBlockers(events)
  const lastReachedAt = Math.max(...funnel.filter((s) => !s.independent && reachedMap.has(s.id)).map((s) => reachedMap.get(s.id)!))
  const stoppedBy = stoppedAt ? blockers.filter((b) => b.at >= lastReachedAt).at(-1) ?? blockers.at(-1) : undefined
  const paid = events.filter((e) => e.kind === 'payment' && e.ok !== false)
  const accountIds = [...new Set(events.flatMap((e) => (e.accountId ? [e.accountId] : [])))]
  const landing = events.find((e) => e.kind === 'request' && e.path)?.path
  const intent = events.find((e) => e.kind === 'intent' && e.text)?.text
  const inferredIntent = intent ? undefined : inferIntent(events)
  const intentEvent = events.find((e) => e.kind === 'intent' && e.text)
  const intentVia = !intentEvent
    ? undefined
    : intentEvent.source === 'mcp'
      ? 'MCP'
      : intentEvent.source === 'intake'
        ? intentEvent.path?.includes('/docs/find') ? 'docs finder' : 'intake endpoint'
        : 'your product'
  const searches = events.flatMap((e) => {
    const s = searchText(e)
    return s ? [s] : []
  })
  const currency = paid.find((e) => e.currency)?.currency
  const runId = events.find((e) => e.runId)?.runId
  return {
    id: first.id,
    siteId: first.siteId,
    agent,
    startedAt: first.ts,
    endedAt: last.ts,
    events,
    accountIds,
    discovery: discover(first),
    ...(landing ? { landingPath: landing } : {}),
    ...(intent ? { intent } : {}),
    ...(inferredIntent ? { inferredIntent } : {}),
    ...(intentVia ? { intentVia } : {}),
    searches,
    reached,
    ...(stoppedAt ? { stoppedAt } : {}),
    blockers,
    ...(stoppedBy ? { stoppedBy } : {}),
    revenue: paid.reduce((sum, e) => sum + (e.amount ?? 0), 0),
    ...(currency ? { currency } : {}),
    payments: paid.length,
    mcpConnected: events.some((e) => e.kind === 'mcp_connect'),
    ...(runId ? { runId } : {}),
  }
}
