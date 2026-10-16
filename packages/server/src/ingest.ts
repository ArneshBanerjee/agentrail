import { createHmac } from 'node:crypto'
import { IncomingBatch, redactPath, redactQuery, redactText, type IncomingEvent, type StoredEvent } from '@openscope/core'
import type { Site, Store } from './store.ts'

export type Verifier = (event: IncomingEvent) => Promise<string | undefined>

export type IngestDeps = {
  readonly store: Store
  readonly secret: string
  /** Web Bot Auth. Returns the operator host when the signature checks out. */
  readonly verify?: Verifier
  readonly onStored?: (site: Site, events: readonly StoredEvent[]) => void
}

const keyedHash = (secret: string, purpose: string, value: string) =>
  createHmac('sha256', secret).update(`${purpose}\0${value}`).digest('base64url').slice(0, 22)

/** A referrer keeps its origin and path. Its query string is where emails and tokens hide. */
const cleanReferrer = (referrer: string): string => {
  const cut = referrer.split(/[?#]/)[0] ?? ''
  return redactText(cut).text
}

/**
 * The only way an event reaches the database (rule 2 in AGENTS.md).
 *
 * The address, the account id and the session hint are joined on but never shown, so they are kept
 * as keyed hashes: equal inputs still match, and the database alone cannot be turned back into
 * addresses. Free text (paths, queries, tasks, searches, errors) goes through redaction.
 */
export const toStored = async (site: Site, e: IncomingEvent, secret: string, verify?: Verifier): Promise<StoredEvent> => {
  const verifiedOperator = e.signature && e.signatureInput && verify ? await verify(e).catch(() => undefined) : undefined
  const { ip, signature: _signature, signatureInput: _signatureInput, ...rest } = e
  const stored: Record<string, unknown> = { ...rest, siteId: site.id }
  if (ip) stored.ipHash = keyedHash(secret, 'ip', ip)
  if (e.accountId) stored.accountId = keyedHash(secret, 'account', e.accountId)
  if (e.sessionHint) stored.sessionHint = keyedHash(secret, 'hint', e.sessionHint)
  if (e.path !== undefined) stored.path = redactPath(e.path).text
  if (e.query !== undefined) stored.query = redactQuery(e.query).text
  if (e.referrer !== undefined) stored.referrer = cleanReferrer(e.referrer)
  if (e.text !== undefined) stored.text = redactText(e.text).text
  if (e.error !== undefined) stored.error = redactText(e.error).text
  if (verifiedOperator) stored.verifiedOperator = verifiedOperator
  return stored as StoredEvent
}

export type IngestResult = { readonly ok: true; readonly accepted: number; readonly stored: number } | { readonly ok: false; readonly status: number; readonly error: string }

export const ingest = async (deps: IngestDeps, key: string | undefined, body: unknown): Promise<IngestResult> => {
  if (!key) return { ok: false, status: 401, error: 'missing ingest key' }
  const site = deps.store.siteByKey(key)
  if (!site) return { ok: false, status: 401, error: 'unknown ingest key' }
  const parsed = IncomingBatch.safeParse(body)
  if (!parsed.success) return { ok: false, status: 400, error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  return ingestEvents(deps, site, parsed.data.events)
}

/** For collectors inside the server (drains, Stripe) that have already found their site. */
export const ingestEvents = async (deps: IngestDeps, site: Site, events: readonly IncomingEvent[]): Promise<IngestResult> => {
  const stored = await Promise.all(events.map((e) => toStored(site, e, deps.secret, deps.verify)))
  const added = deps.store.insertEvents(stored)
  if (added > 0) deps.onStored?.(site, stored)
  return { ok: true, accepted: events.length, stored: added }
}
