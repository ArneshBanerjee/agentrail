import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { attribute, breakdown, byAgent, byDiscovery, byLandingPage, bySurface, groupIntents, type StoredEvent } from '@agentrail/core'
import { Analyzer, summarize, type Window } from './analysis.ts'
import type { Config } from './config.ts'
import { ingest, type IngestDeps, type Verifier } from './ingest.ts'
import type { Store, WorkspaceSettings } from './store.ts'
import { sessionDetail, sessionSummary } from './views.ts'

export type Arrival = {
  readonly workspaceId: string
  readonly agent: string
  readonly label: string
  readonly surface: string
  readonly path?: string
  readonly kind: string
  readonly ts: number
}

export type AppDeps = {
  readonly store: Store
  readonly config: Config
  readonly verify?: Verifier
  readonly now?: () => number
  /** Extra routes from features that need more than the store: drains, Stripe, fixes, runner. */
  readonly extend?: (app: Hono, ctx: AppContext) => void
}

export type AppContext = {
  readonly store: Store
  readonly config: Config
  readonly analyzer: Analyzer
  readonly ingestDeps: IngestDeps
  readonly live: EventEmitter
  readonly now: () => number
  readonly workspaceOf: (c: Context) => string
  readonly windowOf: (c: Context) => Window
  /** Set by the fixes feature: draft these fixes in the background if they have no draft yet. */
  prepareFixes?: (workspaceId: string, keys: readonly string[]) => void
}

const DAY = 86_400_000

/** Secrets are write-only. The dashboard learns that a key is set, never what it is. */
export const maskSettings = (s: WorkspaceSettings) => ({
  ...s,
  llm: { ...s.llm, apiKey: s.llm.apiKey ? 'set' : undefined },
  github: { ...s.github, token: s.github.token ? 'set' : undefined },
  stripe: { ...s.stripe, webhookSecret: s.stripe.webhookSecret ? 'set' : undefined },
})

