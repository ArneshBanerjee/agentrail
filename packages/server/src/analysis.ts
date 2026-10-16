import {
  breakdown,
  buildSessions,
  byAgent,
  byLandingPage,
  computeFunnel,
  groupIntents,
  overview,
  rankFixes,
  type Session,
} from '@agentrail/core'
import type { Store } from './store.ts'

const DAY = 86_400_000
/** Events this far before the window are loaded too, so a payment in the window finds its session. */
const LOOKBACK = 30 * DAY

export type Window = { readonly from: number; readonly to: number }

export type Analysis = {
  readonly window: Window
  readonly sessions: readonly Session[]
  readonly previous: readonly Session[]
  readonly knownPaths: readonly string[]
}

/**
 * Sessions for one workspace and one window, built from raw events every time.
 *
 * Nothing is precomputed, so changing the funnel or the agent rules changes every number at once,
 * including history. A short cache keyed on the event count stops a dashboard that asks five
 * questions at once from building the same sessions five times.
 */
export class Analyzer {
  private cache = new Map<string, { at: number; count: number; value: Analysis }>()
  private readonly store: Store

  constructor(store: Store) {
    this.store = store
  }

  analyze(workspaceId: string, window: Window, options: { siteId?: string | undefined; runs?: boolean } = {}): Analysis {
    const siteIds = this.store.sites(workspaceId).map((s) => s.id).filter((id) => !options.siteId || id === options.siteId)
    const count = this.store.eventCount(siteIds)
    const key = `${workspaceId}|${options.siteId ?? ''}|${window.from}|${window.to}|${options.runs ? 1 : 0}`
    const hit = this.cache.get(key)
    if (hit && hit.count === count && Date.now() - hit.at < 5000) return hit.value

    const settings = this.store.settings(workspaceId)
    const span = window.to - window.from
    const events = this.store.events(siteIds, window.from - span - LOOKBACK, window.to)
    const all = buildSessions(events, { funnel: settings.funnel, ...(settings.sessionGapMinutes ? { gapMs: settings.sessionGapMinutes * 60_000 } : {}) }).filter((s) => (options.runs ? true : !s.runId))
    const sessions = all.filter((s) => s.startedAt >= window.from && s.startedAt <= window.to)
    const previous = all.filter((s) => s.startedAt >= window.from - span && s.startedAt < window.from)
    const knownPaths = [
      ...new Set(events.filter((e) => e.kind === 'request' && e.path && (e.status ?? 200) < 400).map((e) => e.path!)),
    ]
    const value = { window, sessions, previous, knownPaths }
    this.cache.set(key, { at: Date.now(), count, value })
    if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!)
    return value
  }
}

/**
 * The currency to show: the one set in Settings, else the one most payments arrive in, else USD.
 * A product that charges in euros should not see dollar signs because nobody changed a setting.
 */
export const currencyOf = (settingsCurrency: string, sessions: readonly Session[]): string => {
  if (settingsCurrency) return settingsCurrency
  const counts = new Map<string, number>()
  for (const s of sessions) if (s.currency) counts.set(s.currency.toLowerCase(), (counts.get(s.currency.toLowerCase()) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'usd'
}

export const summarize = (store: Store, workspaceId: string, a: Analysis, now: number) => {
  const settings = store.settings(workspaceId)
  const step = settings.conversionStep
  const funnel = computeFunnel(
    a.sessions.map((s) => ({ agentId: s.agent.name, reached: s.reached })),
    settings.funnel,
  )
  const intents = groupIntents(a.sessions, { definitions: settings.intents, conversionStep: step, labels: settings.intentLabels })
  const fixes = rankFixes(a.sessions, { windowMs: a.window.to - a.window.from, knownPaths: a.knownPaths, conversionStep: step })
  const agents = breakdown(a.sessions, byAgent, step)
  return {
    overview: overview(a.sessions, a.previous, now, step),
    funnel,
    funnelSteps: settings.funnel.map((s) => ({ id: s.id, label: s.label })),
    agents,
    intents,
    fixes,
    pages: breakdown(a.sessions, byLandingPage, step),
    currency: currencyOf(settings.currency, a.sessions),
  }
}
