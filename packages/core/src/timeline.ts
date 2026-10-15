import type { StoredEvent } from './events.ts'
import type { FunnelStep } from './funnel.ts'
import type { Session } from './journey.ts'
import { DEFAULT_STEP_RULES, stepName, type StepRule } from './steps.ts'

export type TimelineMark = { readonly kind: 'step' | 'blocked' | 'stopped'; readonly label: string }

export type TimelineItem = {
  readonly eventId: string
  /** The plain name: "read", "sign-in started", "poll 3 / 7". */
  readonly name: string
  /** What happened on the wire, under the name: "POST /api/device/poll 200". */
  readonly detail: string
  /** The stage the agent was working towards, used as a heading: "Discovery", "Sign-in". */
  readonly phase: string
  readonly ts: number
  /** Milliseconds since the session started, for the 00:21 style column. */
  readonly offsetMs: number
  readonly text: string
  readonly kind: StoredEvent['kind']
  readonly status?: number
  readonly marks: readonly TimelineMark[]
}

const money = (amount: number | undefined, currency: string | undefined) =>
  amount === undefined ? '' : ` ${(amount / 100).toFixed(2)} ${(currency ?? '').toUpperCase()}`.trimEnd()

/** One line per event, in the words a person reads a journey in. */
export const describe = (e: StoredEvent): string => {
  switch (e.kind) {
    case 'request': {
      const method = e.method ?? 'GET'
      const where = `${e.path ?? '/'}${e.query ? `?${e.query}` : ''}`
      const failed = (e.status ?? 200) >= 400
      if (method === 'GET' && !failed) return `read ${where}`
      return `${method} ${where}${e.status ? `  ${e.status}` : ''}${e.error ? `  ${e.error}` : ''}`
    }
    case 'search':
      return `searched "${e.text ?? ''}"`
    case 'intent':
      return `task: "${e.text ?? ''}"`
    case 'step':
      return `${e.text ?? (e.step ?? 'step').replaceAll('_', ' ')}${e.ok === false ? `  failed${e.error ? `: ${e.error}` : ''}` : ''}`
    case 'identify':
      return 'linked to an account'
    case 'mcp_connect':
      return `connected to the MCP server${e.mcpClient ? ` from ${e.mcpClient}` : ''}`
    case 'mcp_tool':
      return `called ${e.tool ?? 'a tool'}${e.ok === false || e.error ? `  failed${e.error ? `: ${e.error}` : ''}` : ''}`
    case 'payment':
      return e.ok === false ? `payment failed${e.error ? `: ${e.error}` : ''}` : `paid${money(e.amount, e.currency)}`
  }
}

const wire = (e: StoredEvent): string => {
  if (e.kind === 'request') return `${e.method ?? 'GET'} ${e.path ?? '/'}${e.status ? ` ${e.status}` : ''}${e.error ? ` · ${e.error}` : ''}`
  if ((e.kind === 'intent' || e.kind === 'search') && e.path) return `${e.method ?? 'POST'} ${e.path}${e.status ? ` ${e.status}` : ''}`
  if (e.kind === 'intent' || e.kind === 'search') return `"${e.text ?? ''}"`
  if (e.kind === 'mcp_connect') return e.mcpClient ? `from ${e.mcpClient}${e.mcpClientVersion ? ` ${e.mcpClientVersion}` : ''}` : ''
  return describe(e)
}

const PHASE_DEFAULTS: Record<string, string> = { discovered: 'Discovery', evaluated: 'Discovery', installed: 'Discovery', signed_in: 'Sign-in' }
const phaseOf = (step: FunnelStep) => step.phase ?? PHASE_DEFAULTS[step.id] ?? step.label

/**
 * The journey as a person reads it: plain names, grouped by the stage the agent was working
 * towards, with repeated polls counted ("poll 3 / 7") and, once the session is over, how it ended.
 */
export const timeline = (
  session: Session,
  funnel: readonly FunnelStep[],
  options: { readonly rules?: readonly StepRule[]; readonly live?: boolean; readonly conversionStep?: string } = {},
): TimelineItem[] => {
  const rules = options.rules ?? DEFAULT_STEP_RULES
  const chain = funnel.filter((s) => !s.independent)
  const names = session.events.map((e) => stepName(e, rules))
  // Number each run of consecutive polls, so a wait for approval reads as one counted thing.
  const counted = names.map((name, i) => {
    if (name !== 'poll') return name
    let start = i
    while (start > 0 && names[start - 1] === 'poll') start--
    let end = i
    while (end < names.length - 1 && names[end + 1] === 'poll') end++
    return end > start ? `poll ${i - start + 1} / ${end - start + 1}` : name
  })
  const blocked = new Set(session.blockers.map((b) => b.eventId))
  // A step is marked on the first event at its time. Steps implied by a later one have no event of
  // their own and are not marked, so the timeline shows only what happened.
  const stepAt = new Map<number, string[]>()
  for (const step of funnel) {
    if (step.match.some((m) => m.any)) continue
    const at = session.reached[step.id]
    if (at === undefined) continue
    const owner = session.events.find((e) => e.ts === at)
    if (!owner) continue
    const list = stepAt.get(at) ?? []
    list.push(step.label)
    stepAt.set(at, list)
  }
  const marked = new Set<number>()
  const last = session.events.at(-1)
  const items: TimelineItem[] = session.events.map((e, index) => {
    const marks: TimelineMark[] = []
    if (!marked.has(e.ts)) {
      for (const label of stepAt.get(e.ts) ?? []) marks.push({ kind: 'step', label })
      if (stepAt.has(e.ts)) marked.add(e.ts)
    }
    if (blocked.has(e.id)) marks.push({ kind: 'blocked', label: 'Blocked' })
    if (session.stoppedAt && e === last) marks.push({ kind: 'stopped', label: 'Stopped' })
    const goal = chain.find((s) => session.reached[s.id] === undefined || session.reached[s.id]! >= e.ts) ?? chain.at(-1)
    return {
      eventId: e.id,
      name: counted[index]!,
      detail: wire(e),
      phase: goal ? phaseOf(goal) : 'Journey',
      ts: e.ts,
      offsetMs: e.ts - session.startedAt,
      text: describe(e),
      kind: e.kind,
      ...(e.status ? { status: e.status } : {}),
      marks,
    }
  })
  if (options.live === false) {
    const conversion = options.conversionStep ?? 'first_payment'
    const done = conversion in session.reached
    const stoppedLabel = funnel.find((s) => s.id === session.stoppedAt)?.label
    items.push({
      eventId: `${session.id}:end`,
      name: 'session ended',
      detail: done ? 'Integration complete' : stoppedLabel ? `Stopped before ${stoppedLabel.charAt(0).toLowerCase()}${stoppedLabel.slice(1)}` : 'Ended',
      phase: items.at(-1)?.phase ?? 'Journey',
      ts: session.endedAt,
      offsetMs: session.endedAt - session.startedAt,
      text: 'session ended',
      kind: 'step',
      marks: [],
    })
  }
  return items
}
