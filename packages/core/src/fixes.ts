import type { Blocker, BlockerKind, Session } from './journey.ts'

/**
 * A problem found in many journeys, with what it costs and what would fix it.
 *
 * The cost is stated as two numbers on purpose. `sessionsLost` is observed: these sessions stopped
 * here. `monthlyValueAtRisk` is an estimate: those sessions, times the share of sessions that got
 * past this step and went on to pay, times what a paying session is worth. The dashboard labels the
 * first "observed" and the second "estimated", because they are not the same kind of number.
 */
export type FixCandidate = {
  readonly key: string
  readonly kind: BlockerKind
  /** What to do, as an instruction: "Fix the authentication sample in the API keys guide". */
  readonly action: string
  /** What is wrong: "Agents fail auth: X-Api-Key rejected". */
  readonly title: string
  /** What is wrong with the page, for a heading: "Wrong auth header in the API keys guide". */
  readonly problem: string
  /** What agents did, after the number: "failed at their first API call". */
  readonly failedAt: string
  /** Why, after the page: "its authentication sample does not work". A drafted fix says it better. */
  readonly cause: string
  readonly detail: string
  readonly path?: string
  readonly tool?: string
  readonly status?: number
  /** The page most of these agents read just before the problem. */
  readonly sourcePage?: string
  /** A short name for where the fix goes: "API keys guide", "/docs/quickstart", "create_meter_event". */
  readonly where?: string
  /** Endpoints or paths this problem showed up on. */
  readonly paths: readonly string[]
  readonly sessionsLost: number
  /**
   * Of all sessions that stopped before the same step, the share this problem explains. "52% of the
   * drop before the first payment comes from one page."
   */
  readonly dropShare: number
  /** Sessions that hit this blocker, whether or not it stopped them. */
  readonly sessionsAffected: number
  /** The funnel step these sessions never reached. */
  readonly beforeStep?: string
  readonly conversionPast: number
  readonly revenuePerConversion: number
  readonly monthlyValueAtRisk: number
  readonly sessionIds: readonly string[]
  /** Every session that hit this problem, including the ones that got past it. */
  readonly affectedSessionIds: readonly string[]
  readonly byAgent: Readonly<Record<string, number>>
  readonly proposal: Proposal
}

/** What to change. `patch` is set when a rule can write the change without a model. */
export type Proposal = {
  readonly summary: string
  readonly patch?: { readonly file: string; readonly content: string }
  /** True when a model should draft the change against the real source file. */
  readonly needsDraft: boolean
}

const DAY = 86_400_000

const TITLES: Record<BlockerKind, (b: Blocker) => string> = {
  failed_call: (b) =>
    b.status === 401 || b.status === 403
      ? b.key.startsWith('failed_call:auth:')
        ? `Agents fail auth: ${b.detail.split(': ').slice(1).join(': ') || b.status}`
        : `Agents fail auth on ${b.path ?? 'an API call'}`
      : `API call fails: ${b.detail}`,
  not_found: (b) => `Agents look for ${b.path} and it does not exist`,
  markdown_served_html: (b) => `Markdown reader got HTML at ${b.path}`,
  mcp_tool_error: (b) => `MCP tool ${b.tool} fails`,
  payment_failed: () => 'Payments fail for agents',
  human_signin: () => 'Sign-in waits for a person',
}

export type RankOptions = {
  readonly conversionStep?: string
  /** Length of the window the sessions cover, to turn a count into a monthly figure. */
  readonly windowMs: number
  /** Paths that answered 200 in this window. A missing page is matched against them. */
  readonly knownPaths?: readonly string[]
}

