import { useState } from 'react'
import { AgentName, Empty, ErrorBox, LabelChip, Link, Loading } from '../components.tsx'
import { fmt, useApi, useDays, useLive, type Arrival } from '../lib.ts'
import type { SessionSummary } from '../types.ts'

/** Who is arriving, as it happens. The list of sessions refreshes when arrivals settle. */
export const Arrivals = () => {
  const [days] = useDays()
  const sessions = useApi<{ arrivals: SessionSummary[] }>(`/api/arrivals?days=${days}&limit=50`)
  const [feed, setFeed] = useState<(Arrival & { key: number })[]>([])
  useLive(
    (a) => setFeed((f) => [{ ...a, key: Date.now() + Math.random() }, ...f].slice(0, 30)),
    () => sessions.reload(),
  )
  if (sessions.error) return <ErrorBox error={sessions.error} />
  if (!sessions.data) return <Loading />
  const live = sessions.data.arrivals.filter((a) => a.live)
  return (
    <div className="grid g21">
      <div className="card">
        <h2>
          Sessions, newest first <span className="faint small">{live.length} live now</span>
        </h2>
        {sessions.data.arrivals.length === 0 ? <Empty title="No arrivals in this window" /> : null}
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Found you via</th>
              <th>Label</th>
              <th>Task or first search</th>
              <th className="num">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {sessions.data.arrivals.map((a) => (
              <tr key={a.id}>
                <td>
                  <Link to={`/sessions/${encodeURIComponent(a.id)}`}>
                    <AgentName name={a.agent.name} surface={a.agent.surface} />
                  </Link>
                </td>
                <td className="muted">{a.discovery.via}</td>
                <td>
                  <LabelChip label={a.agent.label} />
                </td>
                <td className="small" style={{ maxWidth: 320 }}>
                  {a.intent ? <span className="quote">“{a.intent}”</span> : a.searches[0] ? <span className="mono">search: {a.searches[0]}</span> : <span className="faint">—</span>}
                </td>
                <td className="num small">{a.live ? <span className="chip good">live</span> : fmt.ago(a.endedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card" style={{ alignSelf: 'start' }}>
        <h2>Live requests</h2>
        {feed.length === 0 ? <p className="muted small">Waiting for agents. Each request from an agent appears here the moment it is collected.</p> : null}
        <div className="feed">
          {feed.map((a) => (
            <div key={a.key} className="item fresh">
              <AgentName name={a.agent} surface={a.surface} />
              <LabelChip label={a.label} />
              <span className="mono small muted">{a.path ?? a.kind.replaceAll('_', ' ')}</span>
              <span className="faint small">{fmt.ago(a.ts)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
