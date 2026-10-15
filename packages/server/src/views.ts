import { DEFAULT_FUNNEL, LIVE_WINDOW_MS, stepName, timeline, type FunnelStep, type Session } from '@agentrail/core'

const wireOf = (e: Session['events'][number]) =>
  e.path ? `${e.method ?? (e.kind === 'request' ? 'GET' : 'POST')} ${e.path}${e.status ? ` ${e.status}` : ''}` : (e.tool ?? e.step ?? e.kind)

/** A session without its events, for lists. */
export const sessionSummary = (s: Session, now: number, funnel: readonly FunnelStep[] = DEFAULT_FUNNEL) => {
  const last = s.events.at(-1)
  const chain = funnel.filter((f) => !f.independent)
  const stage = [...chain].reverse().find((f) => f.id in s.reached)
  return {
    id: s.id,
    host: s.events.find((e) => e.host)?.host,
    steps: s.events.length,
    stage: stage ? { id: stage.id, label: stage.label } : undefined,
    lastStep: last ? { name: stepName(last), detail: wireOf(last), failed: (last.status ?? 0) >= 400 || last.ok === false } : undefined,
    agent: s.agent,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationMs: s.endedAt - s.startedAt,
    live: now - s.endedAt <= LIVE_WINDOW_MS,
    discovery: s.discovery,
    landingPath: s.landingPath,
    intent: s.intent,
    searches: s.searches,
    reached: Object.keys(s.reached),
    stoppedAt: s.stoppedAt,
    stoppedBy: s.stoppedBy,
    blockers: s.blockers.length,
    failedCalls: s.blockers.filter((b) => b.kind === 'failed_call').length,
    revenue: s.revenue,
    currency: s.currency,
    payments: s.payments,
    mcpConnected: s.mcpConnected,
    events: s.events.length,
    runId: s.runId,
  }
}

export const sessionDetail = (s: Session, funnel: readonly FunnelStep[], now: number, conversionStep = 'first_payment') => {
  const live = now - s.endedAt <= LIVE_WINDOW_MS
  const items = timeline(s, funnel, { live, conversionStep })
  const lastStep = funnel.filter((f) => !f.independent).reverse().find((step) => step.id in s.reached)
  const failed = s.events.filter((e) => e.kind === 'request' && (e.status ?? 0) >= 400 && e.method && e.method !== 'GET')
  const calls = s.events.filter((e) => e.kind === 'request' && e.method && e.method !== 'GET')
  return {
    ...sessionSummary(s, now, funnel),
    stepper: funnel.map((f) => ({ id: f.id, label: f.label, at: s.reached[f.id], independent: f.independent === true })),
    blockerList: s.blockers,
    timeline: items,
    gotTo: lastStep ? { id: lastStep.id, label: lastStep.label } : undefined,
    stoppedAtLabel: funnel.find((f) => f.id === s.stoppedAt)?.label,
    failedCalls: { failed: failed.length, of: calls.length },
  }
}
