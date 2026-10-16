import { useEffect, useState } from 'react'
import { ErrorBox, Loading } from '../components.tsx'
import { api, session, useApi } from '../lib.ts'
import type { Me, Providers } from '../types.ts'

type Settings = {
  funnel: unknown[]
  conversionStep: string
  intents: unknown[]
  currency: string
  llm: { provider?: string; model?: string; apiKey?: string; baseUrl?: string }
  github: { repo?: string; token?: string; branch?: string; docsRoot?: string }
  stripe: { webhookSecret?: string }
  runner?: { targetUrl?: string; timeoutSec?: number }
  autoDraft?: boolean
  sessionGapMinutes?: number
}

const Saved = ({ at }: { at?: number }) => (at ? <span className="up small">Saved</span> : null)

export const Settings = () => {
  const settings = useApi<Settings>('/api/settings')
  const me = useApi<Me>('/api/me')
  const providers = useApi<Providers>('/api/providers')
  const [draft, setDraft] = useState<Settings>()
  const [saved, setSaved] = useState<Record<string, number>>({})
  const [error, setError] = useState<string>()
  const [funnelText, setFunnelText] = useState('')
  const [intentsText, setIntentsText] = useState('')
  const [site, setSite] = useState({ name: '', host: '' })
  useEffect(() => {
    if (!settings.data) return
    setDraft(settings.data)
    setFunnelText(JSON.stringify(settings.data.funnel, null, 2))
    setIntentsText(JSON.stringify(settings.data.intents, null, 2))
  }, [settings.data])
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }, [draft])

  if (settings.error) return <ErrorBox error={settings.error} />
  if (!draft || !me.data) return <Loading />

  const save = async (section: string, patch: Partial<Settings>) => {
    setError(undefined)
    try {
      const next = await api<Settings>('/api/settings', { method: 'PUT', json: patch })
      setDraft(next)
      setSaved((s) => ({ ...s, [section]: Date.now() }))
      providers.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const field = <K extends 'llm' | 'github' | 'stripe' | 'runner'>(section: K, key: string, value: string) =>
    setDraft((d) => (d ? { ...d, [section]: { ...(d[section] ?? {}), [key]: value } } : d))

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 860 }}>
      {error ? <div className="banner warn">{error}</div> : null}

      <div className="card" id="workspace">
        <h2>
          Workspace <Saved at={saved.workspace} />
        </h2>
        <div className="row-flex">
          <input type="text" aria-label="Workspace name" defaultValue={me.data.workspaces.find((w) => w.id === me.data!.workspaceId)?.name} id="workspace-name" style={{ minWidth: 240 }} />
          <button
            className="btn"
            onClick={async () => {
              await api(`/api/workspaces/${me.data!.workspaceId}`, { method: 'PUT', json: { name: (document.getElementById('workspace-name') as HTMLInputElement).value } })
              setSaved((v) => ({ ...v, workspace: Date.now() }))
              me.reload()
            }}
          >
            Rename
          </button>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          A new site's host is filled in from its first real traffic. You can also set it here, so the Setup page shows your own address.
        </p>
      </div>

      <div className="card" id="sites">
        <h2>
          Sites and ingest keys <Saved at={saved.sites} />
        </h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Each site sends events with its own key to <span className="mono">{me.data.ingestUrl}</span>.
        </p>
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>Host</th>
              <th>Ingest key</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {me.data.sites.map((s) => (
              <tr key={s.id}>
                <td>
                  <input type="text" defaultValue={s.name} aria-label="Site name" id={`site-name-${s.id}`} style={{ width: 140 }} />
                </td>
                <td>
                  <input type="text" defaultValue={s.host} aria-label="Host" id={`site-host-${s.id}`} className="mono" style={{ width: 200 }} />
                </td>
                <td className="mono small">{s.ingestKey}</td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  <button
                    className="btn"
                    onClick={async () => {
                      const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value
                      await api(`/api/sites/${s.id}`, { method: 'PUT', json: { name: value(`site-name-${s.id}`), host: value(`site-host-${s.id}`) } })
                      setSaved((v) => ({ ...v, sites: Date.now() }))
                      me.reload()
                    }}
                  >
                    Save
                  </button>{' '}
                  <button
                    className="btn danger"
                    onClick={async () => {
                      if (!confirm(`Delete ${s.name}? Its events stay, but its key stops working.`)) return
                      await api(`/api/sites/${s.id}`, { method: 'DELETE' })
                      me.reload()
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="row-flex"
          style={{ marginTop: 12 }}
          onSubmit={async (e) => {
            e.preventDefault()
            await api('/api/sites', { method: 'POST', json: site })
            setSite({ name: '', host: '' })
            me.reload()
          }}
        >
          <input type="text" placeholder="Name, e.g. Docs" value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} />
          <input type="text" placeholder="Host, e.g. docs.example.com" value={site.host} onChange={(e) => setSite({ ...site, host: e.target.value })} />
          <button className="btn" type="submit" disabled={!site.name || !site.host}>
            Add site
          </button>
        </form>
      </div>

      <div className="card" id="model">
        <h2>
          Model for drafting fixes and naming intents <Saved at={saved.llm} />
        </h2>
        <div className="stack">
          {providers.data?.available.map((p) => (
            <label key={p.id} className="row-flex" style={{ cursor: 'pointer' }}>
              <input type="radio" name="provider" checked={(draft.llm.provider ?? providers.data?.selected) === p.id} onChange={() => field('llm', 'provider', p.id)} />
              <span className="bold">{p.label}</span>
              <span className={`chip ${p.ready ? 'good' : 'neutral'}`}>{p.ready ? 'ready' : 'not set up'}</span>
              <span className="muted small">{p.detail}</span>
            </label>
          ))}
        </div>
        <div className="grid g2" style={{ marginTop: 12 }}>
          <label className="field">
            API key (Anthropic, OpenAI or Gemini)
            <input type="password" placeholder={draft.llm.apiKey === 'set' ? 'Saved. Type to replace.' : 'Leave empty to use the environment variable'} onChange={(e) => field('llm', 'apiKey', e.target.value)} />
          </label>
          <label className="field">
            Model (optional)
            <input type="text" value={draft.llm.model ?? ''} placeholder="Provider default" onChange={(e) => field('llm', 'model', e.target.value)} />
          </label>
          <label className="field">
            Base URL (optional, for OpenAI-compatible servers such as Ollama)
            <input type="text" value={draft.llm.baseUrl ?? ''} placeholder="https://api.openai.com/v1" onChange={(e) => field('llm', 'baseUrl', e.target.value)} />
          </label>
        </div>
        <p className="muted small">Claude Code needs no key. It runs headless on this server with the plan you are signed in with.</p>
        <button className="btn primary" onClick={() => save('llm', { llm: draft.llm })}>
          Save model settings
        </button>
      </div>

      <div className="card" id="github">
        <h2>
          Publishing fixes to GitHub <Saved at={saved.github} />
        </h2>
        <div className="grid g2">
          <label className="field">
            Repository (owner/name)
            <input type="text" value={draft.github.repo ?? ''} placeholder="acme/docs" onChange={(e) => field('github', 'repo', e.target.value)} />
          </label>
          <label className="field">
            Token with contents and pull request write access
            <input type="password" placeholder={draft.github.token === 'set' ? 'Saved. Type to replace.' : 'github_pat_…'} onChange={(e) => field('github', 'token', e.target.value)} />
          </label>
          <label className="field">
            Base branch
            <input type="text" value={draft.github.branch ?? ''} placeholder="main" onChange={(e) => field('github', 'branch', e.target.value)} />
          </label>
          <label className="field">
            Docs folder in the repository
            <input type="text" value={draft.github.docsRoot ?? ''} placeholder="docs" onChange={(e) => field('github', 'docsRoot', e.target.value)} />
          </label>
        </div>
        <p className="muted small">Without GitHub, publishing marks the fix as shipped, so the before and after comparison starts.</p>
        <button className="btn primary" onClick={() => save('github', { github: draft.github })}>
          Save GitHub settings
        </button>
      </div>

      <div className="card" id="behaviour">
        <h2>
          Fixes and sessions <Saved at={saved.behaviour} />
        </h2>
        <label className="row-flex" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={draft.autoDraft !== false} onChange={(e) => setDraft({ ...draft, autoDraft: e.target.checked })} />
          <span>Prepare the top fixes in the background with the selected model</span>
        </label>
        <p className="muted small">On, a fix is already drafted when you open it. With Claude Code this uses your Claude plan, one draft at a time.</p>
        <label className="field" style={{ maxWidth: 260 }}>
          Minutes of quiet that end a session
          <input type="number" min={1} max={240} value={draft.sessionGapMinutes ?? 30} onChange={(e) => setDraft({ ...draft, sessionGapMinutes: Number(e.target.value) })} />
        </label>
        <p />
        <button className="btn primary" onClick={() => save('behaviour', { autoDraft: draft.autoDraft !== false, sessionGapMinutes: draft.sessionGapMinutes ?? 30 })}>
          Save
        </button>
      </div>

      <div className="card" id="runner">
        <h2>
          Agent test runs <Saved at={saved.runner} />
        </h2>
        <div className="grid g2">
          <label className="field">
            Preview URL agents test against
            <input type="text" value={draft.runner?.targetUrl ?? ''} placeholder="https://preview.docs.example.com" onChange={(e) => field('runner', 'targetUrl', e.target.value)} />
          </label>
          <label className="field">
            Timeout per run, in seconds
            <input type="text" value={String(draft.runner?.timeoutSec ?? '')} placeholder="300" onChange={(e) => field('runner', 'timeoutSec', e.target.value)} />
          </label>
        </div>
        <p className="muted small">
          Available agents:{' '}
          {providers.data?.agents.map((a) => (
            <span key={a.id} className={`chip ${a.ready ? 'good' : 'neutral'}`} style={{ marginRight: 6 }}>
              {a.label}
            </span>
          ))}
        </p>
        <button className="btn primary" onClick={() => save('runner', { runner: { ...draft.runner, ...(draft.runner?.timeoutSec ? { timeoutSec: Number(draft.runner.timeoutSec) } : {}) } })}>
          Save runner settings
        </button>
      </div>

      <div className="card" id="stripe">
        <h2>
          Revenue from Stripe <Saved at={saved.stripe} />
        </h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Point a Stripe webhook at <span className="mono">{me.data.ingestUrl.replace('/v1/events', '/v1/stripe/')}{me.data.sites[0]?.ingestKey}</span> for <span className="mono">charge.succeeded</span> and <span className="mono">charge.failed</span>. Set <span className="mono">metadata.agentrail_account</span> on customers to the id you pass to <span className="mono">identify()</span>, or the Stripe customer id is used.
        </p>
        <label className="field">
          Webhook signing secret
          <input type="password" placeholder={draft.stripe.webhookSecret === 'set' ? 'Saved. Type to replace.' : 'whsec_…'} onChange={(e) => field('stripe', 'webhookSecret', e.target.value)} />
        </label>
        <p />
        <button className="btn primary" onClick={() => save('stripe', { stripe: draft.stripe })}>
          Save Stripe settings
        </button>
      </div>

      <div className="card" id="funnel">
        <h2>
          Funnel steps <Saved at={saved.funnel} />
        </h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Each step matches an event by kind, step name, path prefix, host or payment number. Steps must be in order.
        </p>
        <textarea rows={14} value={funnelText} onChange={(e) => setFunnelText(e.target.value)} />
        <div className="row-flex" style={{ marginTop: 8 }}>
          <label className="field">
            Conversion step
            <input type="text" value={draft.conversionStep} onChange={(e) => setDraft({ ...draft, conversionStep: e.target.value })} />
          </label>
          <label className="field">
            Currency
            <input type="text" value={draft.currency} placeholder="From payments" onChange={(e) => setDraft({ ...draft, currency: e.target.value })} style={{ width: 120 }} />
          </label>
        </div>
        <p />
        <button
          className="btn primary"
          onClick={() => {
            try {
              void save('funnel', { funnel: JSON.parse(funnelText) as unknown[], conversionStep: draft.conversionStep, currency: draft.currency })
            } catch {
              setError('The funnel is not valid JSON.')
            }
          }}
        >
          Save funnel
        </button>
      </div>

      <div className="card" id="intents">
        <h2>
          Named intents <Saved at={saved.intents} />
        </h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          A task goes to the intent whose keywords it shares most. Tasks that match none are grouped by their most shared word.
        </p>
        <textarea rows={10} value={intentsText} placeholder='[{"id": "refunds", "label": "Refunds", "keywords": ["refund"]}]' onChange={(e) => setIntentsText(e.target.value)} />
        <p />
        <button
          className="btn primary"
          onClick={() => {
            try {
              void save('intents', { intents: JSON.parse(intentsText || '[]') as unknown[] })
            } catch {
              setError('The intents are not valid JSON.')
            }
          }}
        >
          Save intents
        </button>
      </div>

      <div className="card">
        <h2>This browser</h2>
        <button
          className="btn"
          onClick={() => {
            session.setToken(undefined)
            location.reload()
          }}
        >
          Forget the admin token
        </button>
      </div>
    </div>
  )
}
