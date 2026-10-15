import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { serve } from '@hono/node-server'
import { expect, test } from 'vitest'
import { extend } from '../src/features.ts'
import { verifyStripe } from '../src/drains.ts'
import { setup, T0 } from './helpers.ts'

const withDrains = () => setup({ extend: (app, ctx) => extend(app, ctx) })
const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

test('Vercel drain: NDJSON in, agents kept, people dropped', async () => {
  const { app, site, store } = withDrains()
  const body = [
    { requestId: 'a', proxy: { timestamp: T0, method: 'GET', host: 'docs.x.test', path: '/llms.txt', userAgent: ['Claude-User'], statusCode: 200, clientIp: '1.2.3.4' } },
    { requestId: 'b', proxy: { timestamp: T0, method: 'GET', host: 'docs.x.test', path: '/', userAgent: [CHROME], statusCode: 200, clientIp: '5.6.7.8' } },
    { id: 'build', message: 'Build completed' },
  ]
    .map((x) => JSON.stringify(x))
    .join('\n')
  const res = await app.request(`/v1/drains/vercel/${site.ingestKey}`, { method: 'POST', body })
  expect(await res.json()).toEqual({ received: 3, agents: 1, stored: 1 })
  expect(store.events([site.id], 0, Infinity).map((e) => e.path)).toEqual(['/llms.txt'])
  expect((await app.request('/v1/drains/vercel/wrong', { method: 'POST', body })).status).toBe(401)
})

test('Cloudflare drain: gzipped NDJSON, and the Logpush test object is ignored', async () => {
  const { app, site } = withDrains()
  const lines = [{ content: 'test' }, { RayID: 'r1', ClientRequestURI: '/docs', ClientRequestHost: 'docs.x.test', EdgeResponseStatus: 200, EdgeStartTimestamp: T0 / 1000, ClientRequestUserAgent: 'python-requests/2.32', ClientIP: '9.9.9.9' }]
  const res = await app.request(`/v1/drains/cloudflare/${site.ingestKey}`, {
    method: 'POST',
    headers: { 'content-encoding': 'gzip' },
    body: gzipSync(lines.map((l) => JSON.stringify(l)).join('\n')),
  })
  expect(await res.json()).toEqual({ received: 1, agents: 1, stored: 1 })
})

const stripeEvent = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: `evt_${type}`, type, created: Math.floor(T0 / 1000), data: { object } })
const sign = (body: string, secret: string, t = Math.floor((T0 + 120_000) / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`

test('Stripe: signed charges become payments for the account, everything else is refused or ignored', async () => {
  const { app, site, store, workspace } = withDrains()
  const url = `/v1/stripe/${site.ingestKey}`
  const ok = stripeEvent('charge.succeeded', { amount: 4900, currency: 'usd', customer: 'cus_1', metadata: { agentrail_account: 'acct_7' } })
  expect((await app.request(url, { method: 'POST', body: ok, headers: { 'stripe-signature': sign(ok, 'whsec_x') } })).status).toBe(400)
  store.saveSettings(workspace.id, { ...store.settings(workspace.id), stripe: { webhookSecret: 'whsec_x' } })
  expect((await app.request(url, { method: 'POST', body: ok, headers: { 'stripe-signature': sign(ok, 'wrong') } })).status).toBe(400)
  expect(await (await app.request(url, { method: 'POST', body: ok, headers: { 'stripe-signature': sign(ok, 'whsec_x') } })).json()).toEqual({ stored: 1 })
  const failed = stripeEvent('charge.failed', { amount: 4900, currency: 'usd', customer: 'cus_2', failure_code: 'card_declined', failure_message: 'Your card was declined.' })
  await app.request(url, { method: 'POST', body: failed, headers: { 'stripe-signature': sign(failed, 'whsec_x') } })
  const invoice = stripeEvent('invoice.paid', { amount_paid: 4900 })
  expect(await (await app.request(url, { method: 'POST', body: invoice, headers: { 'stripe-signature': sign(invoice, 'whsec_x') } })).json()).toEqual({ ignored: 'invoice.paid' })
  const payments = store.events([site.id], 0, Infinity)
  expect(payments.map((p) => [p.kind, p.ok, p.amount ?? null, p.error ?? null])).toEqual([
    ['payment', true, 4900, null],
    ['payment', false, null, 'card_declined: Your card was declined.'],
  ])
  expect(payments[0]!.accountId).not.toBe('acct_7')
})

test('Stripe signatures expire', () => {
  const body = '{}'
  expect(verifyStripe(body, sign(body, 's', 1000), 's', 1000 * 1000)).toBe(true)
  expect(verifyStripe(body, sign(body, 's', 1000), 's', 2000 * 1000)).toBe(false)
  expect(verifyStripe(body, undefined, 's', 0)).toBe(false)
})

test('the import-log CLI sends only agent lines to a running server', async () => {
  const { app, site, store } = withDrains()
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'agentrail-log-'))
  const file = join(dir, 'access.log')
  writeFileSync(
    file,
    [
      '203.0.113.9 - - [10/Oct/2026:13:55:36 +0000] "GET /llms.txt HTTP/1.1" 200 51 "-" "codex_cli_rs/0.46.0"',
      `198.51.100.1 - - [10/Oct/2026:13:55:37 +0000] "GET / HTTP/1.1" 200 900 "-" "${CHROME}"`,
      'not a log line',
    ].join('\n'),
  )
  const { stdout: out } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../../sdk/src/cli.ts'), 'import-log', file, '--key', site.ingestKey, '--endpoint', `http://127.0.0.1:${port}`, '--host', 'docs.x.test'])
  server.close()
  expect(out.trim()).toBe('3 lines read, 1 from agents, 1 new events stored.')
  expect(store.events([site.id], 0, Infinity)[0]).toMatchObject({ path: '/llms.txt', host: 'docs.x.test', source: 'drain' })
})
