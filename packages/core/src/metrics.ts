import type { Session } from './journey.ts'

/** A session whose last event is this recent is shown as live. */
export const LIVE_WINDOW_MS = 5 * 60_000

export type Overview = {
  readonly sessions: number
  readonly live: number
  readonly converted: number
  readonly conversion: number
  readonly revenue: number
  /** Change against the previous window of the same length. `undefined` when there is none. */
  readonly sessionsChange?: number
  /** In points, so 0.024 means up 2.4 points. */
  readonly conversionChange?: number
  readonly agents: number
  readonly mcpConnected: number
  readonly withIntent: number
}

const conversionOf = (sessions: readonly Session[], step: string) =>
  sessions.length === 0 ? 0 : sessions.filter((s) => step in s.reached).length / sessions.length

export const overview = (
  current: readonly Session[],
  previous: readonly Session[] | undefined,
  now: number,
  conversionStep = 'first_payment',
): Overview => {
  const converted = current.filter((s) => conversionStep in s.reached).length
  const conversion = conversionOf(current, conversionStep)
  return {
    sessions: current.length,
    live: current.filter((s) => now - s.endedAt <= LIVE_WINDOW_MS).length,
    converted,
    conversion,
    revenue: current.reduce((sum, s) => sum + s.revenue, 0),
    ...(previous && previous.length > 0
      ? {
          sessionsChange: current.length / previous.length - 1,
          conversionChange: conversion - conversionOf(previous, conversionStep),
        }
      : {}),
    agents: new Set(current.map((s) => s.agent.agentId)).size,
    mcpConnected: current.filter((s) => s.mcpConnected).length,
    withIntent: current.filter((s) => s.intent).length,
  }
}

export type BreakdownRow = {
  readonly key: string
  readonly label: string
  readonly sessions: number
  readonly converted: number
  readonly conversion: number
  readonly revenue: number
}

/**
 * Sessions, conversion and revenue split by any key: agent, intent, landing page, surface.
 * One function for every table, so the columns mean the same thing on every page.
 */
export const breakdown = (
  sessions: readonly Session[],
  keyOf: (s: Session) => { key: string; label: string } | undefined,
  conversionStep = 'first_payment',
): BreakdownRow[] => {
  const rows = new Map<string, { label: string; sessions: number; converted: number; revenue: number }>()
  for (const s of sessions) {
    const k = keyOf(s)
    if (!k) continue
    const row = rows.get(k.key) ?? { label: k.label, sessions: 0, converted: 0, revenue: 0 }
    row.sessions++
    if (conversionStep in s.reached) row.converted++
    row.revenue += s.revenue
    rows.set(k.key, row)
  }
  return [...rows.entries()]
    .map(([key, r]) => ({ key, ...r, conversion: r.sessions === 0 ? 0 : r.converted / r.sessions }))
    .sort((a, b) => b.revenue - a.revenue || b.sessions - a.sessions || a.label.localeCompare(b.label))
}

/** Agents nobody could name are one row. The Agents page splits them by behaviour. */
export const byAgent = (s: Session) =>
  s.agent.agentId.startsWith('unnamed:') ? { key: 'unnamed', label: 'Unnamed' } : { key: s.agent.agentId, label: s.agent.name }
export const byLandingPage = (s: Session) => (s.landingPath ? { key: s.landingPath, label: s.landingPath } : undefined)
export const bySurface = (s: Session) => ({ key: s.agent.surface, label: s.agent.surface })
export const byDiscovery = (s: Session) => ({ key: s.discovery.via, label: s.discovery.via })
