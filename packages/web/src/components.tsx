import { useEffect, useState, type ReactNode } from 'react'
import { AGENT_COLORS, fmt, navigate } from './lib.ts'
import type { Attribution, Blocker, FunnelRow } from './types.ts'

export const Link = ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
  <a
    href={to}
    className={className}
    onClick={(e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      navigate(to)
    }}
  >
    {children}
  </a>
)

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)
export const colorOf = (name: string) => AGENT_COLORS[Math.abs(hash(name)) % AGENT_COLORS.length]!

export const AgentName = ({ name, surface }: { name: string; surface?: string }) => (
  <span className="agent">
    <span className="avatar" style={{ background: name === 'Unnamed' ? 'var(--faint)' : colorOf(name) }}>
      {name === 'Unnamed' ? '?' : name.slice(0, 2)}
    </span>
    <span>
      {name}
      {surface && surface !== 'unknown' ? <span className="faint small"> · {surface}</span> : null}
    </span>
  </span>
)

export const LabelChip = ({ label }: { label: Attribution['label'] | string }) => <span className={`chip ${label}`}>{label}</span>

export const Stat = ({ label, value, sub, aside, text }: { label: string; value: ReactNode; sub?: ReactNode; aside?: ReactNode; text?: boolean }) => (
  <div className="card stat">
    <div className="label">
      <span>{label}</span>
      {aside}
    </div>
    <div className={`value${text ? ' text' : ''}`}>{value}</div>
    {sub ? <div className="sub">{sub}</div> : null}
  </div>
)

export const Change = ({ value, points }: { value?: number; points?: boolean }) =>
  value === undefined ? null : <span className={value >= 0 ? 'up' : 'down'}>{points ? fmt.pts(value) : fmt.change(value)}</span>

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="empty">
    <h3>{title}</h3>
    {children}
  </div>
)

export const Loading = () => <div className="empty">Loading…</div>

export const ErrorBox = ({ error }: { error: Error }) => (
  <div className="banner warn">
    <span>{error.message}</span>
  </div>
)