export const rankFixes = (sessions: readonly Session[], options: RankOptions): FixCandidate[] => {
  const conversionStep = options.conversionStep ?? 'first_payment'
  const converted = sessions.filter((s) => conversionStep in s.reached)
  const revenuePerConversion = converted.length === 0 ? 0 : converted.reduce((sum, s) => sum + s.revenue, 0) / converted.length
  const months = Math.max(options.windowMs, DAY) / (30 * DAY)

  const groups = new Map<string, { blocker: Blocker; lost: Session[]; affected: Set<string>; after: Map<string, number>; paths: Set<string> }>()
  for (const s of sessions) {
    for (const b of s.blockers) {
      const g = groups.get(b.key) ?? { blocker: b, lost: [], affected: new Set<string>(), after: new Map<string, number>(), paths: new Set<string>() }
      g.affected.add(s.id)
      if (b.after) g.after.set(b.after, (g.after.get(b.after) ?? 0) + 1)
      if (b.path) g.paths.add(b.path)
      groups.set(b.key, g)
    }
    if (s.stoppedBy && !(conversionStep in s.reached)) groups.get(s.stoppedBy.key)?.lost.push(s)
  }

  // The drop before each step, so a fix can say what share of it is its own.
  const dropBefore = new Map<string, number>()
  for (const s of sessions) if (s.stoppedAt && !(conversionStep in s.reached)) dropBefore.set(s.stoppedAt, (dropBefore.get(s.stoppedAt) ?? 0) + 1)

  const candidates: FixCandidate[] = []
  for (const [key, g] of groups) {
    const stepCounts = new Map<string, number>()
    for (const s of g.lost) if (s.stoppedAt) stepCounts.set(s.stoppedAt, (stepCounts.get(s.stoppedAt) ?? 0) + 1)
    const beforeStep = [...stepCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const pastStep = beforeStep ? sessions.filter((s) => beforeStep in s.reached) : []
    const conversionPast = pastStep.length === 0 ? 0 : pastStep.filter((s) => conversionStep in s.reached).length / pastStep.length
    const byAgent: Record<string, number> = {}
    for (const s of g.lost) byAgent[s.agent.name] = (byAgent[s.agent.name] ?? 0) + 1
    const b = g.blocker
    const sourcePage = [...g.after.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
    const target = b.kind === 'not_found' && b.path ? closestPath(b.path, options.knownPaths ?? []) : undefined
    candidates.push({
      key,
      kind: b.kind,
      action: actionFor(b, sourcePage, target),
      title: TITLES[b.kind](b),
      ...wordsFor(b, sourcePage),
      detail: b.detail,
      ...(b.path ? { path: b.path } : {}),
      ...(b.tool ? { tool: b.tool } : {}),
      ...(b.status ? { status: b.status } : {}),
      ...(sourcePage ? { sourcePage } : {}),
      ...(whereOf(b, sourcePage) ? { where: whereOf(b, sourcePage)! } : {}),
      paths: [...g.paths],
      sessionsLost: g.lost.length,
      dropShare: beforeStep && dropBefore.get(beforeStep) ? (stepCounts.get(beforeStep) ?? 0) / dropBefore.get(beforeStep)! : 0,
      sessionsAffected: g.affected.size,
      ...(beforeStep ? { beforeStep } : {}),
      conversionPast,
      revenuePerConversion,
      monthlyValueAtRisk: Math.round((g.lost.length * conversionPast * revenuePerConversion) / months),
      sessionIds: g.lost.map((s) => s.id),
      affectedSessionIds: [...g.affected],
      byAgent,
      proposal: propose(b, options.knownPaths ?? [], sourcePage),
    })
  }
  return candidates.sort(
    (a, b) => b.monthlyValueAtRisk - a.monthlyValueAtRisk || b.sessionsLost - a.sessionsLost || b.sessionsAffected - a.sessionsAffected,
  )
}

/** "/docs/api-keys" as a heading: "API keys guide". */
export const pageTitle = (path: string) => {
  const name = pageName(path).replace(/^the /, '')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** "/docs/api-keys" reads better as "the API keys guide" in a sentence. */
export const pageName = (path: string) => {
  const last = path.split('/').filter(Boolean).at(-1)
  const words = last?.replace(/\.(md|mdx|html)$/, '').split(/[-_]+/).map((w) => (/^(api|sdk|cli|mcp|url|id|oauth)$/i.test(w) ? w.toUpperCase().replace('OAUTH', 'OAuth') : w))
  return words ? `the ${words.join(' ')} guide` : 'the docs'
}

/** The words a person reads about a problem, so the dialog states it the same way every time. */
const wordsFor = (b: Blocker, sourcePage: string | undefined): { problem: string; failedAt: string; cause: string } => {
  const page = sourcePage ? pageName(sourcePage) : 'the docs'
  switch (b.kind) {
    case 'failed_call':
      return b.status === 401 || b.status === 403
        ? { problem: `Wrong auth example in ${page}`, failedAt: b.firstCall ? 'failed at their first API call' : 'failed at an API call', cause: 'its authentication sample is not what the API accepts' }
        : { problem: `Broken ${b.path ?? 'API'} example in ${page}`, failedAt: b.firstCall ? 'failed at their first API call' : 'failed at an API call', cause: `its example for ${b.path ?? 'the call'} fails with ${b.status ?? 'an error'}` }
    case 'not_found':
      return { problem: `Agents guess ${b.path}, which does not exist`, failedAt: 'hit a page that does not exist', cause: 'agents expect a page here' }
    case 'markdown_served_html':
      return { problem: `${b.path} has no markdown for agents`, failedAt: 'asked for markdown and got HTML', cause: 'it answers markdown requests with HTML' }
    case 'mcp_tool_error':
      return { problem: `The ${b.tool} tool does not say what it needs`, failedAt: `failed on the ${b.tool} MCP tool`, cause: 'its description and schema leave out what the tool needs' }
    case 'payment_failed':
      return { problem: 'Test mode and test cards are not documented', failedAt: 'had a payment declined', cause: 'agents use a real card in test mode' }
    case 'human_signin':
      return { problem: 'Sign-in needs a person agents cannot reach', failedAt: 'waited for a sign-in nobody approved', cause: 'sign-in waits for a person to approve it' }
  }
}

const whereOf = (b: Blocker, sourcePage: string | undefined) =>
  b.kind === 'failed_call' && sourcePage ? pageTitle(sourcePage) : b.kind === 'mcp_tool_error' ? b.tool : b.kind === 'human_signin' || b.kind === 'payment_failed' ? undefined : b.path

const actionFor = (b: Blocker, sourcePage: string | undefined, target: string | undefined): string => {
  switch (b.kind) {
    case 'failed_call':
      return b.status === 401 || b.status === 403
        ? `Fix the authentication sample in ${sourcePage ? pageName(sourcePage) : 'the docs'}`
        : `Fix the ${b.path ?? 'API'} example in ${sourcePage ? pageName(sourcePage) : 'the docs'}`
    case 'not_found':
      return target ? `Redirect ${b.path} to ${target}` : `Add a page at ${b.path}`
    case 'markdown_served_html':
      return `Serve markdown at ${b.path}`
    case 'mcp_tool_error':
      return `Clarify what the ${b.tool} tool needs`
    case 'payment_failed':
      return 'Document test cards and test mode'
    case 'human_signin':
      return 'Let agents finish sign-in'
  }
}

/** Edit distance, for matching a missing page to the page the agent most likely wanted. */
export const distance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]!
}

/** The known page closest to a missing one, when it is close enough to be the same intent. */
export const closestPath = (missing: string, known: readonly string[]): string | undefined => {
  const words = (p: string) => new Set(p.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  const want = words(missing)
  let best: { path: string; score: number } | undefined
  for (const path of known) {
    if (path === missing) continue
    const have = words(path)
    const shared = [...want].filter((w) => have.has(w)).length
    const score = shared * 10 - distance(missing, path)
    if (shared > 0 && (!best || score > best.score)) best = { path, score }
  }
  return best?.path
}

const propose = (b: Blocker, knownPaths: readonly string[], sourcePage: string | undefined): Proposal => {
  switch (b.kind) {
    case 'not_found': {
      const target = b.path ? closestPath(b.path, knownPaths) : undefined
      if (!target || !b.path) return { summary: `Add a page at ${b.path}, or redirect it to the page agents need.`, needsDraft: true }
      return {
        summary: `Redirect ${b.path} to ${target}. Agents guess this path, and the page they want is ${target}.`,
        patch: { file: 'openscope.redirects.json', content: `${JSON.stringify([{ from: b.path, to: target, status: 308 }], null, 2)}\n` },
        needsDraft: false,
      }
    }
    case 'markdown_served_html':
      return {
        summary: `Serve markdown at ${b.path} when a request asks for text/markdown, or publish ${b.path}.md and list it in /llms.txt.`,
        needsDraft: true,
      }
    case 'failed_call':
      return {
        summary:
          b.status === 401 || b.status === 403
            ? `Agents send credentials the API rejects (${b.detail}). Correct the auth example in ${sourcePage ?? 'the page they read before the call'}.`
            : `Correct the example for ${b.path} in ${sourcePage ?? 'the page agents read before the call'}.`,
        needsDraft: true,
      }
    case 'mcp_tool_error':
      return { summary: `Make the description and input schema of MCP tool ${b.tool} say what it needs. ${b.detail}`, needsDraft: true }
    case 'payment_failed':
      return { summary: 'Document the test card numbers and test mode, and say which errors mean "use test mode".', needsDraft: true }
    case 'human_signin':
      return { summary: 'Offer a sign-in that an agent can finish: an API key, or a device code a person approves once.', needsDraft: true }
  }
}
