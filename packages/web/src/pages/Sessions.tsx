import { useEffect } from 'react'
import { AgentName, BlockerLine, Clock, colorOf, Empty, ErrorBox, LabelChip, Link, Loading, Pips } from '../components.tsx'
import { fmt, navigate, setQuery, useApi, useDays, useLive, useQuery } from '../lib.ts'
import type { AgentRow, IntentGroup, SessionDetail, SessionSummary, Summary } from '../types.ts'

const AgentIcon = ({ name }: { name: string }) => (
  <span className="avatar" title={name} style={{ background: name === 'Unnamed' ? 'var(--faint)' : colorOf(name) }}>
    {name === 'Unnamed' ? '?' : name.slice(0, 2)}
  </span>
)

/** Every agent session: the ones happening now, then the rest. */
export const Sessions = () => {
  const [days] = useDays()
  const q = useQuery()
  const params = new URLSearchParams({ days: String(days), limit: '200' })
  for (const k of ['agent', 'stoppedAt', 'intent', 'q', 'blocker', 'reached']) {
    const v = q.get(k)
    if (v) params.set(k, v)
  }
  const live = useApi<{ arrivals: SessionSummary[] }>(`/api/arrivals?days=1&limit=50`)
  const list = useApi<{ total: number; sessions: SessionSummary[] }>(`/api/sessions?${params}`)
  const summary = useApi<Summary>(`/api/summary?days=${days}&fixes=0&intents=0`)
  const agents = useApi<{ agents: AgentRow[] }>(`/api/agents?days=${days}`)
  const intents = useApi<{ intents: IntentGroup[] }>(`/api/intents?days=${days}`)
  useLive(undefined, () => {
    live.reload()
    list.reload()
  })
  // A live clock needs fresh steps too, not only arrivals: poll while anything is live.
  const anyLive = live.data?.arrivals.some((a) => a.live)
  useEffect(() => {
    if (!anyLive) return
    const t = setInterval(live.reload, 3000)
    return () => clearInterval(t)
  }, [anyLive, live.reload])

  const steps = (summary.data?.funnelSteps ?? []).filter((s) => s.id !== 'mcp_connected')
  const nowLive = (live.data?.arrivals ?? []).filter((a) => a.live)
  const shown = (list.data?.sessions ?? []).filter((s) => !q.get('reached') || s.reached.includes(q.get('reached')!))
  return (
    <>
      <div className="card">
        <h2>
          Live
          <span className="live">
            <span className={`dot ${nowLive.length > 0 ? 'on' : ''}`} /> {nowLive.length} live
          </span>
        </h2>
        {nowLive.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No agent is on your product right now. Sessions appear here the moment one arrives.</p> : null}
        {nowLive.map((s) => (
          <div key={s.id} className="liverow" onClick={() => navigate(`/sessions/${encodeURIComponent(s.id)}`)}>
            <span className="dot on" />
            <span className="row-flex" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
              <AgentIcon name={s.agent.name} />
              <span style={{ minWidth: 0 }}>
                <div className={`intent ${s.intent ? '' : 'faint'}`} title={s.intent ? undefined : s.inferredIntent ? 'Inferred from the pages it read' : undefined}>
                  {s.intent ?? (s.inferredIntent ? `${s.inferredIntent} (inferred)` : 'No intent yet')}
                </div>
                <div className="sub">{s.host ?? ''}</div>
              </span>
            </span>
            <span className="small" style={{ minWidth: 0 }}>
              {s.lastStep ? (
                <>
                  <b className={s.lastStep.failed ? 'down' : ''}>{s.lastStep.name}</b> <span className="mono faint">{s.lastStep.detail}</span>
                </>
              ) : null}
            </span>
            <Pips steps={steps} reached={s.reached} />
            <span className="small">{s.stage?.label ?? 'Discovered'}</span>
            <span className="clock">
              <Clock ms={s.durationMs} live />
            </span>
          </div>
        ))}
      </div>

      <div className="card section">
        <h2>
          Recent <span className="faint small">{list.data ? `${fmt.n(list.data.total)} sessions` : ''}</span>
        </h2>
        <div className="row-flex" style={{ marginBottom: 12 }}>
          <input type="text" placeholder="Search" defaultValue={q.get('q') ?? ''} onChange={(e) => setQuery({ q: e.target.value })} style={{ minWidth: 220 }} />
          <select value={q.get('agent') ?? ''} onChange={(e) => setQuery({ agent: e.target.value })} aria-label="Agent">
            <option value="">Agent</option>
            {agents.data?.agents.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
          <select value={q.get('reached') ?? ''} onChange={(e) => setQuery({ reached: e.target.value })} aria-label="Reached">
            <option value="">Reached</option>
            {steps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <select value={q.get('stoppedAt') ?? ''} onChange={(e) => setQuery({ stoppedAt: e.target.value })} aria-label="Stopped">
            <option value="">Stopped before</option>
            {steps.slice(1).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <select value={q.get('intent') ?? ''} onChange={(e) => setQuery({ intent: e.target.value })} aria-label="Intent">
            <option value="">Intent</option>
            {intents.data?.intents.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
          {q.get('blocker') ? (
            <button className="btn" onClick={() => setQuery({ blocker: undefined })}>
              Blocker filter ✕
            </button>
          ) : null}
        </div>
        {list.error ? <ErrorBox error={list.error} /> : null}
        {!list.data ? <Loading /> : shown.length === 0 ? <Empty title="No sessions match" /> : null}
        {shown.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Intent</th>
                <th>Reached</th>
                <th className="num">Steps</th>
                <th className="num">Duration</th>
                <th className="num">Started</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id} className="click" onClick={() => navigate(`/sessions/${encodeURIComponent(s.id)}`)}>
                  <td>
                    <AgentIcon name={s.agent.name} />
                  </td>
                  <td className="small" style={{ maxWidth: 380 }}>
                    {s.intent ? s.intent : s.inferredIntent ? (
                      <span className="muted" title="Inferred from the pages it read">
                        {s.inferredIntent} <span className="chip inferred">inferred</span>
                      </span>
                    ) : (
                      <span className="faint">No intent</span>
                    )}
                    {s.stoppedBy && !s.live ? <div className="down small mono">{s.stoppedBy.detail}</div> : null}
                  </td>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>
                    <Pips steps={steps} reached={s.reached} stoppedAt={s.stoppedBy && !s.live ? s.stoppedAt : undefined} /> {s.mcpConnected && s.stage?.id === 'mcp_connected' ? 'MCP connected' : (s.stage?.label ?? 'Discovered')}
                  </td>
                  <td className="num">{s.steps}</td>
                  <td className="num">{fmt.duration(s.durationMs)}</td>
                  <td className="num small">{s.live ? <span className="chip good">live</span> : fmt.ago(s.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  )
}

/** One session, start to stop, following along while it is live. */
export const Session = ({ id }: { id: string }) => {
  const [days] = useDays()
  const { data, error, reload } = useApi<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}?days=${Math.max(days, 90)}`)
  useLive(undefined, reload)
  useEffect(() => {
    if (!data?.live) return
    const t = setInterval(reload, 2000)
    return () => clearInterval(t)
  }, [data?.live, reload])
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const phases: { phase: string; items: SessionDetail['timeline'] }[] = []
  for (const item of data.timeline) {
    const last = phases.at(-1)
    if (last && last.phase === item.phase) last.items.push(item)
    else phases.push({ phase: item.phase, items: [item] })
  }
  const time = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <div className="grid g21">
      <div className="card">
        <div className="row-flex small muted" style={{ gap: 10 }}>
          <AgentName name={data.agent.name} />
          {data.agent.version ? <span className="mono">{data.agent.version}</span> : null}
          <LabelChip label={data.agent.label} />
          {data.live ? (
            <span className="live">
              <span className="dot on" /> Live
            </span>
          ) : null}
          {data.runId ? <span className="chip accent">test run</span> : null}
          {data.host ? <span className="mono">{data.host}</span> : null}
          <span className="mono">
            <Clock ms={data.durationMs} live={data.live} />
          </span>
        </div>
        <div className="bigquote">
          {data.intent ? (
            `“${data.intent}”`
          ) : data.inferredIntent ? (
            <span className="muted">
              {data.inferredIntent} <span className="chip inferred">inferred from pages read</span>
            </span>
          ) : (
            <span className="faint">No intent yet</span>
          )}
        </div>
        <div className="muted small">
          {data.intentVia ? `task via ${data.intentVia} · ` : ''}found you via {data.discovery.via} · {time(data.startedAt)}
        </div>
        <div className="stepper">
          {data.stepper.map((s) => (
            <div key={s.id} className={`st ${s.at !== undefined ? 'on' : s.id === data.stoppedAt && !data.live ? 'stop' : ''}`}>
              <span className="d" />
              <div className="n">{s.label}</div>
              <div className="t">{s.at !== undefined ? (s.at === data.startedAt ? time(s.at).slice(0, 5) : `+${fmt.duration(s.at - data.startedAt)}`) : '—'}</div>
            </div>
          ))}
        </div>
        <h2 style={{ marginTop: 18 }}>Steps</h2>
        {phases.map((p, i) => (
          <div key={`${p.phase}-${i}`} className="phase">
            <h3>{p.phase}</h3>
            {p.items.map((item) => {
              const bad = ((item.status ?? 0) >= 400 && !item.name.startsWith('poll')) || item.marks.some((m) => m.kind === 'blocked')
              return (
                <div key={item.eventId} className={`stepitem ${bad ? 'bad' : ''}`}>
                  <span className="tm">{time(item.ts)}</span>
                  <span className="bul" />
                  <span>
                    <div className="nm">{item.name}</div>
                    <div className="dt">{item.detail}</div>
                  </span>
                  <span className="row-flex" style={{ justifyContent: 'flex-end' }}>
                    {item.marks.map((m, k) => (
                      <span key={k} className={`chip ${m.kind === 'step' ? 'good' : m.kind === 'blocked' ? 'bad' : m.kind === 'warning' ? 'inferred' : 'neutral'}`}>
                        {m.label}
                      </span>
                    ))}
                  </span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="stack" style={{ gap: 16, alignContent: 'start' }}>
        <div className="card">
          <h2>Outcome</h2>
          <dl className="kv">
            <dt>Got to</dt>
            <dd className="bold">{data.gotTo?.label ?? '—'}</dd>
            <dt>Stopped at</dt>
            <dd className={data.live ? '' : data.stoppedAtLabel ? 'down bold' : 'up bold'}>{data.live ? 'Still going' : (data.stoppedAtLabel ?? 'Completed')}</dd>
            <dt>Failed calls</dt>
            <dd>
              {data.failedCalls.failed} of {data.failedCalls.of}
            </dd>
            <dt>Revenue</dt>
            <dd>{data.revenue > 0 ? fmt.money(data.revenue, data.currency) : '—'}</dd>
            <dt>Evidence</dt>
            <dd className="small muted">{data.agent.evidence}</dd>
          </dl>
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
                  <Link to={`/fixes/${encodeURIComponent(b.key)}`} className="small">
                    <span style={{ color: 'var(--accent)' }}>See the fix →</span>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
