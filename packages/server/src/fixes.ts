import { randomUUID } from 'node:crypto'
import { groupIntents, rankFixes, type FixCandidate, type Session } from '@openscope/core'
import type { Hono } from 'hono'
import type { AppContext } from './app.ts'
import { findDocsFile, openPullRequest, type GitHubConfig } from './github.ts'
import { chatFor, defaultProvider, LlmError, providerStatus, type ProviderStatus } from './llm.ts'
import { runAgent, runnerAgents } from './runner.ts'
import type { FixRecord, RunRecord, Store, WorkspaceSettings } from './store.ts'
import { sessionSummary } from './views.ts'

const DAY = 86_400_000

export type FixDeps = {
  /** Injected in tests. */
  readonly fetcher?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
}

const github = (s: WorkspaceSettings): GitHubConfig | undefined =>
  s.github.repo && s.github.token ? { repo: s.github.repo, token: s.github.token, ...(s.github.branch ? { branch: s.github.branch } : {}) } : undefined

const blank = (workspaceId: string, key: string, now: number): FixRecord => ({ workspaceId, key, status: 'open', updatedAt: now })

export const DRAFT_SCHEMA = {
  name: 'draft',
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      title: { type: 'string' },
      problem: { type: 'string' },
      cause: { type: 'string' },
      summary: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['file', 'title', 'problem', 'cause', 'summary', 'content'],
    additionalProperties: false,
  },
}

/**
 * The model's reply. Providers return it as schema-checked JSON, so the whole text is tried first.
 * The rest is for a model that wraps it anyway. A drafted page holds its own code fences, so a
 * fence is only a last resort.
 */
type ParsedDraft = { file?: string; title?: string; problem?: string; cause?: string; summary?: string; content?: string }

export const parseDraft = (text: string): ParsedDraft | undefined => {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*)```\s*$/.exec(text)?.[1]
  for (const candidate of [text, fenced]) {
    if (!candidate) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end < start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as ParsedDraft
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

const DRAFT_SYSTEM = `You fix documentation and product surfaces so AI agents can complete tasks.
You get one problem that stopped agents, with evidence from their sessions, and the current source of the page they read.
Change only what fixes the problem. Keep the author's style, structure and wording everywhere else.
Never invent API behaviour that the evidence does not support. If the evidence is not enough, make the smallest safe change and say so in the summary.
Reply with one JSON object only:
{"file": "<path>",
 "title": "<what the change does, as an instruction, such as 'Fix the authentication sample in the API keys guide'>",
 "problem": "<what is wrong with the page, short, such as 'Wrong auth header in the API keys guide'>",
 "cause": "<a clause about the page that finishes 'comes from one page, /docs/x:', such as 'its authentication sample shows the wrong header'>",
 "summary": "<one sentence for a reviewer>",
 "content": "<the complete new file>"}`

export const draftPrompt = (fix: FixCandidate, sessions: readonly Session[], source: { path: string; content: string } | undefined) => {
  const evidence = sessions.slice(0, 5).map((s) => {
    const lines = s.events.slice(-12).map((e) => `  ${e.kind} ${e.method ?? ''} ${e.path ?? e.step ?? e.tool ?? ''} ${e.status ?? ''} ${e.error ?? ''}`.replace(/\s+/g, ' ').trim())
    return `- ${s.agent.name}${s.intent ? `, task: "${s.intent}"` : ''}\n${lines.map((l) => `  ${l}`).join('\n')}`
  })
  return `Problem: ${fix.title}
Detail: ${fix.detail}
Kind: ${fix.kind}
Suggested direction: ${fix.proposal.summary}
Sessions stopped: ${fix.sessionsLost}${fix.beforeStep ? ` (before ${fix.beforeStep})` : ''}
Seen on: ${fix.paths.join(', ') || 'n/a'}
Page agents read before the problem: ${fix.sourcePage ?? 'unknown'}

Evidence from sessions (redacted):
${evidence.join('\n')}

