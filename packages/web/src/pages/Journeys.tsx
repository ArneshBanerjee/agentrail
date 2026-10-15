import { AgentName, BlockerLine, Empty, ErrorBox, LabelChip, Link, Loading } from '../components.tsx'
import { fmt, navigate, setQuery, useApi, useDays, useQuery, lowerFirst } from '../lib.ts'
import type { AgentRow, IntentGroup, SessionDetail, SessionSummary, Summary } from '../types.ts'

export const Journeys = () => {
  const [days] = useDays()
  const q = useQuery()
  const params = new URLSearchParams({ days: String(days), limit: '200' })
  for (const k of ['agent', 'stoppedAt', 'intent', 'q', 'blocker']) {
    const v = q.get(k)
    if (v) params.set(k, v)
  }
  const list = useApi<{ total: number; sessions: SessionSummary[] }>(`/api/sessions?${params}`)
  const summary = useApi<Summary>(`/api/summary?days=${days}&fixes=0&intents=0`)
  const agents = useApi<{ agents: AgentRow[] }>(`/api/agents?days=${days}`)
  const intents = useApi<{ intents: IntentGroup[] }>(`/api/intents?days=${days}`)
  const steps = summary.data?.funnelSteps ?? []
  const label = (id?: string) => steps.find((s) => s.id === id)?.label ?? id
  return (
    <>
      <div className="card row-flex" style={{ gap: 12 }}>
        <input type="text" placeholder="Search tasks, pages, searches" defaultValue={q.get('q') ?? ''} onChange={(e) => setQuery({ q: e.target.value })} style={{ minWidth: 240 }} />
        <select value={q.get('agent') ?? ''} onChange={(e) => setQuery({ agent: e.target.value })}>
          <option value="">All agents</option>
          {agents.data?.agents.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </select>
        <select value={q.get('intent') ?? ''} onChange={(e) => setQuery({ intent: e.target.value })}>
          <option value="">All intents</option>
          {intents.data?.intents.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </select>
        <select value={q.get('stoppedAt') ?? ''} onChange={(e) => setQuery({ stoppedAt: e.target.value })}>
          <option value="">Any outcome</option>
          {steps.slice(1).map((s) => (
            <option key={s.id} value={s.id}>
              Stopped before {lowerFirst(s.label)}
            </option>
          ))}
        </select>
        {q.get('blocker') ? (
          <button className="btn" onClick={() => setQuery({ blocker: undefined })}>
            Blocker filter ✕
          </button>
        ) : null}
        <span className="grow" />
        <span className="muted small">{list.data ? `${fmt.n(list.data.total)} sessions` : ''}</span>
      </div>
      <div className="card section">
        {list.error ? <ErrorBox error={list.error} /> : null}
        {!list.data ? <Loading /> : list.data.sessions.length === 0 ? <Empty title="No sessions match" /> : null}
        {list.data && list.data.sessions.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Task</th>
                <th>Got to</th>
                <th>Stopped by</th>
                <th className="num">Revenue</th>
                <th className="num">Started</th>
              </tr>
            </thead>
            <tbody>
              {list.data.sessions.map((s) => (
                <tr key={s.id} className="click" onClick={() => navigate(`/journeys/${encodeURIComponent(s.id)}`)}>
                  <td>
                    <AgentName name={s.agent.name} surface={s.agent.surface} />
                    <div className="faint small">via {s.discovery.via}</div>
                  </td>
                  <td className="small" style={{ maxWidth: 320 }}>
                    {s.intent ? <span className="quote">“{s.intent}”</span> : <span className="faint">No stated task</span>}
                  </td>
                  <td className="small">{label([...steps].reverse().find((x) => s.reached.includes(x.id))?.id)}</td>
                  <td className="small" style={{ maxWidth: 280 }}>
                    {s.stoppedBy ? <span className="down">{s.stoppedBy.detail}</span> : s.stoppedAt ? <span className="faint">left before {lowerFirst(label(s.stoppedAt) ?? '')}</span> : <span className="chip good">completed</span>}
                  </td>
                  <td className="num">{s.revenue > 0 ? fmt.money(s.revenue, s.currency) : <span className="faint">—</span>}</td>
                  <td className="num small">{s.live ? <span className="chip good">live</span> : fmt.date(s.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  )
}

export const Journey = ({ id }: { id: string }) => {
  const [days] = useDays()
  const { data, error } = useApi<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}?days=${Math.max(days, 90)}`)
  const summary = useApi<Summary>(`/api/summary?days=${days}&fixes=0&intents=0`)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const steps = summary.data?.funnelSteps ?? []
  return (
    <>
      <div className="card">
        <div className="between">
          <div className="row-flex" style={{ gap: 12 }}>
            <AgentName name={data.agent.name} surface={data.agent.surface} />
            <LabelChip label={data.agent.label} />
            {data.live ? <span className="chip good">live</span> : null}
            {data.runId ? <span className="chip accent">test run</span> : null}
          </div>
          <span className="muted small">
            {fmt.date(data.startedAt)} · {fmt.clock(data.durationMs)}
          </span>
        </div>
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          {data.agent.evidence}
        </p>
        {data.intent ? (
          <p style={{ margin: '12px 0 0' }}>
            <span className="muted">Task: </span>
            <span className="quote">“{data.intent}”</span>
          </p>
        ) : null}
      </div>
      <div className="grid g21 section">
        <div className="card">
          <h2>Journey, start to stop</h2>
          <div className="timeline">
            {data.timeline.map((item) => (
              <div key={item.eventId} className="item">
                <span className="t">{fmt.clock(item.offsetMs)}</span>
                <span className={(item.status ?? 0) >= 400 || item.marks.some((m) => m.kind === 'blocked') ? 'bad' : ''}>{item.text}</span>
                <span className="row-flex" style={{ justifyContent: 'flex-end' }}>
                  {item.marks.map((m, i) => (
                    <span key={i} className={`chip ${m.kind === 'step' ? 'good' : m.kind === 'blocked' ? 'bad' : 'neutral'}`}>
                      {m.label}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="stack" style={{ gap: 16, alignContent: 'start' }}>
          <div className="card">
            <h2>Outcome</h2>
            <dl className="kv">
              <dt>Got to</dt>
              <dd className="bold">{data.gotTo?.label ?? '—'}</dd>
              <dt>Stopped at</dt>
              <dd className={data.stoppedAtLabel ? 'down bold' : 'up bold'}>{data.stoppedAtLabel ?? 'Completed'}</dd>
              <dt>Failed calls</dt>
              <dd>
                {data.failedCalls.failed} of {data.failedCalls.of}
              </dd>
              <dt>Revenue</dt>
              <dd>{data.revenue > 0 ? fmt.money(data.revenue, data.currency) : '—'}</dd>
              <dt>Found you via</dt>
              <dd>{data.discovery.via}</dd>
              {data.landingPath ? (
                <>
                  <dt>Landed on</dt>
                  <dd className="mono">{data.landingPath}</dd>
                </>
              ) : null}
              {data.mcpConnected ? (
                <>
                  <dt>MCP</dt>
                  <dd>Connected</dd>
                </>
              ) : null}
            </dl>
            <div className="steps" style={{ marginTop: 14 }}>
              {steps.map((s) => (
                <span key={s.id} className={`s ${data.reached.includes(s.id) ? 'done' : s.id === data.stoppedAt ? 'stop' : ''}`}>
                  {s.label}
                </span>
              ))}
            </div>
          </div>
          {data.searches.length > 0 ? (
            <div className="card">
              <h2>What it searched for</h2>
              {data.searches.map((s, i) => (
                <div key={i} className="mono small">
                  {s}
                </div>
              ))}
            </div>
          ) : null}
          {data.blockerList.length > 0 ? (
            <div className="card">
              <h2>What blocked it</h2>
              <div className="list">
                {data.blockerList.map((b, i) => (
                  <div key={i} className="stack" style={{ gap: 4 }}>
                    <BlockerLine blocker={b} />
                    {b.after ? <span className="faint small">after reading {b.after}</span> : null}
                    <Link to={`/fixes/${encodeURIComponent(b.key)}`} className="small" >
                      <span style={{ color: 'var(--accent)' }}>See the fix →</span>
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
