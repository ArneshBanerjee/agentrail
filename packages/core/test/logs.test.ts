import { expect, test } from 'vitest'
import { isAgentTraffic, parseClfTime, parseCloudflareLog, parseCombinedLine, parseVercelLog } from '../src/logs.ts'

test('combined log lines become request events, with a stable id', () => {
  const line = '203.0.113.9 - - [10/Oct/2026:13:55:36 +0530] "GET /docs/api-keys?lang=en HTTP/1.1" 200 5120 "https://www.google.com/" "Claude-User (claude-code/2.1.90)"'
  const e = parseCombinedLine(line, 'docs.x.test')
  expect(e).toMatchObject({ kind: 'request', source: 'drain', method: 'GET', path: '/docs/api-keys', query: 'lang=en', status: 200, host: 'docs.x.test', ip: '203.0.113.9', referrer: 'https://www.google.com/', userAgent: 'Claude-User (claude-code/2.1.90)' })
  expect(e!.ts).toBe(Date.UTC(2026, 9, 10, 8, 25, 36))
  expect(parseCombinedLine(line)!.id).toBe(e!.id)
  expect(parseCombinedLine('garbage')).toBeUndefined()
  expect(parseClfTime('99/Foo/2026:00:00:00 +0000')).toBeUndefined()
})

test('a combined line with no referrer or user agent', () => {
  expect(parseCombinedLine('10.0.0.1 - - [10/Oct/2026:13:55:36 +0000] "POST /v1/meters HTTP/2.0" 401 12 "-" "-"')).toMatchObject({ method: 'POST', status: 401 })
})

test('Vercel drain records use the proxy fields', () => {
  const e = parseVercelLog({
    requestId: 'r1',
    proxy: { timestamp: 1_760_000_000_000, method: 'GET', host: 'docs.x.test', path: '/llms.txt?x=1', userAgent: ['codex_cli_rs/0.46.0'], statusCode: 200, clientIp: '198.51.100.4' },
  })
  expect(e).toMatchObject({ id: 'vercel-r1', path: '/llms.txt', query: 'x=1', userAgent: 'codex_cli_rs/0.46.0', ip: '198.51.100.4', status: 200 })
  expect(parseVercelLog({ id: 'build-log' })).toBeUndefined()
})

test('Cloudflare Logpush records, in every timestamp format, with request headers', () => {
  const base = { RayID: 'ray1', ClientRequestURI: '/docs?q=1', ClientRequestHost: 'docs.x.test', EdgeResponseStatus: 404, ClientRequestUserAgent: 'GPTBot/1.2' }
  expect(parseCloudflareLog({ ...base, EdgeStartTimestamp: 1_760_000_000 })!.ts).toBe(1_760_000_000_000)
  expect(parseCloudflareLog({ ...base, EdgeStartTimestamp: 1_760_000_000_000_000_000 })!.ts).toBe(1_760_000_000_000)
  expect(parseCloudflareLog({ ...base, EdgeStartTimestamp: '2026-10-09T08:53:20Z' })!.ts).toBe(Date.parse('2026-10-09T08:53:20Z'))
  expect(parseCloudflareLog({ ...base, RequestHeaders: { Accept: 'text/markdown', 'Signature-Agent': '"https://chatgpt.com"' } })).toMatchObject({ accept: 'text/markdown', signatureAgent: '"https://chatgpt.com"', status: 404 })
})

test('only agent traffic is kept', () => {
  expect(isAgentTraffic({ userAgent: 'Claude-User' })).toBe(true)
  expect(isAgentTraffic({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36' })).toBe(false)
  expect(isAgentTraffic({ userAgent: 'Mozilla/5.0 Chrome/140', path: '/llms.txt' })).toBe(true)
  expect(isAgentTraffic({ userAgent: 'Mozilla/5.0 Chrome/140', signatureAgent: '"https://chatgpt.com"' })).toBe(true)
})
