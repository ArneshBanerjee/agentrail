import { expect, test } from 'vitest'
import { generateNonce, sign } from 'web-bot-auth'
import { signerFromJWK } from 'web-bot-auth/crypto'
import { OpenScope } from '@openscope/sdk'
import { isPrivateAddress, safeFetchJson, verifier } from '../src/webbotauth.ts'
import { setup, T0 } from './helpers.ts'

// The testing-only Ed25519 pair from RFC 9421 Appendix B.1.4, as published with web-bot-auth.
const TEST_KEY = { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', kid: 'test-key-ed25519', d: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' }
const { d: _private, ...PUBLIC_KEY } = TEST_KEY
const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const signed = async (agentUri: string, at: number) => {
  const signatureAgent = `sig1="${agentUri}";type=directory`
  const request = new Request('https://docs.x.test/docs/api-keys', { headers: { 'signature-agent': signatureAgent } })
  const fields = await sign(request, { signer: await signerFromJWK(TEST_KEY), created: new Date(at), expires: new Date(at + 300_000), nonce: generateNonce() })
  return new Request('https://docs.x.test/docs/api-keys', {
    headers: { signature: fields.signature, 'signature-input': fields.signatureInput, 'signature-agent': signatureAgent, 'user-agent': CHROME },
  })
}

test('a signed request through the SDK and ingest comes out verified, named by its key directory', async () => {
  const fetched: string[] = []
  const verify = verifier({
    fetchJson: async (url) => {
      fetched.push(url.href)
      return { keys: [PUBLIC_KEY] }
    },
  })
  const { app, site, get } = setup({ verify, now: () => T0 + 120_000 })
  const sdk = new OpenScope({ key: site.ingestKey, endpoint: 'http://openscope.test', flushIntervalMs: 0, fetch: ((u: string, i: RequestInit) => app.request(u, i)) as typeof fetch })
  const handler = sdk.handler(async () => new Response('docs'))

  // Each request is signed when it is made, so the clock the SDK stamps matches the signature.
  const realNow = Date.now
  Date.now = () => T0
  try {
    await handler(await signed('https://chatgpt.com', T0))
    await handler(await signed('https://chatgpt.com', T0))
  } finally {
    Date.now = realNow
  }
  await sdk.flush()

  const { body } = await get('/api/agents?days=1')
  expect(body.agents[0]).toMatchObject({ key: 'chatgpt', labels: { verified: 2 } })
  expect(body.agents[0].evidence[0].text).toBe('Web Bot Auth signature verified against chatgpt.com')
  // Two signed requests, one key fetch: the directory is cached.
  expect(fetched).toEqual(['https://chatgpt.com/.well-known/http-message-signatures-directory'])
})

test('a wrong key, another host or an expired signature is not verified', async () => {
  const otherKey = { ...PUBLIC_KEY, x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
  const wrong = verifier({ fetchJson: async () => ({ keys: [otherKey] }) })
  const right = verifier({ fetchJson: async () => ({ keys: [PUBLIC_KEY] }) })
  const req = await signed('https://chatgpt.com', T0)
  const event = {
    id: 'x', ts: T0, source: 'http' as const, kind: 'request' as const, method: 'GET', host: 'docs.x.test', path: '/docs/api-keys',
    signature: req.headers.get('signature')!, signatureInput: req.headers.get('signature-input')!, signatureAgent: req.headers.get('signature-agent')!,
  }
  expect(await right(event)).toBe('chatgpt.com')
  expect(await wrong(event)).toBeUndefined()
  // Web Bot Auth signs the authority, not the path, so a signature replayed on another host fails.
  expect(await right({ ...event, host: 'evil.test' })).toBeUndefined()
  expect(await right({ ...event, ts: T0 + 3_600_000 })).toBeUndefined()
  expect(await verifier({ enabled: false, fetchJson: async () => ({ keys: [PUBLIC_KEY] }) })(event)).toBeUndefined()
})

test('key directories on private networks, plain http or IP addresses are never fetched', async () => {
  for (const url of ['http://chatgpt.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://metadata.internal/x']) {
    await expect(safeFetchJson(new URL(url))).rejects.toThrow()
  }
  expect(['10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1'].every(isPrivateAddress)).toBe(true)
  expect(['8.8.8.8', '1.1.1.1', '2606:4700::1111'].some(isPrivateAddress)).toBe(false)
})
