import { Bar, Empty, ErrorBox, Link, Loading } from '../components.tsx'
import { fmt, useApi, useDays } from '../lib.ts'
import type { IntentGroup } from '../types.ts'

export const Intents = () => {
  const [days] = useDays()
  const { data, error } = useApi<{ withIntent: number; total: number; intents: IntentGroup[] }>(`/api/intents?days=${days}`)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  const top = Math.max(...data.intents.map((i) => i.sessions), 1)
  return (
    <>
      <div className="banner">
        <span>
          <span className="bold">{fmt.n(data.withIntent)}</span> of {fmt.n(data.total)} sessions stated their task. Agents state a task through the intake endpoint, your MCP server, or{' '}
          <span className="mono">intent()</span> in the SDK.
        </span>
        <Link to="/settings#intents" className="btn">
          Name intents
        </Link>
      </div>
      {data.intents.length === 0 ? (
        <div className="card">
          <Empty title="No stated tasks yet">
            <p>Add the intake line to your llms.txt so agents can say what they came to do.</p>
            <Link to="/setup" className="btn">
              Show me how
            </Link>
          </Empty>
        </div>
      ) : null}
      <div className="grid g2">
        {data.intents.map((i) => (
          <div key={i.id} className="card">
            <div className="between">
              <Link to={`/journeys?intent=${encodeURIComponent(i.id)}`}>
                <span className="bold" style={{ fontSize: 16 }}>
                  {i.label}
                </span>
              </Link>
              <span className="muted small">{fmt.n(i.sessions)} sessions</span>
            </div>
            <div style={{ margin: '8px 0 12px' }}>
              <Bar value={i.sessions / top} />
            </div>
            <div className="grid g3" style={{ gap: 8 }}>
              <div>
                <div className="faint small">Converts</div>
                <div className="bold">{fmt.pct(i.conversion, 0)}</div>
              </div>
              <div>
                <div className="faint small">Customers</div>
                <div className="bold">{fmt.n(i.converted)}</div>
              </div>
              <div>
                <div className="faint small">Revenue</div>
                <div className="bold">{fmt.money(i.revenue, 'usd', true)}</div>
              </div>
            </div>
            <div className="stack" style={{ marginTop: 12 }}>
              {i.quotes.map((q) => (
                <div key={q} className="quote small">
                  “{q}”
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
