import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { extend } from './features.ts'
import { Store } from './store.ts'
import { verifier } from './webbotauth.ts'

const config = loadConfig()
const store = new Store(join(config.dataDir, 'openscope.sqlite'))
const { site, created } = store.ensureDefaults(Date.now())
const { app } = createApp({ store, config, verify: verifier(), extend })

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`\nOpenScope is running. Open ${config.publicUrl}\n`)
  if (created) {
    console.log(`First run: created the workspace "My product". Its ingest key is ${site.ingestKey}`)
    console.log('To look around with sample data, turn on "Demo" at the bottom of the sidebar.\n')
  }
  if (!config.adminToken) console.log('Note: OPENSCOPE_ADMIN_TOKEN is not set, so anyone who can reach this port can open the dashboard.\n')
})