${source ? `Current source of ${source.path}:\n<file>\n${source.content}\n</file>` : `There is no source file. Write a short new markdown page or snippet that fixes the problem, and name a sensible path for it.`}`
}

export const registerFixes = (app: Hono, ctx: AppContext, deps: FixDeps = {}) => {
  let draftQueue: Promise<void> = Promise.resolve()
  const { store, analyzer } = ctx
  const env = deps.env ?? process.env

  /** Candidates for a window, with what the store knows about each. */
  const candidates = (workspaceId: string, days: number) => {
    const to = ctx.now()
    const settings = store.settings(workspaceId)
    const a = analyzer.analyze(workspaceId, { from: to - days * DAY, to })
    const fixes = rankFixes(a.sessions, { windowMs: days * DAY, knownPaths: a.knownPaths, conversionStep: settings.conversionStep })
    return { a, fixes, settings }
  }

  const findFix = (workspaceId: string, key: string, days: number) => {
    // A shipped fix stops appearing in recent sessions, which is the point. Look further back.
    for (const d of [days, 90, 365]) {
      const c = candidates(workspaceId, d)
      const fix = c.fixes.find((f) => f.key === key)
      if (fix) return { ...c, fix }
    }
    return undefined
  }

  app.get('/api/providers', (c) => {
    const settings = store.settings(ctx.workspaceOf(c))
    return c.json({ available: providerStatus(settings.llm, env), selected: defaultProvider(settings.llm, env), agents: runnerAgents(settings.llm, env) })
  })

  app.get('/api/fixes', (c) => {
    const workspaceId = ctx.workspaceOf(c)
    const days = Math.max(1, Number(c.req.query('days') ?? 30) || 30)
    const { fixes, settings } = candidates(workspaceId, days)
    prepare(workspaceId, fixes.slice(0, 3).map((f) => f.key))
    const records = new Map(store.fixes(workspaceId).map((r) => [r.key, r]))
    // Published and dismissed fixes stay listed even after their blocker is gone from the window.
    const listed = fixes.map((f) => ({ ...f, record: records.get(f.key) }))
    for (const r of records.values()) {
      if (fixes.some((f) => f.key === r.key) || (r.status !== 'published' && r.status !== 'dismissed')) continue
      const old = findFix(workspaceId, r.key, 365)?.fix
      if (old) listed.push({ ...old, record: r })
    }
    return c.json({ fixes: listed, funnelSteps: settings.funnel.map((s) => ({ id: s.id, label: s.label })), currency: settings.currency })
  })

  app.get('/api/fixes/:key', (c) => {
    const workspaceId = ctx.workspaceOf(c)
    const key = c.req.param('key')
    const days = Math.max(1, Number(c.req.query('days') ?? 30) || 30)
    const found = findFix(workspaceId, key, days)
    if (!found) return c.json({ error: 'No sessions show this problem.' }, 404)
    prepare(workspaceId, [key])
    const record = store.fix(workspaceId, key)
    const runs = store.runs(workspaceId, key)
    const summary = (phase: 'before' | 'after') => {
      const done = runs.filter((r) => r.phase === phase && r.status === 'done')
      return { runs: done.length, converted: done.filter((r) => r.converted).length }
    }
    const t = ctx.now()
    const ids = new Set(found.fix.sessionIds)
    return c.json({
      ...found.fix,
      record,
      runs,
      runSummary: { before: summary('before'), after: summary('after') },
      impact: record?.publishedAt ? impact(store, ctx, workspaceId, key, record.publishedAt) : undefined,
      sessions: found.a.sessions.filter((s) => ids.has(s.id)).slice(0, 20).map((s) => sessionSummary(s, t)),
    })
  })

  app.post('/api/fixes/:key/status', async (c) => {
    const workspaceId = ctx.workspaceOf(c)
    const key = c.req.param('key')
    const { status } = (await c.req.json()) as { status?: FixRecord['status'] }
    if (status !== 'open' && status !== 'dismissed') return c.json({ error: 'status must be open or dismissed' }, 400)
    const record = store.fix(workspaceId, key) ?? blank(workspaceId, key, ctx.now())
    record.status = status
    record.updatedAt = ctx.now()
    store.saveFix(record)
    return c.json(record)
  })

  /** Where the product lives, for reading a page's current text and for test runs. */
  const siteBase = (workspaceId: string, settings: WorkspaceSettings) => {
    const site = store.sites(workspaceId)[0]
    return settings.runner.targetUrl ?? (site && site.host !== 'localhost' ? `https://${site.host}` : undefined)
  }

  /** The page as it is now, as markdown, from the product's own site, for the diff. */
  const currentPage = async (base: string, path: string) => {
    for (const url of [`${base.replace(/\/$/, '')}${path}.md`, `${base.replace(/\/$/, '')}${path}`]) {
      try {
        const res = await (deps.fetcher ?? fetch)(url, { headers: { accept: 'text/markdown, text/plain;q=0.9', 'user-agent': 'openscope-fixes' }, signal: AbortSignal.timeout(5000) })
        if (res.ok && /markdown|text\/plain/i.test(res.headers.get('content-type') ?? '')) return { path: path.replace(/^\//, ''), content: await res.text() }
      } catch {
        // The next form, then no "before".
      }
    }
    return undefined
  }

  /**
   * Start drafting one fix in the background. Drafting can take a minute with Claude Code, so it
   * runs after the caller returns, and the page polls.
   */
  const startDraft = (workspaceId: string, key: string, requested?: ProviderStatus['id']): { ok: true; provider: string } | { ok: false; status: 400 | 404; error: string } => {
    const found = findFix(workspaceId, key, 30)
    if (!found) return { ok: false, status: 404, error: 'No sessions show this problem.' }
    const provider = requested ?? defaultProvider(found.settings.llm, env)
    if (!provider) return { ok: false, status: 400, error: 'No model is set up. Sign in to Claude Code on the server, or add an API key in Settings.' }
    let chat
    try {
      chat = chatFor(provider, found.settings.llm, env)
    } catch (error) {
      return { ok: false, status: 400, error: (error as Error).message }
    }
    const record = store.fix(workspaceId, key) ?? blank(workspaceId, key, ctx.now())
    record.drafting = true
    delete record.draftError
    record.updatedAt = ctx.now()
    store.saveFix(record)

    const ids = new Set(found.fix.sessionIds)
    const sessions = found.a.sessions.filter((s) => ids.has(s.id))
    const servePath = found.fix.kind === 'markdown_served_html' || found.fix.kind === 'not_found' ? found.fix.path : found.fix.sourcePage
    // One draft at a time: Claude Code runs on this machine, and three at once would slow it down.
    draftQueue = draftQueue.then(async () => {
      const latest = () => store.fix(workspaceId, key) ?? record
      try {
        const gh = github(found.settings)
        const base = siteBase(workspaceId, found.settings)
        const source =
          (gh && found.fix.sourcePage ? await findDocsFile(gh, found.settings.github.docsRoot ?? '', found.fix.sourcePage, deps.fetcher) : undefined) ??
          (base && servePath ? await currentPage(base, servePath) : undefined)
        const reply = await chat({ system: DRAFT_SYSTEM, messages: [{ role: 'user', content: draftPrompt(found.fix, sessions, source) }], schema: DRAFT_SCHEMA })
        const parsed = parseDraft(reply)
        if (!parsed?.content) throw new LlmError('The model did not return a change in the expected format.')
        const next = latest()
        next.draft = {
          file: source?.path ?? parsed.file ?? `${(found.fix.sourcePage ?? 'docs/agent-fix').replace(/^\//, '')}.md`,
          ...(servePath ? { servePath } : {}),
          ...(parsed.title ? { title: parsed.title } : {}),
          ...(parsed.problem ? { problem: parsed.problem } : {}),
          ...(parsed.cause ? { cause: parsed.cause.replace(/\.$/, '') } : {}),
          ...(source ? { before: source.content } : {}),
          after: parsed.content,
          summary: parsed.summary ?? found.fix.proposal.summary,
          provider,
        }
        next.status = next.status === 'published' ? 'published' : 'drafted'
        next.drafting = false
        next.updatedAt = ctx.now()
        store.saveFix(next)
      } catch (error) {
        const next = latest()
        next.drafting = false
        next.draftError = (error as Error).message
        next.updatedAt = ctx.now()
        store.saveFix(next)
      }
    })
    return { ok: true, provider: providerStatus(found.settings.llm, env).find((p) => p.id === provider)?.label ?? provider }
  }

  /**
   * "Review fixes prepared for you": the top fixes are drafted before anyone opens them. Each fix is
   * drafted once; a failure waits an hour before it is tried again, so a broken provider is not
   * called on every page view. Settings can turn this off.
   */
  const prepare = (workspaceId: string, keys: readonly string[]) => {
    const settings = store.settings(workspaceId)
    if (settings.autoDraft === false || !defaultProvider(settings.llm, env)) return
    for (const key of keys) {
      const record = store.fix(workspaceId, key)
      if (record?.draft || record?.drafting || record?.status === 'dismissed') continue
      if (record?.draftError && ctx.now() - record.updatedAt < 3_600_000) continue
      if (!findFix(workspaceId, key, 30)?.fix.proposal.needsDraft) continue
      startDraft(workspaceId, key)
    }
  }
  ctx.prepareFixes = (workspaceId, keys) => prepare(workspaceId, keys)

  app.post('/api/fixes/:key/draft', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { provider?: ProviderStatus['id'] }
    const r = startDraft(ctx.workspaceOf(c), c.req.param('key'), body.provider)
    return r.ok ? c.json({ message: `Drafting with ${r.provider}.` }, 202) : c.json({ error: r.error }, r.status)
  })

  app.post('/api/fixes/:key/publish', async (c) => {
    const workspaceId = ctx.workspaceOf(c)
    const key = c.req.param('key')
    const found = findFix(workspaceId, key, 30)
    if (!found) return c.json({ error: 'No sessions show this problem.' }, 404)
    const record = store.fix(workspaceId, key) ?? blank(workspaceId, key, ctx.now())
    const rulePatch = found.fix.proposal.patch
    const gh = github(found.settings)
    let message: string
    if (record.draft && gh) {
      try {
        record.prUrl = await openPullRequest(
          gh,
          {
            path: record.draft.file,
            content: record.draft.after,
            title: `Fix for agents: ${found.fix.title}`.slice(0, 120),
            branchName: `openscope/fix-${randomUUID().slice(0, 8)}`,
            body: `${record.draft.summary}\n\n${found.fix.sessionsLost} agent sessions stopped on this problem (${found.fix.detail}).\n\nPrepared by OpenScope from redacted agent sessions. Drafted with ${record.draft.provider}.`,
          },
          deps.fetcher,
        )
      } catch (error) {
        return c.json({ error: `Could not open the pull request: ${(error as Error).message}` }, 502)
      }
      message = record.draft.servePath ? 'Live for agents now, and a pull request is open for your docs.' : 'Pull request opened. The before and after comparison starts now.'
    } else if (rulePatch && found.fix.kind === 'not_found') {
      message = 'Published. Collectors with applyFixes on now serve this redirect.'
    } else if (record.draft) {
      message = record.draft.servePath
        ? 'Live for agents now: collectors with applyFixes serve the corrected page. Connect GitHub to also open a pull request.'
        : 'Marked as published. Connect GitHub in Settings to open pull requests.'
    } else {
      return c.json({ error: 'Draft the change first.' }, 400)
    }
    record.status = 'published'
    record.publishedAt = ctx.now()
    record.updatedAt = ctx.now()
    store.saveFix(record)
    return c.json({ ...record, message })
  })

  app.post('/api/fixes/:key/test', async (c) => {
    const workspaceId = ctx.workspaceOf(c)
    const key = c.req.param('key')
    const body = (await c.req.json().catch(() => ({}))) as { agent?: string; runs?: number; phase?: 'before' | 'after' }
    const found = findFix(workspaceId, key, 30)
    if (!found) return c.json({ error: 'No sessions show this problem.' }, 404)
    const agents = runnerAgents(found.settings.llm, env)
    const agent = agents.find((a) => a.id === body.agent && a.ready) ?? agents.find((a) => a.ready)
    if (!agent) return c.json({ error: 'No agent is available. Sign in to Claude Code on the server, or add an API key in Settings.' }, 400)
    const targetUrl = siteBase(workspaceId, found.settings)
    if (!targetUrl) return c.json({ error: 'Set the preview URL for test runs in Settings.' }, 400)
    // The task agents had when they hit this. Lost sessions first, else any that hit it and got past.
    const ids = new Set(found.fix.sessionIds.length > 0 ? found.fix.sessionIds : found.fix.affectedSessionIds)
    const intents = groupIntents(found.a.sessions.filter((s) => ids.has(s.id)))
    const task = intents[0]?.quotes[0] ?? `Get past this problem: ${found.fix.title}.`
    const n = Math.min(Math.max(Math.round(body.runs ?? 5), 1), 50)
    const phase = body.phase === 'after' ? 'after' : 'before'
    const queued: RunRecord[] = Array.from({ length: n }, () => ({
      id: `run_${randomUUID()}`,
      workspaceId,
      fixKey: key,
      phase,
      agent: agent.id,
      task,
      status: 'queued',
      createdAt: ctx.now(),
    }))
    for (const r of queued) store.saveRun(r)
    void runQueue(store, ctx, queued, targetUrl, found.fix.beforeStep, deps)
    return c.json({ message: `${n} ${phase} runs queued on ${agent.label}.`, runs: queued }, 202)
  })

  /**
   * For the SDK's `applyFixes`: what is live for the workspace of this ingest key. Redirects for
   * missing pages, and corrected pages that the SDK serves to agents until the docs change lands.
   */
  app.get('/v1/fixes/live', (c) => {
    const key = c.req.header('x-openscope-key')
    const site = key ? store.siteByKey(key) : undefined
    if (!site) return c.json({ error: 'unknown ingest key' }, 401)
    const published = store.fixes(site.workspaceId).filter((r) => r.status === 'published')
    const redirects = published
      .filter((r) => r.key.startsWith('not_found:'))
      .flatMap((r) => {
        const patch = findFix(site.workspaceId, r.key, 365)?.fix.proposal.patch
        if (!patch) return []
        try {
          return JSON.parse(patch.content) as { from: string; to: string; status: number }[]
        } catch {
          return []
        }
      })
    const pages = published.flatMap((r) =>
      r.draft?.servePath ? [{ path: r.draft.servePath, content: r.draft.after, contentType: 'text/markdown; charset=utf-8' }] : [],
    )
    return c.json({ redirects, pages })
  })
}

