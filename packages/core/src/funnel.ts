import type { EventKind, StoredEvent } from './events.ts'

/**
 * A funnel step is a rule over one event. A workspace sets its own, because "installed" means an
 * npm package for one product and a GitHub app for another.
 */
export type StepMatch = {
  readonly kind?: EventKind
  /** The name passed to `track()`. */
  readonly step?: string
  readonly pathPrefix?: string
  readonly host?: string
  /** Matches only a successful request (status below 400). */
  readonly ok?: boolean
  /** Matches the n-th successful payment in the session, counting from 1. */
  readonly nthPayment?: number
  /** Matches any event. The first step of most funnels. */
  readonly any?: boolean
}

export type FunnelStep = {
  readonly id: string
  readonly label: string
  readonly match: readonly StepMatch[]
}

export const DEFAULT_FUNNEL: readonly FunnelStep[] = [
  { id: 'discovered', label: 'Discovered', match: [{ any: true }] },
  {
    id: 'evaluated',
    label: 'Read the docs',
    match: [
      { kind: 'request', pathPrefix: '/docs', ok: true },
      { kind: 'request', pathPrefix: '/llms', ok: true },
      { kind: 'search' },
    ],
  },
  { id: 'installed', label: 'Installed', match: [{ step: 'installed' }] },
  { id: 'signed_in', label: 'Signed in', match: [{ step: 'signed_in' }] },
  { id: 'first_api_call', label: 'First API call', match: [{ step: 'first_api_call' }] },
  { id: 'first_payment', label: 'First payment', match: [{ nthPayment: 1 }] },
  { id: 'second_payment', label: 'Second payment', match: [{ nthPayment: 2 }] },
]

/** The step a session must reach to count as converted. */
export const DEFAULT_CONVERSION_STEP = 'first_payment'

const matches = (m: StepMatch, event: StoredEvent, paymentIndex: number): boolean => {
  if (m.any) return true
  if (m.nthPayment !== undefined) return event.kind === 'payment' && event.ok !== false && paymentIndex === m.nthPayment
  if (m.kind !== undefined && event.kind !== m.kind) return false
  if (m.step !== undefined && event.step !== m.step) return false
  if (m.pathPrefix !== undefined && !(event.path ?? '').startsWith(m.pathPrefix)) return false
  if (m.host !== undefined && event.host !== m.host) return false
  if (m.ok === true && (event.status ?? 200) >= 400) return false
  if (m.ok === true && event.ok === false) return false
  return true
}

/**
 * Which steps a session reached, with the time of each.
 *
 * A later step implies the earlier ones. An agent that signs in with a key it was handed never
 * "installs", but it did get past that point, and a funnel that dips and rises again tells nobody
 * where people stop.
 */
export const reachedSteps = (
  events: readonly StoredEvent[],
  steps: readonly FunnelStep[],
): ReadonlyMap<string, number> => {
  const direct = new Map<string, number>()
  let payments = 0
  for (const event of events) {
    if (event.kind === 'payment' && event.ok !== false) payments++
    const index = event.kind === 'payment' ? payments : 0
    for (const step of steps) {
      if (direct.has(step.id)) continue
      if (step.match.some((m) => matches(m, event, index))) direct.set(step.id, event.ts)
    }
  }
  const backwards: [string, number][] = []
  let laterTime: number | undefined
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!
    const own = direct.get(step.id)
    if (own !== undefined) laterTime = laterTime === undefined ? own : Math.min(own, laterTime)
    if (own !== undefined || laterTime !== undefined) backwards.push([step.id, own ?? laterTime!])
  }
  return new Map(backwards.reverse())
}

export type FunnelRow = {
  readonly stepId: string
  readonly label: string
  readonly sessions: number
  /** Share of all sessions that reached this step. */
  readonly ofTotal: number
  /** Share lost since the step before. Zero for the first step. */
  readonly dropFromPrevious: number
  readonly byAgent: Readonly<Record<string, number>>
}

export const computeFunnel = (
  sessions: readonly { readonly agentId: string; readonly reached: ReadonlyMap<string, number> | Readonly<Record<string, number>> }[],
  steps: readonly FunnelStep[],
): FunnelRow[] => {
  const total = sessions.length
  let previous = total
  return steps.map((step, i) => {
    const byAgent: Record<string, number> = {}
    let count = 0
    for (const s of sessions) {
      const has = s.reached instanceof Map ? s.reached.has(step.id) : step.id in s.reached
      if (!has) continue
      count++
      byAgent[s.agentId] = (byAgent[s.agentId] ?? 0) + 1
    }
    const row: FunnelRow = {
      stepId: step.id,
      label: step.label,
      sessions: count,
      ofTotal: total === 0 ? 0 : count / total,
      dropFromPrevious: i === 0 || previous === 0 ? 0 : 1 - count / previous,
      byAgent,
    }
    previous = count
    return row
  })
}