export const createApp = (deps: AppDeps) => {
  const { store, config } = deps
  const now = deps.now ?? (() => Date.now())
  const analyzer = new Analyzer(store)
  const live = new EventEmitter()
  live.setMaxListeners(1000)

  const onStored = (site: { workspaceId: string }, events: readonly StoredEvent[]) => {
    for (const e of events) {
      if (e.runId) continue
      const a = attribute({ userAgent: e.userAgent, mcpClient: e.mcpClient, verifiedOperator: e.verifiedOperator, accept: e.accept, path: e.path })
      if (!a || a.kind === 'crawler') continue
      const arrival: Arrival = {
        workspaceId: site.workspaceId,
        agent: a.name,
        label: a.label,
        surface: a.surface,
        kind: e.kind,
        ts: e.ts,
        ...(e.path ? { path: e.path } : {}),
      }
      live.emit('arrival', arrival)
    }
  }
  const ingestDeps: IngestDeps = { store, secret: config.secret, onStored, ...(deps.verify ? { verify: deps.verify } : {}) }

  const workspaceOf = (c: Context): string => {
    const asked = c.req.header('x-workspace') ?? c.req.query('workspace')
    const all = store.workspaces()
    return (asked && all.find((w) => w.id === asked)?.id) || all[0]!.id
  }
  const windowOf = (c: Context): Window => {
    // An exact range wins over a number of days. A year at most, so one request cannot load everything.
    const fromQ = Number(c.req.query('from'))
    const toQ = Number(c.req.query('to'))
    if (fromQ > 0 && toQ > fromQ) return { from: Math.max(fromQ, toQ - 366 * DAY), to: toQ }
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 30) || 30, 1), 365)
    const to = Number(c.req.query('to') ?? now()) || now()
    return { from: to - days * DAY, to }
  }

  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true }))

  app.post('/v1/events', async (c) => {
    const key = c.req.header('x-agentrail-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body is not JSON' }, 400)
    }
    const result = await ingest(ingestDeps, key, body)
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 401)
    return c.json(result, 202)
  })

  app.use('/api/*', async (c, next) => {
    if (!config.adminToken) return next()
    const given =
      c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ??
      c.req.query('token') ??
      /(?:^|;\s*)agentrail_token=([^;]+)/.exec(c.req.header('cookie') ?? '')?.[1]
    if (given !== config.adminToken) return c.json({ error: 'unauthorised' }, 401)
    return next()
  })

  app.get('/api/me', (c) => {
    const workspaceId = workspaceOf(c)
    return c.json({
      workspaces: store.workspaces(),
      workspaceId,
      sites: store.sites(workspaceId),
      ingestUrl: `${config.publicUrl}/v1/events`,
    })
  })

  app.get('/api/summary', (c) => {
    const workspaceId = workspaceOf(c)
    const a = analyzer.analyze(workspaceId, windowOf(c), { siteId: c.req.query('site') })
    const s = summarize(store, workspaceId, a, now())
    ctx.prepareFixes?.(workspaceId, s.fixes.slice(0, 3).map((f) => f.key))
    const records = new Map(store.fixes(workspaceId).map((f) => [f.key, f]))
    const fixes = s.fixes.filter((f) => records.get(f.key)?.status !== 'dismissed')
    return c.json({
      ...s,
      fixes: fixes.slice(0, Number(c.req.query('fixes') ?? 5)).map((f) => ({ ...f, record: records.get(f.key) })),
      intents: s.intents.slice(0, Number(c.req.query('intents') ?? 5)),
      window: a.window,
    })
  })

  app.get('/api/sessions', (c) => {
    const workspaceId = workspaceOf(c)
    const a = analyzer.analyze(workspaceId, windowOf(c), { siteId: c.req.query('site'), runs: c.req.query('runs') === '1' })
    const agent = c.req.query('agent')
    const stoppedAt = c.req.query('stoppedAt')
    const blocker = c.req.query('blocker')
    const q = c.req.query('q')?.toLowerCase()
    const intentGroup = c.req.query('intent')
    const settings = store.settings(workspaceId)
    const inIntent = intentGroup
      ? new Set(groupIntents(a.sessions, { definitions: settings.intents, labels: settings.intentLabels }).find((g) => g.id === intentGroup)?.sessionIds ?? [])
      : undefined
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000)
    const t = now()
    const list = a.sessions
      .filter((s) => !agent || byAgent(s).key === agent || s.agent.agentId === agent)
      .filter((s) => !stoppedAt || s.stoppedAt === stoppedAt)
      .filter((s) => !blocker || s.blockers.some((b) => b.key === blocker))
      .filter((s) => !inIntent || inIntent.has(s.id))
      .filter((s) => !q || [s.intent, s.landingPath, s.agent.name, ...s.searches].some((x) => x?.toLowerCase().includes(q)))
    return c.json({ total: list.length, sessions: list.slice(0, limit).map((s) => sessionSummary(s, t, settings.funnel)) })
  })

  app.get('/api/sessions/:id', (c) => {
    const workspaceId = workspaceOf(c)
    const a = analyzer.analyze(workspaceId, windowOf(c), { runs: true })
    const s = a.sessions.find((x) => x.id === c.req.param('id'))
    if (!s) return c.json({ error: 'not found' }, 404)
    const settings = store.settings(workspaceId)
    return c.json(sessionDetail(s, settings.funnel, now(), settings.conversionStep))
  })

  app.get('/api/arrivals', (c) => {
    const workspaceId = workspaceOf(c)
    const a = analyzer.analyze(workspaceId, windowOf(c))
    const t = now()
    const latest = [...a.sessions].sort((x, y) => y.endedAt - x.endedAt).slice(0, Number(c.req.query('limit') ?? 20))
    const funnel = store.settings(workspaceId).funnel
    return c.json({ arrivals: latest.map((s) => sessionSummary(s, t, funnel)) })
  })

  app.get('/api/agents', (c) => {
    const workspaceId = workspaceOf(c)
    const a = analyzer.analyze(workspaceId, windowOf(c))
    const step = store.settings(workspaceId).conversionStep
    const rows = breakdown(a.sessions, byAgent, step).map((row) => {
      const mine = a.sessions.filter((s) => byAgent(s).key === row.key)
      const sample = mine[0]!.agent
      const labels: Record<string, number> = {}
      const evidence = new Map<string, number>()
      for (const s of mine) {
        labels[s.agent.label] = (labels[s.agent.label] ?? 0) + 1
        evidence.set(s.agent.evidence, (evidence.get(s.agent.evidence) ?? 0) + 1)
      }
      return {
        ...row,
        operator: sample.operator,
        surface: sample.surface,
        labels,
        evidence: [...evidence.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([text, sessions]) => ({ text, sessions })),
        discovery: breakdown(mine, byDiscovery, step).slice(0, 5),
      }
    })
    return c.json({ agents: rows, surfaces: breakdown(a.sessions, bySurface, step) })
  })

  app.get('/api/intents', (c) => {
    const workspaceId = workspaceOf(c)
    const a = analyzer.analyze(workspaceId, windowOf(c))
    const settings = store.settings(workspaceId)
    const groups = groupIntents(a.sessions, { definitions: settings.intents, conversionStep: settings.conversionStep, labels: settings.intentLabels })
    return c.json({ withIntent: a.sessions.filter((s) => s.intent).length, total: a.sessions.length, intents: groups })
  })

  app.get('/api/revenue', (c) => {
    const workspaceId = workspaceOf(c)
    const a = analyzer.analyze(workspaceId, windowOf(c))
    const settings = store.settings(workspaceId)
    const step = settings.conversionStep
    const groups = groupIntents(a.sessions, { definitions: settings.intents, conversionStep: step, labels: settings.intentLabels })
    const intentOf = new Map<string, { key: string; label: string }>()
    for (const g of groups) for (const id of g.sessionIds) intentOf.set(id, { key: g.id, label: g.label })
    return c.json({
      currency: settings.currency,
      total: a.sessions.reduce((sum, s) => sum + s.revenue, 0),
      sessions: a.sessions.length,
      converted: a.sessions.filter((s) => step in s.reached).length,
      byAgent: breakdown(a.sessions, byAgent, step),
      byIntent: breakdown(a.sessions, (s) => intentOf.get(s.id), step),
      byPage: breakdown(a.sessions, byLandingPage, step),
    })
  })

  app.get('/api/settings', (c) => c.json(maskSettings(store.settings(workspaceOf(c)))))

  app.put('/api/settings', async (c) => {
    const workspaceId = workspaceOf(c)
    const current = store.settings(workspaceId)
    const body = (await c.req.json()) as Partial<WorkspaceSettings>
    // A masked value sent back unchanged keeps the stored secret.
    const keep = <T extends Record<string, unknown>>(next: T | undefined, prev: T, field: keyof T): T => {
      if (!next) return prev
      const merged = { ...prev, ...next }
      if (next[field] === 'set' || next[field] === undefined) merged[field] = prev[field]
      if (next[field] === '') delete merged[field]
      return merged
    }
    const updated: WorkspaceSettings = {
      ...current,
      ...(body.funnel ? { funnel: body.funnel } : {}),
      ...(body.conversionStep ? { conversionStep: body.conversionStep } : {}),
      ...(body.intents ? { intents: body.intents } : {}),
      ...(body.currency ? { currency: body.currency } : {}),
      llm: keep(body.llm, current.llm, 'apiKey'),
      github: keep(body.github, current.github, 'token'),
      stripe: keep(body.stripe, current.stripe, 'webhookSecret'),
      runner: { ...current.runner, ...(body.runner ?? {}) },
      ...(body.autoDraft !== undefined ? { autoDraft: body.autoDraft } : {}),
      ...(body.sessionGapMinutes !== undefined ? { sessionGapMinutes: Math.max(1, Number(body.sessionGapMinutes) || 30) } : {}),
    }
    store.saveSettings(workspaceId, updated)
    return c.json(maskSettings(updated))
  })

  app.post('/api/sites', async (c) => {
    const body = (await c.req.json()) as { name?: string; host?: string }
    if (!body.name || !body.host) return c.json({ error: 'name and host are required' }, 400)
    return c.json(store.createSite(workspaceOf(c), body.name, body.host), 201)
  })

  app.delete('/api/sites/:id', (c) => {
    store.deleteSite(workspaceOf(c), c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/workspaces', async (c) => {
    const body = (await c.req.json()) as { name?: string }
    if (!body.name) return c.json({ error: 'name is required' }, 400)
    const w = store.createWorkspace(body.name, now())
    store.createSite(w.id, 'Website', 'localhost')
    return c.json(w, 201)
  })

  app.get('/api/live', (c) => {
    const workspaceId = workspaceOf(c)
    return streamSSE(c, async (stream) => {
      const send = (a: Arrival) => {
        if (a.workspaceId === workspaceId) void stream.writeSSE({ event: 'arrival', data: JSON.stringify(a) })
      }
      live.on('arrival', send)
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: String(now()) }), 25_000)
      await new Promise<void>((resolve) => stream.onAbort(resolve))
      clearInterval(ping)
      live.off('arrival', send)
    })
  })

  const ctx: AppContext = { store, config, analyzer, ingestDeps, live, now, workspaceOf, windowOf }
  deps.extend?.(app, ctx)

  // The dashboard is static files from packages/web. Unknown paths get index.html so client-side
  // routes survive a reload.
  const dist = join(import.meta.dirname, '../../web/dist')
  const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' }
  app.get('*', (c) => {
    if (!existsSync(dist)) return c.text('Dashboard not built. Run npm run build, or npm run dev.', 404)
    const path = c.req.path.replace(/\.\.+/g, '')
    const file = join(dist, path)
    const ext = /\.[a-z0-9]+$/.exec(path)?.[0]
    if (ext && existsSync(file)) return c.body(readFileSync(file), 200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
    return c.html(readFileSync(join(dist, 'index.html'), 'utf8'))
  })

  return { app, ctx }
}