/** Runs one at a time, so a laptop running Claude Code is not asked for ten at once. */
const runQueue = async (store: Store, ctx: AppContext, runs: RunRecord[], targetUrl: string, step: string | undefined, deps: FixDeps) => {
  for (const run of runs) {
    run.status = 'running'
    store.saveRun(run)
    const settings = store.settings(run.workspaceId)
    try {
      const outcome = await runAgent({
        runId: run.id,
        agent: run.agent,
        task: run.task,
        targetUrl,
        timeoutMs: (settings.runner.timeoutSec ?? 300) * 1000,
        settings,
        ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
        ...(deps.env ? { env: deps.env } : {}),
      })
      // Give the collector a moment to flush the run's last requests.
      await new Promise((r) => setTimeout(r, deps.fetcher ? 0 : 3000))
      const to = ctx.now()
      const sessions = ctx.analyzer.analyze(run.workspaceId, { from: run.createdAt - 60_000, to }, { runs: true }).sessions.filter((s) => s.runId === run.id)
      const reached = new Set(sessions.flatMap((s) => Object.keys(s.reached)))
      const funnel = settings.funnel.map((f) => f.id)
      run.output = outcome.transcript.slice(-4000)
      if (sessions.length > 0) {
        run.measuredBy = 'collector'
        const last = [...funnel].reverse().find((id) => reached.has(id))
        if (last) run.reachedStep = last
        run.converted = reached.has(step ?? settings.conversionStep)
      } else {
        run.measuredBy = 'self-report'
        run.converted = outcome.selfReport?.success ?? false
      }
      run.status = 'done'
    } catch (error) {
      run.status = 'failed'
      run.output = (error as Error).message
    }
    run.finishedAt = ctx.now()
    store.saveRun(run)
  }
}

/** Conversion and how often the problem still happens, for equal windows on each side of publishing. */
const impact = (store: Store, ctx: AppContext, workspaceId: string, key: string, publishedAt: number) => {
  const now = ctx.now()
  const days = Math.min(14, Math.max(1, Math.floor((now - publishedAt) / DAY)))
  const span = days * DAY
  const step = store.settings(workspaceId).conversionStep
  const side = (from: number, to: number) => {
    const sessions = ctx.analyzer.analyze(workspaceId, { from, to }).sessions
    const converted = sessions.filter((s) => step in s.reached).length
    const hit = sessions.filter((s) => s.blockers.some((b) => b.key === key)).length
    return { sessions: sessions.length, converted, conversion: sessions.length ? converted / sessions.length : 0, hitRate: sessions.length ? hit / sessions.length : 0 }
  }
  return { days, before: side(publishedAt - span, publishedAt), after: side(publishedAt, Math.min(now, publishedAt + span)) }
}
