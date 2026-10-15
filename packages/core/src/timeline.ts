import type { StoredEvent } from './events.ts'
import type { FunnelStep } from './funnel.ts'
import type { Session } from './journey.ts'

export type TimelineMark = { readonly kind: 'step' | 'blocked' | 'stopped'; readonly label: string }

export type TimelineItem = {
  readonly eventId: string
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

export const timeline = (session: Session, funnel: readonly FunnelStep[]): TimelineItem[] => {
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
  return session.events.map((e) => {
    const marks: TimelineMark[] = []
    if (!marked.has(e.ts)) {
      for (const label of stepAt.get(e.ts) ?? []) marks.push({ kind: 'step', label })
      if (stepAt.has(e.ts)) marked.add(e.ts)
    }
    if (blocked.has(e.id)) marks.push({ kind: 'blocked', label: 'Blocked' })
    if (session.stoppedAt && e === last) marks.push({ kind: 'stopped', label: 'Stopped' })
    return {
      eventId: e.id,
      ts: e.ts,
      offsetMs: e.ts - session.startedAt,
      text: describe(e),
      kind: e.kind,
      ...(e.status ? { status: e.status } : {}),
      marks,
    }
  })
}
