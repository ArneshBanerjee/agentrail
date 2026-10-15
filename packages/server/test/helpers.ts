import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type AppDeps } from '../src/app.ts'
import type { Config } from '../src/config.ts'
import { Store } from '../src/store.ts'

export const T0 = 1_760_000_000_000

export const setup = ({ config: configOverrides, ...overrides }: Partial<Omit<AppDeps, 'config'>> & { config?: Partial<Config> } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentrail-'))
  const store = new Store(join(dir, 'test.sqlite'))
  const { site, workspace } = store.ensureDefaults(T0)
  const config: Config = { port: 0, dataDir: dir, secret: 'test-secret', publicUrl: 'http://agentrail.test', ...configOverrides }
  const { app, ctx } = createApp({ store, config, now: overrides.now ?? (() => T0 + 120_000), ...overrides })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const send = (events: unknown[]) => post('/v1/events', { events }, { 'x-agentrail-key': site.ingestKey })
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { headers })
    return { status: res.status, body: (await res.json()) as any }
  }
  return { app, ctx, store, site, workspace, post, send, get }
}
