import { attribute } from './attribution.ts'
import type { IncomingEvent } from './events.ts'

/**
 * Server logs as events, for sites that cannot add middleware. Logs carry everyone's traffic, so
 * `isAgentTraffic` decides what is kept, with the same rule the SDK uses: a request a person made
 * never becomes an event.
 */

export const isAgentTraffic = (e: Pick<IncomingEvent, 'userAgent' | 'accept' | 'path' | 'signature' | 'signatureAgent'>): boolean =>
  !!e.signature || !!e.signatureAgent || attribute({ userAgent: e.userAgent, accept: e.accept, path: e.path }) !== undefined

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

/** `10/Oct/2026:13:55:36 +0530` to epoch milliseconds. */
export const parseClfTime = (s: string): number | undefined => {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s)
  if (!m) return undefined
  const month = MONTHS[m[2]!]
  if (month === undefined) return undefined
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
  const offset = (Number(m[8]) * 60 + Number(m[9])) * 60_000 * (m[7] === '+' ? 1 : -1)
  return utc - offset
}

const splitTarget = (target: string) => {
  const q = target.indexOf('?')
  return q < 0 ? { path: target } : { path: target.slice(0, q), query: target.slice(q + 1) }
}

/** A stable id from the fields of a line, so importing the same log twice stores it once. */
export const lineId = (prefix: string, line: string): string => {
  let h1 = 0x811c9dc5
  let h2 = 0
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = (Math.imul(h2, 31) + c) >>> 0
  }
  return `${prefix}-${h1.toString(36)}${h2.toString(36)}`
}

const COMBINED = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)(?: [^"]*)?" (\d{3}) \S+(?: "([^"]*)" "([^"]*)")?/

/** One line of the nginx or Apache combined format. `host` is needed because the format has none. */
export const parseCombinedLine = (line: string, host?: string): IncomingEvent | undefined => {
  const m = COMBINED.exec(line)
  if (!m) return undefined
  const ts = parseClfTime(m[2]!)
  if (ts === undefined) return undefined
  const { path, query } = splitTarget(m[4]!)
  const e: Record<string, unknown> = { id: lineId('log', line), ts, source: 'drain', kind: 'request', method: m[3], path, status: Number(m[5]), ip: m[1] }
  if (query) e.query = query
  if (host) e.host = host
  if (m[6] && m[6] !== '-') e.referrer = m[6]
  if (m[7] && m[7] !== '-') e.userAgent = m[7]
  return e as IncomingEvent
}

type VercelLog = {
  id?: string
  timestamp?: number
  host?: string
  path?: string
  statusCode?: number
  requestId?: string
  proxy?: {
    timestamp?: number
    method?: string
    host?: string
    path?: string
    userAgent?: string[] | string
    referer?: string
    statusCode?: number
    clientIp?: string
  }
}

/** A Vercel log drain record. Only proxy records describe a request from outside. */
export const parseVercelLog = (log: VercelLog): IncomingEvent | undefined => {
  const p = log.proxy
  if (!p?.path) return undefined
  const ua = Array.isArray(p.userAgent) ? p.userAgent[0] : p.userAgent
  const { path, query } = splitTarget(p.path)
  const e: Record<string, unknown> = {
    id: `vercel-${log.requestId ?? log.id ?? lineId('v', JSON.stringify(log))}`,
    ts: p.timestamp ?? log.timestamp ?? 0,
    source: 'drain',
    kind: 'request',
    method: p.method ?? 'GET',
    path,
  }
  if (query) e.query = query
  if (p.host ?? log.host) e.host = p.host ?? log.host
  const status = p.statusCode ?? log.statusCode
  if (status && status >= 100) e.status = status
  if (ua) e.userAgent = ua
  if (p.referer) e.referrer = p.referer
  if (p.clientIp) e.ip = p.clientIp
  return e as IncomingEvent
}

type CloudflareLog = {
  RayID?: string
  ClientIP?: string
  ClientRequestHost?: string
  ClientRequestMethod?: string
  ClientRequestURI?: string
  ClientRequestPath?: string
  ClientRequestUserAgent?: string
  ClientRequestReferer?: string
  EdgeResponseStatus?: number
  EdgeResponseContentType?: string
  EdgeStartTimestamp?: number | string
  RequestHeaders?: Record<string, string>
}

/** Logpush gives timestamps as RFC 3339, Unix seconds or Unix nanoseconds, depending on its settings. */
const cfTime = (t: number | string | undefined): number => {
  if (t === undefined) return 0
  if (typeof t === 'string') return Date.parse(t)
  if (t > 1e17) return Math.floor(t / 1e6)
  if (t > 1e11) return t
  return t * 1000
}

/** One Cloudflare Logpush record from the `http_requests` dataset. */
export const parseCloudflareLog = (log: CloudflareLog): IncomingEvent | undefined => {
  const target = log.ClientRequestURI ?? log.ClientRequestPath
  if (!target) return undefined
  const { path, query } = splitTarget(target)
  const e: Record<string, unknown> = {
    id: `cf-${log.RayID ?? lineId('c', JSON.stringify(log))}`,
    ts: cfTime(log.EdgeStartTimestamp),
    source: 'drain',
    kind: 'request',
    method: log.ClientRequestMethod ?? 'GET',
    path,
  }
  if (query) e.query = query
  if (log.ClientRequestHost) e.host = log.ClientRequestHost
  if (log.EdgeResponseStatus && log.EdgeResponseStatus >= 100) e.status = log.EdgeResponseStatus
  if (log.EdgeResponseContentType) e.contentType = log.EdgeResponseContentType
  if (log.ClientRequestUserAgent) e.userAgent = log.ClientRequestUserAgent
  if (log.ClientRequestReferer) e.referrer = log.ClientRequestReferer
  if (log.ClientIP) e.ip = log.ClientIP
  const headers = Object.fromEntries(Object.entries(log.RequestHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  if (headers.accept) e.accept = headers.accept
  if (headers.signature) e.signature = headers.signature
  if (headers['signature-input']) e.signatureInput = headers['signature-input']
  if (headers['signature-agent']) e.signatureAgent = headers['signature-agent']
  return e as IncomingEvent
}
