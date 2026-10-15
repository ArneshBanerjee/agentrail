import { AgentName, ErrorBox, Loading, Stat } from '../components.tsx'
import { fmt, navigate, useApi, useDays } from '../lib.ts'
import type { BreakdownRow } from '../types.ts'

type RevenueData = { currency: string; total: number; sessions: number; converted: number; byAgent: BreakdownRow[]; byIntent: BreakdownRow[]; byPage: BreakdownRow[] }

const Table = ({ title, rows, currency, first, agent, onRow }: { title: string; rows: BreakdownRow[]; currency: string; first: string; agent?: boolean; onRow?: (r: BreakdownRow) => void }) => (
  <div className="card">
    <h2>{title}</h2>
    <table>
      <thead>
        <tr>
          <th>{first}</th>
          <th className="num">Sessions</th>
          <th className="num">Converted</th>
          <th className="num">Revenue</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 12).map((r) => (
          <tr key={r.key} className={onRow ? 'click' : ''} onClick={() => onRow?.(r)}>
            <td className={agent ? '' : 'small mono'} style={{ maxWidth: 260, overflowWrap: 'anywhere' }}>
              {agent ? <AgentName name={r.label} /> : r.label}
            </td>
            <td className="num">{fmt.n(r.sessions)}</td>
            <td className="num">{fmt.pct(r.conversion, 0)}</td>
            <td className="num">{fmt.money(r.revenue, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

export const Revenue = () => {
  const [days] = useDays()
  const { data, error } = useApi<RevenueData>(`/api/revenue?days=${days}`)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading />
  return (
    <>
      <div className="grid g4">
        <Stat label="Revenue from agents" value={fmt.money(data.total, data.currency)} sub={`${days} days`} />
        <Stat label="Paying sessions" value={fmt.n(data.converted)} sub={`of ${fmt.n(data.sessions)} sessions`} />
        <Stat label="Conversion" value={fmt.pct(data.sessions ? data.converted / data.sessions : 0)} />
        <Stat label="Per paying session" value={fmt.money(data.converted ? data.total / data.converted : 0, data.currency)} />
      </div>
      <div className="section">
        <Table title="By agent" rows={data.byAgent} currency={data.currency} first="Agent" agent onRow={(r) => navigate(`/journeys?agent=${encodeURIComponent(r.key)}`)} />
      </div>
      <div className="grid g2 section">
        <Table title="By intent" rows={data.byIntent} currency={data.currency} first="Intent" onRow={(r) => navigate(`/journeys?intent=${encodeURIComponent(r.key)}`)} />
        <Table title="By landing page" rows={data.byPage} currency={data.currency} first="Page" />
      </div>
    </>
  )
}
