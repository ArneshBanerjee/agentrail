import type { JsonWebKey } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { HTTP_MESSAGE_SIGNATURES_DIRECTORY, jwkToKeyID, parseSignatureAgentCard, verify, type SignatureAgentEntry } from 'web-bot-auth'
import { verifierFromJWK } from 'web-bot-auth/crypto'
import type { IncomingEvent } from '@agentrail/core'
import type { Verifier } from './ingest.ts'

/**
 * Web Bot Auth: an agent signs each request (RFC 9421) and publishes its public keys at a URL named
 * in `Signature-Agent`. A valid signature against those keys is what earns the `verified` label,
 * and the host that served the keys names the operator.
 *
 * The key URL comes from the request, which anyone can send, so fetching it is the risky part. Only
 * https is fetched, never an address on a private network, with a short timeout and a size cap, and
 * results are cached so one agent cannot make this server fetch the same URL on every request.
 */

const CACHE_MS = 60 * 60_000
const FAILURE_CACHE_MS = 5 * 60_000
const MAX_BYTES = 64 * 1024
const TIMEOUT_MS = 3000

type Keys = { readonly keys: JsonWebKey[] }

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./]
export const isPrivateAddress = (ip: string): boolean => {
  if (isIP(ip) === 4) return PRIVATE_V4.some((r) => r.test(ip))
  const v6 = ip.toLowerCase()
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7))
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')
}

/** RFC 7638: a key's id is the base64url SHA-256 of its canonical JSON. */
const keyId = (jwk: JsonWebKey) =>
  jwkToKeyID(
    jwk as never,
    (b) => crypto.subtle.digest('SHA-256', b),
    (buf) => Buffer.from(buf).toString('base64url'),
  )

export type KeyFetcher = (url: URL) => Promise<unknown>

/** The default fetcher: public https hosts only. */
export const safeFetchJson: KeyFetcher = async (url) => {
  if (url.protocol !== 'https:') throw new Error('key directory must be https')
  if (isIP(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.internal')) {
    throw new Error('key directory host is not public')
  }
  const addresses = await lookup(url.hostname, { all: true })
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error('key directory resolves to a private address')
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/http-message-signatures-directory+json, application/json' } })
  if (!res.ok) throw new Error(`key directory answered ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error('key directory is too large')
  return JSON.parse(text) as unknown
}

/** Where the keys are for one `Signature-Agent` entry. */
const keysFor = async (entry: SignatureAgentEntry, fetchJson: KeyFetcher): Promise<{ host: string; keys: JsonWebKey[] }> => {
  const url = new URL(entry.uri)
  if (entry.type === 'cimd') {
    const card = parseSignatureAgentCard(await fetchJson(url), url.href)
    const jwks = card.jwks ?? (card.jwks_uri ? ((await fetchJson(new URL(card.jwks_uri))) as Keys) : undefined)
    return { host: url.hostname, keys: jwks?.keys ?? [] }
  }
  const target = entry.type === 'directory' && (url.pathname === '/' || url.pathname === '') ? new URL(HTTP_MESSAGE_SIGNATURES_DIRECTORY, url) : url
  const jwks = (await fetchJson(target)) as Keys
  return { host: url.hostname, keys: Array.isArray(jwks?.keys) ? jwks.keys : [] }
}

export type VerifierOptions = {
  readonly fetchJson?: KeyFetcher
  readonly now?: () => number
  /** Set AGENTRAIL_WEB_BOT_AUTH=off to never fetch keys. Nothing is then labelled verified. */
  readonly enabled?: boolean
}

export const verifier = (options: VerifierOptions = {}): Verifier => {
  const enabled = options.enabled ?? process.env.AGENTRAIL_WEB_BOT_AUTH !== 'off'
  const fetchJson = options.fetchJson ?? safeFetchJson
  const now = options.now ?? (() => Date.now())
  type Found = { host: string; keys: JsonWebKey[] }
  // The promise is cached, not the result, so a batch of signed requests that arrive together
  // shares one fetch instead of starting one each.
  const cache = new Map<string, { at: number; found: Promise<Found> }>()

  const cached = (entry: SignatureAgentEntry): Promise<Found> => {
    const key = `${entry.type} ${entry.uri}`
    const hit = cache.get(key)
    if (hit && now() - hit.at < CACHE_MS) return hit.found
    const found = keysFor(entry, fetchJson)
    const record = { at: now(), found }
    cache.set(key, record)
    if (cache.size > 1000) cache.delete(cache.keys().next().value!)
    // A failure is kept for a shorter time, so a directory that was briefly down is tried again.
    found.catch(() => {
      record.at = now() - CACHE_MS + FAILURE_CACHE_MS
    })
    return found
  }

  return async (e: IncomingEvent) => {
    if (!enabled || !e.signature || !e.signatureInput || !e.host) return undefined
    const url = `https://${e.host}${e.path ?? '/'}${e.query ? `?${e.query}` : ''}`
    const headers = new Headers({ signature: e.signature, 'signature-input': e.signatureInput })
    if (e.signatureAgent) headers.set('signature-agent', e.signatureAgent)
    let operator: string | undefined
    try {
      await verify(new Request(url, { method: e.method ?? 'GET', headers }), {
        now: new Date(e.ts),
        resolver: async (candidate) => {
          if (!candidate.signatureAgent) throw new Error('no Signature-Agent to find keys with')
          const { host, keys } = await cached(candidate.signatureAgent)
          for (const jwk of keys) {
            if ((await keyId(jwk)) === candidate.keyid) {
              operator = host
              return verifierFromJWK(jwk as never)
            }
          }
          throw new Error('no key with that id')
        },
      })
      return operator
    } catch {
      return undefined
    }
  }
}
