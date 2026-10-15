import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { demoEvents } from './demo.ts'
import { ingestEvents } from './ingest.ts'
import { Store } from './store.ts'

/**
 * `npm run seed`: a demo workspace beside your own, so the dashboard can be seen before any agent
 * has visited. It goes through the same ingest path as real traffic, redaction included.
 */
export const seedDemo = async (store: Store, secret: string, now: number) => {
  const existing = store.workspaces().find((w) => w.name === 'Ledgerly (demo)')
  const workspace = existing ?? store.createWorkspace('Ledgerly (demo)', now)
  const site = store.sites(workspace.id)[0] ?? store.createSite(workspace.id, 'docs.ledgerly.dev', 'docs.ledgerly.dev')
  store.saveSettings(workspace.id, {
    ...store.settings(workspace.id),
    intents: [
      { id: 'subscriptions', label: 'Subscriptions', keywords: ['subscription', 'usage', 'meter', 'seat', 'trial', 'plan', 'bill'] },
      { id: 'checkout', label: 'Checkout', keywords: ['checkout', 'pay', 'link', 'store'] },
      { id: 'refunds', label: 'Refunds', keywords: ['refund'] },
      { id: 'webhooks', label: 'Webhooks', keywords: ['webhook', 'signature'] },
      { id: 'payouts', label: 'Payouts', keywords: ['payout', 'seller', 'split', 'marketplace'] },
    ],
  })
  const events = demoEvents({ now })
  let stored = 0
  for (let i = 0; i < events.length; i += 500) {
    const result = await ingestEvents({ store, secret }, site, events.slice(i, i + 500))
    if (result.ok) stored += result.stored
  }
  return { workspace, site, events: events.length, stored }
}

if (import.meta.main) {
  const config = loadConfig()
  const store = new Store(join(config.dataDir, 'agentrail.sqlite'))
  store.ensureDefaults(Date.now())
  const result = await seedDemo(store, config.secret, Date.now())
  console.log(`Demo workspace "${result.workspace.name}": ${result.stored} of ${result.events} events stored.`)
}
