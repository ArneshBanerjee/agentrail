import { useEffect, useState } from 'react'
import { Diff, Link, toast } from './components.tsx'
import { api, fmt, lowerFirst, useApi } from './lib.ts'
import type { FixDetail, Providers, Summary } from './types.ts'

/**
 * A fix, ready to ship: what to do, the evidence for it, the change itself, and one button. The
 * change is drafted before anyone opens this, so most of the time Confirm is the only thing left.
 */
export const FixDialog = ({ fixKey, onClose, onPublished }: { fixKey: string; onClose: () => void; onPublished?: () => void }) => {
  const path = `/api/fixes/${encodeURIComponent(fixKey)}`
  const fix = useApi<FixDetail>(`${path}?days=30`)
  const summary = useApi<Summary>('/api/summary?days=30&fixes=0&intents=0')
  const providers = useApi<Providers>('/api/providers')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const record = fix.data?.record

  useEffect(() => {
    if (!record?.drafting) return
    const t = setInterval(fix.reload, 2500)
    return () => clearInterval(t)
  }, [record?.drafting, fix.reload])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const f = fix.data
  const steps = summary.data?.funnelSteps ?? []
  const label = (id?: string) => lowerFirst(steps.find((s) => s.id === id)?.label ?? id ?? '')
  const change = record?.draft ?? (f?.proposal.patch ? { file: f.proposal.patch.file, after: f.proposal.patch.content, summary: f.proposal.summary, provider: 'rule' } : undefined)
  const published = record?.status === 'published'
  const servePath = record?.draft?.servePath ?? f?.path
  const provider = providers.data?.available.find((p) => p.id === providers.data?.selected)
  // The page the fix changes: the page agents read before failing, or the missing page itself.
  const where = f ? (f.kind === 'failed_call' ? f.sourcePage : f.kind === 'not_found' || f.kind === 'markdown_served_html' ? f.path : undefined) : undefined
  const cause = record?.draft?.cause ?? f?.cause ?? ''

  const confirm = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api(`${path}/publish`, { method: 'POST', json: {} })
      toast(`${record?.draft?.title ?? f?.action} · live in production`)
      onPublished?.()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h2>{record?.draft?.title ?? f?.action ?? 'Loading…'}</h2>
            <div className="muted small">{record?.draft?.problem ?? f?.problem}</div>
          </div>
          <button className="x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="body">
          {f ? (
            <p style={{ marginTop: 6 }}>
              {f.sessionsLost > 0 ? (
                <>
                  <b>{fmt.n(f.sessionsLost)} agents</b> {f.failedAt}.{' '}
                  {f.dropShare > 0 && f.beforeStep ? (
                    <>
                      <b>{fmt.pct(f.dropShare, 0)}</b> of the drop before the {label(f.beforeStep)} comes from{' '}
                      {where ? (
                        <>
                          one page, <span className="mono">{where}</span>: {cause}.
                        </>
                      ) : (
                        <>this problem: {cause}.</>
                      )}
                    </>
                  ) : (
                    <>{where ? <>The cause is <span className="mono">{where}</span>: {cause}.</> : <>The cause: {cause}.</>}</>
                  )}
                </>
              ) : (
                <>
                  <b>{fmt.n(f.sessionsAffected)} {f.sessionsAffected === 1 ? 'agent' : 'agents'}</b> {f.failedAt} and got past it with extra calls.{' '}
                  {where ? <>It comes from <span className="mono">{where}</span>: {cause}.</> : <>The cause: {cause}.</>}
                </>
              )}
            </p>
          ) : null}
          {record?.drafting ? (
            <div className="banner">
              <span>
                <span className="spin" /> Preparing the fix with {provider?.label ?? 'your model'}…
              </span>
            </div>
          ) : null}
          {record?.draftError ? <div className="banner warn">The draft failed: {record.draftError}</div> : null}
          {change ? (
            <>
              <div className="patchhead">
                <span>
                  {change.provider === 'rule' ? 'Redirect' : 'Docs patch'} · <span className="mono">{servePath ?? change.file}</span>
                </span>
                <span className={published ? 'islive' : 'inpreview'}>{published ? 'Live' : 'In preview'}</span>
              </div>
              <Diff {...(change.before !== undefined ? { before: change.before } : {})} after={change.after} />
            </>
          ) : !record?.drafting && f ? (
            <p className="muted small">
              {f.proposal.summary}{' '}
              {providers.data && !providers.data.available.some((p) => p.ready) ? (
                <>
                  Sign in to Claude Code on the server, or add an API key in <Link to="/settings">Settings</Link>, and the change is drafted for you.
                </>
              ) : null}
            </p>
          ) : null}
          {error ? <p className="down small">{error}</p> : null}
        </div>
        <footer>
          <Link to={`/fixes/${encodeURIComponent(fixKey)}`} className="btn">
            Details
          </Link>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !change || published} onClick={confirm}>
            {published ? 'Live' : 'Confirm'}
          </button>
        </footer>
      </div>
    </div>
  )
}
