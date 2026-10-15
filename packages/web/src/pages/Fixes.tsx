import { useEffect, useState } from 'react'
import { AgentName, Diff, Empty, ErrorBox, Link, Loading } from '../components.tsx'
import { api, fmt, navigate, useApi, useDays, lowerFirst } from '../lib.ts'
import type { FixCandidate, FixDetail as Detail, FixRecord, Providers, Summary } from '../types.ts'

const STATUS: Record<FixRecord['status'], string> = { open: 'neutral', drafted: 'accent', testing: 'accent', published: 'good', dismissed: 'neutral' }

/** Where to look: the missing or wrong page itself, the tool, or for API failures the page agents copied from. */
const whereOf = (f: FixCandidate) =>
  f.kind === 'not_found' || f.kind === 'markdown_served_html' ? f.path : f.kind === 'mcp_tool_error' ? f.tool : f.kind === 'failed_call' ? (f.sourcePage ?? f.path) : '—'

const StatusChip = ({ record }: { record?: FixRecord }) => <span className={`chip ${STATUS[record?.status ?? 'open']}`}>{record?.drafting ? 'drafting' : (record?.status ?? 'open')}</span>

export const Fixes = () => {
  const [days] = useDays()
  const [tab, setTab] = useState<'open' | 'published' | 'dismissed'>('open')
  const { data, error } = useApi<{ fixes: (FixCandidate & { record?: FixRecord })[]; funnelSteps: Summary['funnelSteps']; currency: string }>(`/api/fixes?days=${days}`)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const label = (id?: string) => {
    const l = data.funnelSteps.find((s) => s.id === id)?.label
    return l ? lowerFirst(l) : id
  }
  const shown = data.fixes.filter((f) => {
    const st = f.record?.status ?? 'open'
    return tab === 'open' ? st !== 'published' && st !== 'dismissed' : st === tab
  })
  return (
    <>
      <div className="tabs">
        {(['open', 'published', 'dismissed'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'open' ? 'To fix' : t[0]!.toUpperCase() + t.slice(1)} ({data.fixes.filter((f) => (t === 'open' ? !['published', 'dismissed'].includes(f.record?.status ?? 'open') : f.record?.status === t)).length})
          </button>
        ))}
      </div>
      <div className="card">
        {shown.length === 0 ? <Empty title={tab === 'open' ? 'Nothing is blocking agents' : `No ${tab} fixes`} /> : null}
        {shown.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Problem</th>
                <th>Where</th>
                <th className="num">Sessions lost</th>
                <th className="num">At risk / month</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((f, i) => (
                <tr key={f.key} className="click" onClick={() => navigate(`/fixes/${encodeURIComponent(f.key)}`)}>
                  <td className="faint">{i + 1}</td>
                  <td>
                    <div className="bold">{f.title}</div>
                    <div className="muted small">{f.proposal.summary}</div>
                  </td>
                  <td className="mono small">{whereOf(f)}</td>
                  <td className="num">
                    {fmt.n(f.sessionsLost)}
                    <div className="faint small">{f.beforeStep ? `before ${label(f.beforeStep)}` : ''}</div>
                  </td>
                  <td className="num">
                    {fmt.money(f.monthlyValueAtRisk, data.currency)}
                    <div className="faint small">estimated</div>
                  </td>
                  <td>
                    <StatusChip record={f.record} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  )
}

export const FixDetail = ({ fixKey }: { fixKey: string }) => {
  const [days] = useDays()
  const path = `/api/fixes/${encodeURIComponent(fixKey)}`
  const fix = useApi<Detail>(`${path}?days=${days}`)
  const providers = useApi<Providers>('/api/providers')
  const summary = useApi<Summary>(`/api/summary?days=${days}&fixes=0&intents=0`)
  const [provider, setProvider] = useState<string>()
  const [runner, setRunner] = useState<string>()
  const [runs, setRuns] = useState(5)
  const [busy, setBusy] = useState<string>()
  const [message, setMessage] = useState<string>()
  const record = fix.data?.record
  const pending = record?.drafting || fix.data?.runs.some((r) => r.status === 'queued' || r.status === 'running')

  // Drafts and test runs happen in the background. Poll while one is in flight.
  useEffect(() => {
    if (!pending) return
    const t = setInterval(fix.reload, 2500)
    return () => clearInterval(t)
  }, [pending, fix.reload])

  if (fix.error) return <ErrorBox error={fix.error} />
  if (!fix.data) return <Loading />
  const f = fix.data
  const currency = summary.data?.currency ?? 'usd'
  const stepLabel = (id?: string) => summary.data?.funnelSteps.find((s) => s.id === id)?.label ?? id
  const chosenProvider = provider ?? providers.data?.selected ?? providers.data?.available.find((p) => p.ready)?.id
  const chosenRunner = runner ?? providers.data?.agents.find((p) => p.ready)?.id

  const act = async (name: string, body: unknown, done: string) => {
    setBusy(name)
    setMessage(undefined)
    try {
      const res = await api<{ prUrl?: string; message?: string }>(`${path}/${name}`, { method: 'POST', json: body })
      setMessage(res?.message ?? done)
      fix.reload()
    } catch (e) {
      setMessage((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  const change = record?.draft ?? (f.proposal.patch ? { file: f.proposal.patch.file, after: f.proposal.patch.content, summary: f.proposal.summary, provider: 'rule' } : undefined)

  return (
    <>
      <div className="card">
        <div className="between">
          <div>
            <div className="row-flex">
              <span className="chip bad">{f.kind.replaceAll('_', ' ')}</span>
              <StatusChip record={record} />
            </div>
            <h2 style={{ textTransform: 'none', letterSpacing: 0, fontSize: 20, color: 'var(--text)', margin: '10px 0 4px' }}>{f.title}</h2>
            <div className="muted">{f.detail}</div>
          </div>
          <div className="row-flex">
            {record?.status === 'dismissed' ? (
              <button className="btn" disabled={!!busy} onClick={() => act('status', { status: 'open' }, 'Reopened.')}>
                Reopen
              </button>
            ) : (
              <button className="btn" disabled={!!busy} onClick={() => act('status', { status: 'dismissed' }, 'Dismissed.')}>
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid g3 section">
        <div className="card stat">
          <div className="label">
            <span>Observed</span>
          </div>
          <div className="value">{fmt.n(f.sessionsLost)}</div>
          <div className="sub">
            sessions stopped here{f.beforeStep ? `, before ${lowerFirst(stepLabel(f.beforeStep) ?? '')}` : ''}. {fmt.n(f.sessionsAffected)} hit it in all.
          </div>
        </div>
        <div className="card stat">
          <div className="label">
            <span>Estimated</span>
          </div>
          <div className="value">{fmt.money(f.monthlyValueAtRisk, currency)}</div>
          <div className="sub">a month at risk, at the {fmt.pct(f.conversionPast, 0)} conversion of sessions that got past this step</div>
        </div>
        <div className="card">
          <h2>Agents it stopped</h2>
          <div className="stack">
            {Object.entries(f.byAgent)
              .sort((a, b) => b[1] - a[1])
              .map(([name, n]) => (
                <div key={name} className="between">
                  <AgentName name={name} />
                  <span className="muted">{n}</span>
                </div>
              ))}
          </div>
        </div>
      </div>

      <div className="card section">
        <h2>The change</h2>
        <p style={{ marginTop: 0 }}>{f.proposal.summary}</p>
        {f.sourcePage || f.paths.length > 0 ? (
          <dl className="kv" style={{ marginBottom: 12 }}>
            {f.sourcePage ? (
              <>
                <dt>Page read before it</dt>
                <dd className="mono">{f.sourcePage}</dd>
              </>
            ) : null}
            {f.paths.length > 0 ? (
              <>
                <dt>Seen on</dt>
                <dd className="mono">{f.paths.slice(0, 6).join(', ')}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {record?.drafting ? <div className="banner">Drafting the change with {providers.data?.available.find((p) => p.id === chosenProvider)?.label ?? chosenProvider}. Claude Code can take a minute.</div> : null}
        {record?.draftError ? <div className="banner warn">The draft failed: {record.draftError}</div> : null}
        {change ? (
          <div className="stack">
            <div className="between">
              <span className="mono small">{change.file}</span>
              <span className="faint small">{change.provider === 'rule' ? 'written by a rule' : `drafted with ${change.provider}`}</span>
            </div>
            <Diff {...(change.before !== undefined ? { before: change.before } : {})} after={change.after} />
          </div>
        ) : null}
        <div className="row-flex" style={{ marginTop: 14 }}>
          {f.proposal.needsDraft ? (
            <>
              <select value={chosenProvider ?? ''} onChange={(e) => setProvider(e.target.value)}>
                {providers.data?.available.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.ready}>
                    {p.label}
                    {p.ready ? '' : ' (not set up)'}
                  </option>
                ))}
              </select>
              <button className="btn" disabled={!!busy || record?.drafting || !chosenProvider} onClick={() => act('draft', { provider: chosenProvider }, 'Drafting started.')}>
                {record?.draft ? 'Draft again' : 'Draft the change'}
              </button>
            </>
          ) : null}
          <span className="grow" />
          {record?.prUrl ? (
            <a className="btn" href={record.prUrl} target="_blank" rel="noreferrer">
              Open pull request ↗
            </a>
          ) : null}
          <button className="btn primary" disabled={!!busy || !change || record?.status === 'published'} onClick={() => act('publish', {}, 'Published.')}>
            {record?.status === 'published' ? 'Published' : 'Confirm and publish'}
          </button>
        </div>
        {message ? <p className="muted small">{message}</p> : null}
        {providers.data && !providers.data.available.some((p) => p.ready) ? (
          <p className="muted small">
            No model is set up. Sign in to Claude Code on this machine, or add an Anthropic, OpenAI or Gemini key in <Link to="/settings">Settings</Link>.
          </p>
        ) : null}
      </div>

      <div className="grid g2 section">
        <div className="card">
          <h2>Test on real agents before release</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Runs the task agents were given, {runs} times, against your preview URL. A run passes if it gets past {f.beforeStep ? lowerFirst(stepLabel(f.beforeStep) ?? '') : 'this step'}.
          </p>
          <div className="row-flex">
            <select value={chosenRunner ?? ''} onChange={(e) => setRunner(e.target.value)}>
              {providers.data?.agents.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.ready}>
                  {p.label}
                  {p.ready ? '' : ' (not found)'}
                </option>
              ))}
            </select>
            <input type="number" min={1} max={50} value={runs} onChange={(e) => setRuns(Number(e.target.value))} style={{ width: 70 }} />
            <button className="btn" disabled={!!busy || !chosenRunner} onClick={() => act('test', { agent: chosenRunner, runs, phase: 'before' }, 'Runs queued.')}>
              Run before
            </button>
            <button className="btn" disabled={!!busy || !chosenRunner} onClick={() => act('test', { agent: chosenRunner, runs, phase: 'after' }, 'Runs queued.')}>
              Run after
            </button>
          </div>
          <div className="compare" style={{ marginTop: 14 }}>
            {(['before', 'after'] as const).map((phase) => (
              <div key={phase} className="box">
                <div className="faint small" style={{ textTransform: 'uppercase' }}>
                  {phase}
                </div>
                <div className="value">{f.runSummary[phase].runs ? fmt.pct(f.runSummary[phase].converted / f.runSummary[phase].runs, 1) : '—'}</div>
                <div className="muted small">
                  {f.runSummary[phase].converted} of {f.runSummary[phase].runs} runs got past
                </div>
              </div>
            ))}
          </div>
          {f.runs.length > 0 ? (
            <div className="list" style={{ marginTop: 12 }}>
              {f.runs.slice(-8).reverse().map((r) => (
                <div key={r.id} className="between small">
                  <span>
                    <span className="chip neutral">{r.phase}</span> {r.agent}
                  </span>
                  <span className={r.status === 'failed' ? 'down' : r.converted ? 'up' : 'muted'}>
                    {r.status === 'done' ? (r.converted ? 'got past' : `stopped${r.reachedStep ? ` after ${lowerFirst(stepLabel(r.reachedStep) ?? '')}` : ''}`) : r.status}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="card">
          <h2>After it shipped</h2>
          {f.impact ? (
            <>
              <div className="compare">
                {(['before', 'after'] as const).map((phase) => (
                  <div key={phase} className="box">
                    <div className="faint small" style={{ textTransform: 'uppercase' }}>
                      {phase} · {f.impact!.days} days
                    </div>
                    <div className="value">{fmt.pct(f.impact![phase].conversion, 1)}</div>
                    <div className="muted small">
                      converted · {fmt.n(f.impact![phase].sessions)} sessions · {fmt.pct(f.impact![phase].hitRate, 1)} hit this problem
                    </div>
                  </div>
                ))}
              </div>
              <p className="muted small">Published {record?.publishedAt ? fmt.date(record.publishedAt) : ''}. Conversion and the share of sessions that still hit this problem, before and after.</p>
            </>
          ) : (
            <p className="muted">Publish the change to watch conversion before and after it.</p>
          )}
        </div>
      </div>

      <div className="card section">
        <h2>Sessions it stopped</h2>
        <table>
          <tbody>
            {f.sessions.slice(0, 10).map((s) => (
              <tr key={s.id} className="click" onClick={() => navigate(`/sessions/${encodeURIComponent(s.id)}`)}>
                <td>
                  <AgentName name={s.agent.name} surface={s.agent.surface} />
                </td>
                <td className="small">{s.intent ? <span className="quote">“{s.intent}”</span> : <span className="faint">No stated task</span>}</td>
                <td className="num small">{fmt.date(s.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
