import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { extend } from './features.ts'
import { Store } from './store.ts'
import { verifier } from './webbotauth.ts'

const config = loadConfig()
const store = new Store(join(config.dataDir, 'agentrail.sqlite'))
const { site, created } = store.ensureDefaults(Date.now())
const { app } = createApp({ store, config, verify: verifier(), extend })

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Agentrail is running on ${config.publicUrl}`)
  if (created) console.log(`Created a workspace. Ingest key for "${site.name}": ${site.ingestKey}`)
  if (!config.adminToken) console.log('AGENTRAIL_ADMIN_TOKEN is not set, so the dashboard is open to anyone who can reach this port.')
})
