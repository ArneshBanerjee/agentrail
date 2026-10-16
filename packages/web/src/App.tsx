import { useEffect, useState, type ReactNode } from 'react'
import { Link, Toasts } from './components.tsx'
import { api, ApiError, connectLive, session, useApi, useDays, useLiveState, useLocation, useRange } from './lib.ts'
import { Agents } from './pages/Agents.tsx'
import { Arrivals } from './pages/Arrivals.tsx'
import { FixDetail, Fixes } from './pages/Fixes.tsx'
import { Intents } from './pages/Intents.tsx'
import { Overview } from './pages/Overview.tsx'
import { Revenue } from './pages/Revenue.tsx'
import { Session, Sessions } from './pages/Sessions.tsx'
import { Settings } from './pages/Settings.tsx'
import { Setup } from './pages/Setup.tsx'
import type { Me } from './types.ts'

const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/arrivals', label: 'Arrivals' },
  { to: '/agents', label: 'Agents' },
  { to: '/sessions', label: 'Sessions' },
  { to: '/intents', label: 'Intents' },
  { to: '/revenue', label: 'Revenue' },
  { to: '/fixes', label: 'Fixes' },
  { to: '/setup', label: 'Setup' },
  { to: '/settings', label: 'Settings' },
]

const route = (path: string): { title: string; crumb?: string; node: ReactNode } => {
  const [, first, second] = path.split('?')[0]!.split('/')
  switch (first) {
    case '':
    case undefined:
      return { title: 'Overview', node: <Overview /> }
    case 'arrivals':
      return { title: 'Arrivals', node: <Arrivals /> }
    case 'agents':
      return { title: 'Agents', node: <Agents /> }
    case 'sessions':
    case 'journeys':
      return second ? { title: 'Sessions', crumb: 'One session', node: <Session id={decodeURIComponent(second)} /> } : { title: 'Sessions', node: <Sessions /> }
    case 'intents':
      return { title: 'Intents', node: <Intents /> }
    case 'revenue':
      return { title: 'Revenue', node: <Revenue /> }
    case 'fixes':
      return second ? { title: 'Fixes', crumb: 'One fix', node: <FixDetail fixKey={decodeURIComponent(second)} /> } : { title: 'Fixes', node: <Fixes /> }
    case 'setup':
      return { title: 'Setup', node: <Setup /> }
    case 'settings':
      return { title: 'Settings', node: <Settings /> }
    default:
      return { title: 'Not found', node: <div className="empty">No such page.</div> }
  }
}

const SignIn = ({ onDone }: { onDone: () => void }) => {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string>()
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100%' }}>
      <form
        className="card stack"
        style={{ width: 360 }}
        onSubmit={async (e) => {
          e.preventDefault()
          session.setToken(token)
          try {
            await api('/api/me')
            onDone()
          } catch {
            session.setToken(undefined)
            setError('That token was not accepted.')
          }
        }}
      >
        <div className="brand">
          <img src="/favicon.svg" alt="" /> Agentrail
        </div>
        <label className="field">
          Admin token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
        </label>
        <span className="muted small">The value of AGENTRAIL_ADMIN_TOKEN on your server.</span>
        {error ? <span className="down small">{error}</span> : null}
        <button className="btn primary" type="submit">
          Open dashboard
        </button>
      </form>
    </div>
  )
}

export const App = () => {
  const location = useLocation()
  const [days, setDays] = useDays()
  const [range, setRange, custom] = useRange()
  const [picking, setPicking] = useState(false)
  const day = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const iso = (ts: number) => new Date(ts - new Date(ts).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
  const live = useLiveState()
  const [authed, setAuthed] = useState(0)
  const me = useApi<Me>('/api/me', [authed])
  useEffect(() => {
    if (me.data) connectLive()
  }, [me.data])
  if (me.error instanceof ApiError && me.error.status === 401) return <SignIn onDone={() => setAuthed((n) => n + 1)} />
  const { title, crumb, node } = route(location)
  const path = location.split('?')[0]!
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <img src="/favicon.svg" alt="" /> Agentrail
        </div>
        <nav className="nav stack" style={{ gap: 2 }}>
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={(n.to === '/' ? path === '/' : path.startsWith(n.to)) ? 'active' : ''}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="spacer" />
        {me.data && me.data.workspaces.length > 1 ? (
          <label className="field">
            Workspace
            <select
              value={me.data.workspaceId}
              onChange={(e) => {
                session.setWorkspace(e.target.value)
                location.includes('/sessions/') || location.includes('/fixes/') ? (window.location.href = '/') : window.location.reload()
              }}
            >
              {me.data.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <a className="faint small" href="https://github.com/ArneshBanerjee/agentrail" target="_blank" rel="noreferrer" style={{ padding: '8px' }}>
          Open source · MIT
        </a>
      </aside>
      <div className="main">
        <header className="top">
          <h1>
            {title}
            {crumb ? <span className="crumb"> / {crumb}</span> : null}
          </h1>
          <div className="grow" />
          <span className="live" title={live === 'on' ? 'Receiving arrivals live' : 'Live updates are not connected'}>
            <span className={`dot ${live === 'on' ? 'on' : ''}`} /> {live === 'on' ? 'Live' : 'Offline'}
          </span>
          <span className="muted small" title="The time window">
            {day(range.from)} – {day(range.to)}
          </span>
          {picking ? (
            <span className="row-flex">
              <input type="date" aria-label="From" defaultValue={iso(range.from)} max={iso(Date.now())} id="range-from" />
              <input type="date" aria-label="To" defaultValue={iso(range.to)} max={iso(Date.now())} id="range-to" />
              <button
                className="btn"
                onClick={() => {
                  // Dates are the person's own days, so read them in local time. The end date counts in full.
                  const local = (id: string) => new Date(`${(document.getElementById(id) as HTMLInputElement).value}T00:00`).getTime()
                  const from = local('range-from')
                  const to = local('range-to') + 86_399_999
                  if (from > 0 && to > from) setRange({ from, to: Math.min(to, Date.now()) })
                  setPicking(false)
                }}
              >
                Apply
              </button>
            </span>
          ) : null}
          <div className="seg" role="group" aria-label="Time window">
            {[1, 7, 30, 90].map((d) => (
              <button key={d} className={!custom && days === d ? 'on' : ''} onClick={() => setDays(d)}>
                {d === 1 ? '24h' : `${d}d`}
              </button>
            ))}
            <button className={custom ? 'on' : ''} onClick={() => setPicking((p) => !p)}>
              Custom
            </button>
          </div>
        </header>
        <Toasts />
        <main className="page">{me.error && !(me.error instanceof ApiError && me.error.status === 401) ? <div className="banner warn">Cannot reach the Agentrail server: {me.error.message}</div> : node}</main>
      </div>
    </div>
  )
}
