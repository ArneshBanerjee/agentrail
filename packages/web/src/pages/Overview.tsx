import { useState } from 'react'
import { AgentName, Change, ColumnFunnel, Empty, ErrorBox, LabelChip, Link, Loading, Stat } from '../components.tsx'
import { FixDialog } from '../dialog.tsx'
import { api, fmt, lowerFirst, navigate, session, useApi, useDays, useLive } from '../lib.ts'
import type { SessionSummary, Summary } from '../types.ts'

export const Overview = () => {
  const [days] = useDays()
  const summary = useApi<Summary>(`/api/summary?days=${days}&fixes=3&intents=3`)
  const [open, setOpen] = useState<string>()
  const arrivals = useApi<{ arrivals: SessionSummary[] }>(`/api/arrivals?days=${days}&limit=6`)
  useLive(undefined, () => {
    summary.reload()
    arrivals.reload()
  })
  if (summary.error) return <ErrorBox error={summary.error} />
  if (!summary.data) return <Loading />
  const s = summary.data
  const o = s.overview
  const totalIntents = o.withIntent
  const main = s.intents[0]
  const biggest = s.fixes[0]
  const biggestLive = biggest?.record?.status === 'published'
  if (o.sessions === 0) {
    return (
      <div className="card">
        <Empty title="No agent sessions yet">
          <p>Add a collector to your docs, API or MCP server, and agents will show up here as they arrive.</p>
          <p className="row-flex" style={{ justifyContent: 'center' }}>
            <Link to="/setup" className="btn primary">
              Set up a collector
            </Link>
          </p>
          <p className="small muted">Or look around first with a month of sample traffic.</p>
          <p className="row-flex" style={{ justifyContent: 'center' }}>
            <button
              className="btn"
              onClick={async () => {
                const demo = await api<{ id: string }>('/api/demo', { method: 'POST' })
                session.setWorkspace(demo.id)
                window.location.href = '/'
              }}
            >
              Open the demo
            </button>
          </p>
        </Empty>
      </div>
    )
  }
  return (
    <>
      {open ? <FixDialog fixKey={open} onClose={() => setOpen(undefined)} onPublished={summary.reload} /> : null}
      <div className="grid g4">
        <Stat
          label="Traffic"
          aside={
            <span className="live">
              <span className={`dot ${o.live > 0 ? 'on' : ''}`} /> {o.live} live
            </span>
          }
          value={
            <>
              {fmt.n(o.sessions)} <span className="small">{o.sessionsChange !== undefined ? <Change value={o.sessionsChange} /> : null}</span>
            </>
          }
          sub={`sessions · ${days === 1 ? '24 hours' : `${days} days`}`}
        />
        <Stat
          label="Conversion rate"
          value={
            <>
              {fmt.pct(o.conversion)} <span className="small">{o.conversionChange !== undefined ? <Change value={o.conversionChange} points /> : null}</span>
            </>
          }
          sub={`${fmt.n(o.converted)} sessions`}
        />
        <Stat
          label="Main intent"
          text
          value={main ? main.label : '—'}
          sub={main ? `${fmt.pct(main.sessions / Math.max(totalIntents, 1), 0)} of ${fmt.n(totalIntents)} intents` : 'No stated tasks yet'}
        />
        <div className={`card stat ${biggest ? 'clickcard' : ''}`} onClick={() => biggest && setOpen(biggest.key)} role={biggest ? 'button' : undefined} tabIndex={biggest ? 0 : undefined}>
          <div className="label">
            <span>Biggest fix {biggest ? '↗' : ''}</span>
          </div>
          <div className="value text">{biggest ? (biggest.where ?? biggest.action) : 'Nothing blocking'}</div>
          <div className="sub">
            {biggest ? (
              <>
                {biggestLive ? <span className="islive">live · </span> : null}
                {fmt.n(biggest.sessionsLost)} sessions · {days === 1 ? '24 hours' : `${days} days`}
              </>
            ) : (
              'No blockers found'
            )}
          </div>
        </div>
      </div>

      <div className="card section">
        <h2>
          Funnel <span className="faint small">{fmt.n(o.sessions)} sessions</span>
        </h2>
        <ColumnFunnel rows={s.funnel} agents={s.agents.map((a) => ({ label: a.label, sessions: a.sessions }))} />
      </div>

      <div className="grid g2 section">
        <div style={{ display: 'contents' }}>
          <div className="card">
            <h2>
              Intents <Link to="/intents">All intents</Link>
            </h2>
            <div className="list">
              {s.intents.length === 0 ? <span className="muted">No stated tasks in this window.</span> : null}
              {s.intents.map((i) => (
                <Link key={i.id} to={`/sessions?intent=${encodeURIComponent(i.id)}`}>
                  <div className="between">
                    <span className="bold">{i.label}</span>
                    <span className="muted small">
                      {fmt.n(i.sessions)} · converts {fmt.pct(i.conversion, 0)}
                    </span>
                  </div>
                  {i.quotes[0] ? <div className="quote small">“{i.quotes[0]}”</div> : null}
                </Link>
              ))}
            </div>
          </div>
          <div className="card">
            <h2>
              Fix next <Link to="/fixes">All fixes</Link>
            </h2>
            <div className="list">
              {s.fixes.length === 0 ? <span className="muted">Nothing is blocking agents in this window.</span> : null}
              {s.fixes.map((f) => (
                <div key={f.key} className="between">
                  <div style={{ minWidth: 0 }}>
                    <div className="bold">{f.title}</div>
                    <div className="muted small">
                      {fmt.n(f.sessionsLost)} sessions lost{f.beforeStep ? ` · before ${lowerFirst(s.funnelSteps.find((x) => x.id === f.beforeStep)?.label ?? f.beforeStep)}` : ''}
                    </div>
                  </div>
                  <button className="btn" onClick={() => setOpen(f.key)}>
                    {f.record?.status === 'published' ? 'Live' : 'Fix'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid g2 section">
        <div className="card">
          <h2>
            Revenue by agent <Link to="/revenue">Revenue</Link>
          </h2>
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th className="num">Sessions</th>
                <th className="num">Converted</th>
                <th className="num">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {s.agents.slice(0, 6).map((a) => (
                <tr key={a.key} className="click" onClick={() => navigate(`/sessions?agent=${encodeURIComponent(a.key)}`)}>
                  <td>
                    <AgentName name={a.label} />
                  </td>
                  <td className="num">{fmt.n(a.sessions)}</td>
                  <td className="num">{fmt.pct(a.conversion, 0)}</td>
                  <td className="num">{fmt.money(a.revenue, s.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>All agents</td>
                <td className="num">{fmt.n(o.sessions)}</td>
                <td className="num">{fmt.pct(o.conversion, 0)}</td>
                <td className="num">{fmt.money(o.revenue, s.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="card">
          <h2>
            Arrivals <Link to="/arrivals">Live feed</Link>
          </h2>
          <div className="feed">
            {(arrivals.data?.arrivals ?? []).map((a) => (
              <Link key={a.id} to={`/sessions/${encodeURIComponent(a.id)}`} className="item">
                <AgentName name={a.agent.name} surface={a.agent.surface} />
                <span className="row-flex">
                  <LabelChip label={a.agent.label} />
                  <span className="faint small">{a.live ? 'now' : fmt.ago(a.endedAt)}</span>
                </span>
                <span className="muted small">found you via {a.discovery.via}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
