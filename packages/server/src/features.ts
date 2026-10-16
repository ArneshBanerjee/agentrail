import { groupIntents } from '@openscope/core'
import type { Hono } from 'hono'
import type { AppContext } from './app.ts'
import { registerDrains } from './drains.ts'
import { seedDemo } from './seed.ts'
import { registerFixes, type FixDeps } from './fixes.ts'
import { chatFor, defaultProvider, type ProviderStatus } from './llm.ts'

/** Routes for features beyond the core API. Each one registers itself here. */
export const extend = (app: Hono, ctx: AppContext, deps: FixDeps = {}): void => {
  registerFixes(app, ctx, deps)
  registerDrains(app, ctx)
  // The sidebar's demo switch: the demo workspace, made on first use. Seeding again would only
  // repeat the same events, so an existing demo is returned as it is.
  app.post('/api/demo', async (c) => {
    const existing = ctx.store.workspaces().find((w) => w.name === 'Ledgerly (demo)')
    if (existing) return c.json(existing)
    const { workspace } = await seedDemo(ctx.store, ctx.config.secret, ctx.now())
    return c.json(workspace, 201)
  })
  registerIntentLabels(app, ctx, deps)
}

/**
 * Keyword groups are named after a word ("Refund"). A model can name them the way a person would
 * ("Refunds and disputes") without changing which tasks are in which group.
 */
const registerIntentLabels = (app: Hono, ctx: AppContext, deps: FixDeps) => {
  app.post('/api/intents/label', async (c) => {
    const workspaceId = ctx.workspaceOf(c)
    const settings = ctx.store.settings(workspaceId)
    const body = (await c.req.json().catch(() => ({}))) as { provider?: ProviderStatus['id'] }
    const provider = body.provider ?? defaultProvider(settings.llm, deps.env)
    if (!provider) return c.json({ error: 'No model is set up.' }, 400)
    const to = ctx.now()
    const a = ctx.analyzer.analyze(workspaceId, { from: to - 30 * 86_400_000, to })
    const groups = groupIntents(a.sessions, { definitions: settings.intents }).filter((g) => g.id.startsWith('kw:') || g.id === 'other')
    if (groups.length === 0) return c.json({ labels: settings.intentLabels })
    const list = groups.map((g) => `${g.id}: ${g.quotes.map((q) => `"${q}"`).join(' | ')}`).join('\n')
    try {
      const reply = await chatFor(provider, settings.llm, deps.env)({
        system: 'You name groups of tasks that AI agents were given. Each name is two to four words, a noun phrase a product manager would use. Reply with one JSON object mapping each group id to its name, and nothing else.',
        messages: [{ role: 'user', content: list }],
        maxTokens: 2000,
      })
      const start = reply.indexOf('{')
      const parsed = JSON.parse(reply.slice(start, reply.lastIndexOf('}') + 1)) as Record<string, unknown>
      const labels = { ...settings.intentLabels }
      for (const g of groups) if (typeof parsed[g.id] === 'string') labels[g.id] = (parsed[g.id] as string).slice(0, 60)
      ctx.store.saveSettings(workspaceId, { ...settings, intentLabels: labels })
      return c.json({ labels })
    } catch (error) {
      return c.json({ error: `Naming failed: ${(error as Error).message}` }, 502)
    }
  })
}
