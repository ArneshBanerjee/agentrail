import { useState } from 'react'
import { Loading } from '../components.tsx'
import { useApi } from '../lib.ts'
import type { Me } from '../types.ts'

const snippets = (key: string, endpoint: string, origin: string) => ({
  'Express or Node': `import express from 'express'
import { OpenScope } from '@openscope/sdk'

const openscope = new OpenScope({ key: '${key}', endpoint: '${endpoint}' })
const app = express()
app.use(openscope.node())`,
  Hono: `import { Hono } from 'hono'
import { OpenScope } from '@openscope/sdk'

const openscope = new OpenScope({ key: '${key}', endpoint: '${endpoint}' })
const app = new Hono()
app.use(openscope.hono())`,
  'Next.js': `// middleware.ts
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'
import { OpenScope } from '@openscope/sdk'

const openscope = new OpenScope({ key: '${key}', endpoint: '${endpoint}', trustProxy: true, flushIntervalMs: 0 })

export default openscope.handler(
  (_request: NextRequest, _event: NextFetchEvent) => NextResponse.next(),
  { waitUntil: (event) => (p) => event.waitUntil(p) },
)`,
  'Cloudflare Workers': `import { OpenScope } from '@openscope/sdk'

const openscope = new OpenScope({ key: '${key}', endpoint: '${endpoint}', flushIntervalMs: 0 })

export default {
  fetch: openscope.worker(async (request, env, ctx) => fetch(request)),
}`,
  'MCP server': `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { OpenScope } from '@openscope/sdk'
import { instrument } from '@openscope/sdk/mcp'

const openscope = new OpenScope({ key: '${key}', endpoint: '${endpoint}' })
const server = instrument(new McpServer({ name: 'my-product', version: '1.0.0' }), openscope)
// Register tools as usual. Connects, tool calls, errors and the client name are recorded.`,
  'Product steps': `// In your CLI, API or sign-in flow. The session hint joins these to the agent's docs visits.
openscope.track('installed', { sessionHint: cliSessionId, text: 'npm install @acme/cli' })
openscope.track('signin_started', { sessionHint: cliSessionId })
openscope.identify(account.id, { sessionHint: cliSessionId })
openscope.track('signed_in', { sessionHint: cliSessionId, accountId: account.id })
openscope.track('first_api_call', { accountId: account.id })
openscope.search(query, { ip: request.ip, userAgent: request.headers['user-agent'] })`,
  'llms.txt': `// Add the docs finder to ${origin}/llms.txt. Agents send their task to it to find the right
// page, which is how the Intents page learns what they want. The SDK middleware answers it.
import { llmsTxtAgentNote, llmsTxtLine } from '@openscope/sdk'

const llmsTxt = \`# Your product

\${llmsTxtAgentNote('${origin}')}

\${llmsTxtLine('${origin}')}

- [Quickstart](/docs/quickstart): ...
\``,
  'Log drains': `# Vercel: Project settings > Log drains > add an NDJSON drain to
${endpoint.replace('/v1/events', '')}/v1/drains/vercel/${key}

# Cloudflare Logpush: an HTTP destination of
${endpoint.replace('/v1/events', '')}/v1/drains/cloudflare/${key}

# nginx or Apache combined logs, from any machine:
npx -p @openscope/sdk openscope import-log access.log --key ${key} --endpoint ${endpoint.replace('/v1/events', '')} --host docs.example.com`,
})

export const Setup = () => {
  const me = useApi<Me>('/api/me')
  const [site, setSite] = useState(0)
  const [tab, setTab] = useState('Express or Node')
  if (!me.data) return <Loading />
  const chosen = me.data.sites[site] ?? me.data.sites[0]
  if (!chosen) return <div className="empty">Add a site in Settings first.</div>
  const all = snippets(chosen.ingestKey, me.data.ingestUrl.replace(/\/v1\/events$/, ''), chosen.host.includes('localhost') ? 'https://docs.example.com' : `https://${chosen.host}`)
  return (
    <div style={{ maxWidth: 900 }}>
      <div className="card">
        <h2>Collect agent traffic</h2>
        <p style={{ marginTop: 0 }}>
          Agents do not run page scripts, so OpenScope collects on your server. Add one collector where agents arrive: your docs, your API, your MCP server. Requests from people are dropped inside the SDK and never leave your server.
        </p>
        {me.data.sites.length > 1 ? (
          <label className="field" style={{ maxWidth: 300 }}>
            Site
            <select value={site} onChange={(e) => setSite(Number(e.target.value))}>
              {me.data.sites.map((s, i) => (
                <option key={s.id} value={i}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p className="small muted" style={{ marginBottom: 0 }}>
          1. In your OpenScope folder, build the SDK. 2. Install it in your product.
        </p>
        {chosen.host === 'localhost' ? (
          <p className="small muted">The examples use docs.example.com until this site has real traffic, or until you set its host in Settings.</p>
        ) : null}
        <pre className="code">{`npm run pack
cd /path/to/your-product
npm install /path/to/openscope/packages-dist/openscope-core-0.1.0.tgz /path/to/openscope/packages-dist/openscope-sdk-0.1.0.tgz`}</pre>
      </div>
      <div className="card section">
        <div className="tabs" style={{ flexWrap: 'wrap' }}>
          {Object.keys(all).map((k) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {k}
            </button>
          ))}
        </div>
        <pre className="code">{all[tab as keyof typeof all]}</pre>
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(all[tab as keyof typeof all])}>
          Copy
        </button>
      </div>
      <div className="card section">
        <h2>Check that it works</h2>
        <pre className="code">{`curl -s ${me.data.ingestUrl} \\
  -H 'x-openscope-key: ${chosen.ingestKey}' -H 'content-type: application/json' \\
  -d '{"events":[{"id":"hello-1","ts":'$(date +%s000)',"source":"http","kind":"request","path":"/llms.txt","status":200,"userAgent":"Claude-User"}]}'`}</pre>
        <p className="muted small">The request shows up in Arrivals within a second.</p>
      </div>
    </div>
  )
}
