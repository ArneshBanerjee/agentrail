import { AgentName, Bar, ErrorBox, LabelChip, Loading } from '../components.tsx'
import { fmt, navigate, useApi, useDays } from '../lib.ts'
import type { AgentRow, BreakdownRow } from '../types.ts'

const LABELS = [
  { id: 'verified', text: 'Signed by the agent’s operator, checked against its published keys (Web Bot Auth).' },
  { id: 'declared', text: 'The agent said who it is, in its user agent or its MCP client name.' },
  { id: 'inferred', text: 'Nothing named it, but it behaves like an agent. Grouped by behaviour, never guessed.' },
]

export const Agents = () => {
  const [days] = useDays()
  const { data, error } = useApi<{ agents: AgentRow[]; surfaces: BreakdownRow[] }>(`/api/agents?days=${days}`)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const total = data.agents.reduce((n, a) => n + a.sessions, 0)
  return (
    <>
      <div className="grid g3">
        {LABELS.map((l) => (
          <div key={l.id} className="card">
            <h2>
              <LabelChip label={l.id} />
              <span className="faint small">{fmt.n(data.agents.reduce((n, a) => n + (a.labels[l.id] ?? 0), 0))} sessions</span>
            </h2>
            <p className="muted small" style={{ margin: 0 }}>
              {l.text}
            </p>
          </div>
        ))}
      </div>
      <div className="card section">
        <h2>Every agent, named, with the evidence behind the name</h2>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Labels</th>
              <th>Evidence</th>
              <th>How it found you</th>
              <th className="num">Sessions</th>
              <th className="num">Converted</th>
              <th className="num">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map((a) => (
              <tr key={a.key} className="click" onClick={() => navigate(`/sessions?agent=${encodeURIComponent(a.key)}`)}>
                <td>
                  <AgentName name={a.label} surface={a.key === 'unnamed' ? undefined : a.surface} />
                  <div className="faint small">{a.operator !== 'unknown' ? a.operator : 'grouped by behaviour'}</div>
                </td>
                <td>
                  <div className="stack" style={{ gap: 4 }}>
                    {Object.entries(a.labels).map(([label, n]) => (
                      <span key={label} className="row-flex">
                        <LabelChip label={label} /> <span className="faint small">{n}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="small" style={{ maxWidth: 300 }}>
                  {a.evidence.map((e) => (
                    <div key={e.text} className="muted">
                      {e.text} <span className="faint">({e.sessions})</span>
                    </div>
                  ))}
                </td>
                <td className="small">
                  {a.discovery.slice(0, 3).map((d) => (
                    <div key={d.key} className="muted">
                      {d.label} <span className="faint">({d.sessions})</span>
                    </div>
                  ))}
                </td>
                <td className="num">
                  {fmt.n(a.sessions)}
                  <div className="faint small">{fmt.pct(a.sessions / Math.max(total, 1), 0)}</div>
                </td>
                <td className="num">{fmt.pct(a.conversion, 0)}</td>
                <td className="num">{fmt.money(a.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card section">
        <h2>Where agents run</h2>
        <div className="grid g4">
          {data.surfaces.map((s) => (
            <div key={s.key} className="stack">
              <div className="between">
                <span className="bold" style={{ textTransform: 'capitalize' }}>
                  {s.label}
                </span>
                <span className="muted small">{fmt.n(s.sessions)}</span>
              </div>
              <Bar value={s.sessions / Math.max(total, 1)} />
              <span className="faint small">converts {fmt.pct(s.conversion, 0)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