/** Bars sized against the first step, split by agent so a drop can be read per agent. */
export const Funnel = ({ rows, agents }: { rows: FunnelRow[]; agents: string[] }) => {
  const top = rows[0]?.sessions ?? 0
  if (top === 0) return <Empty title="No agent sessions in this window" />
  return (
    <>
      <div className="legend">
        {agents.map((a) => (
          <span key={a}>
            <i style={{ background: a === 'Unnamed' ? 'var(--faint)' : colorOf(a) }} />
            {a}
          </span>
        ))}
      </div>
      <div className="funnel">
        {rows.map((r, i) => (
          <div key={r.stepId} style={{ display: 'contents' }}>
            {i > 0 && r.dropFromPrevious > 0 ? (
              <div className="row">
                <span />
                <span className="drop">−{Math.round(r.dropFromPrevious * 100)}%</span>
                <span />
              </div>
            ) : null}
            <div className="row">
              <span className="name">{r.label}</span>
              <div className="track" title={agents.map((a) => `${a}: ${r.byAgent[a] ?? 0}`).join('\n')}>
                {agents.map((a) => (
                  <div key={a} className="seg-bar" style={{ width: `${((r.byAgent[a] ?? 0) / top) * 100}%`, background: a === 'Unnamed' ? 'var(--faint)' : colorOf(a) }} />
                ))}
              </div>
              <span className="figure">
                {fmt.n(r.sessions)}
                <small>{fmt.pct(r.ofTotal, 0)}</small>
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

export const BlockerLine = ({ blocker }: { blocker: Blocker }) => (
  <span className="row-flex">
    <span className="chip bad">{blocker.kind.replaceAll('_', ' ')}</span>
    <span className="mono small">{blocker.detail}</span>
  </span>
)

export const Diff = ({ before, after }: { before?: string; after: string }) => {
  const a = (before ?? '').split('\n')
  const b = after.split('\n')
  // A line diff by longest common subsequence. Docs pages are small, so the quadratic table is fine.
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out: { t: ' ' | '+' | '-'; s: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', s: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ t: '-', s: a[i++]! })
    else out.push({ t: '+', s: b[j++]! })
  }
  while (i < a.length) out.push({ t: '-', s: a[i++]! })
  while (j < b.length) out.push({ t: '+', s: b[j++]! })
  // Show changed lines with three lines of context, like a review would.
  const keep = out.map((_, k) => out.slice(Math.max(0, k - 3), k + 4).some((x) => x.t !== ' '))
  return (
    <div className="diff">
      {out.map((line, k) =>
        keep[k] ? (
          <div key={k} className={line.t === '+' ? 'add' : line.t === '-' ? 'del' : ''}>
            {line.t} {line.s}
          </div>
        ) : keep[k - 1] ? (
          <div key={k} className="hdr">
            ⋯
          </div>
        ) : null,
      )}
    </div>
  )
}

export const Bar = ({ value }: { value: number }) => (
  <div className="bar">
    <i style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
  </div>
)

/** One pip per funnel step: reached in green, the step it stopped before in red. */
export const Pips = ({ steps, reached, stoppedAt }: { steps: { id: string }[]; reached: string[]; stoppedAt?: string | undefined }) => (
  <span className="pips">
    {steps.map((s) => (
      <i key={s.id} className={reached.includes(s.id) ? 'on' : s.id === stoppedAt ? 'stop' : ''} />
    ))}
  </span>
)

/** A clock that keeps running while the session is live. */
export const Clock = ({ ms, live }: { ms: number; live: boolean }) => {
  const [start] = useState(() => Date.now())
  const [, tick] = useState(0)
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [live])
  return <>{fmt.clock(ms + (live ? Date.now() - start : 0))}</>
}

/** The funnel as stacked columns, one colour per agent, with the share lost above each column. */
export const ColumnFunnel = ({ rows, agents }: { rows: FunnelRow[]; agents: { label: string; sessions: number }[] }) => {
  const top = rows[0]?.sessions ?? 0
  if (top === 0) return <Empty title="No agent sessions in this window" />
  const colour = (a: string) => (a === 'Unnamed' ? 'var(--faint)' : colorOf(a))
  return (
    <div className="cols">
      <div className="legend2">
        {[...agents].reverse().map((a) => (
          <div key={a.label} style={{ flex: Math.max(a.sessions, top * 0.08) }}>
            <i style={{ width: 10, height: 10, borderRadius: 3, background: colour(a.label), display: 'inline-block' }} />
            <span>
              {a.label}
              <small>{fmt.n(a.sessions)}</small>
            </span>
          </div>
        ))}
      </div>
      <div className="area">
        {rows.map((r, i) => {
          const lostShare = i === 0 ? 0 : (rows[i - 1]!.sessions - r.sessions) / top
          return (
            <div key={r.stepId} className="col">
              <div className="stack" title={agents.map((a) => `${a.label}: ${r.byAgent[a.label] ?? 0}`).join('\n')}>
                {lostShare > 0 ? (
                  <div className="lost" style={{ height: `${Math.max(lostShare * 100, 9)}%` }}>
                    −{Math.round(r.dropFromPrevious * 100)}%
                  </div>
                ) : null}
                {[...agents].reverse().map((a) => (
                  <div key={a.label} className="part" style={{ height: `${((r.byAgent[a.label] ?? 0) / top) * 100}%`, background: colour(a.label), opacity: 0.75 }} />
                ))}
              </div>
              <div className="num">
                {fmt.n(r.sessions)}
                <small>{i === 0 ? '' : fmt.pct(r.ofTotal, 0)}</small>
              </div>
              <div className="lbl">{r.label}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const toastListeners = new Set<(t: string | undefined) => void>()
export const toast = (text: string) => {
  toastListeners.forEach((l) => l(text))
  setTimeout(() => toastListeners.forEach((l) => l(undefined)), 6000)
}
export const Toasts = () => {
  const [text, setText] = useState<string>()
  useEffect(() => {
    toastListeners.add(setText)
    return () => {
      toastListeners.delete(setText)
    }
  }, [])
  return text ? (
    <div className="toast" role="status">
      <span className="ok">✓</span>
      <span>{text}</span>
    </div>
  ) : null
}
