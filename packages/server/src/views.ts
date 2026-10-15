import { LIVE_WINDOW_MS, timeline, type FunnelStep, type Session } from '@agentrail/core'

/** A session without its events, for lists. */
export const sessionSummary = (s: Session, now: number) => ({
  id: s.id,
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
})

export const sessionDetail = (s: Session, funnel: readonly FunnelStep[], now: number) => {
  const items = timeline(s, funnel)
  const lastStep = [...funnel].reverse().find((step) => step.id in s.reached)
  const failed = s.events.filter((e) => e.kind === 'request' && (e.status ?? 0) >= 400 && e.method && e.method !== 'GET')
  const calls = s.events.filter((e) => e.kind === 'request' && e.method && e.method !== 'GET')
  return {
    ...sessionSummary(s, now),
    blockerList: s.blockers,
    timeline: items,
    gotTo: lastStep ? { id: lastStep.id, label: lastStep.label } : undefined,
    stoppedAtLabel: funnel.find((f) => f.id === s.stoppedAt)?.label,
    failedCalls: { failed: failed.length, of: calls.length },
  }
}
