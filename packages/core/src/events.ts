import { z } from 'zod'

/**
 * Every collector (middleware, track API, MCP wrapper, log drains, Stripe, the intake endpoint and
 * the agent runner) produces this one shape. A journey can then join docs, API and MCP traffic
 * without knowing where each piece came from.
 */

export const EventSource = z.enum(['http', 'track', 'mcp', 'drain', 'stripe', 'intake', 'runner'])
export type EventSource = z.infer<typeof EventSource>

export const EventKind = z.enum([
  /** One HTTP request to a page, a docs file or an API. */
  'request',
  /** A query typed into the product's own search. */
  'search',
  /** The task the agent was given, in the person's words. */
  'intent',
  /** A product step only the product can see: installed, signed in, first API call. */
  'step',
  /** Links the session to an account, so later payments can find it. */
  'identify',
  'mcp_connect',
  'mcp_tool',
  'payment',
])
export type EventKind = z.infer<typeof EventKind>

const short = z.string().max(2048)

export const IncomingEvent = z.object({
  /** Set by the collector so a retried batch does not count twice. */
  id: z.string().min(1).max(128),
  ts: z.number().int().nonnegative(),
  source: EventSource,
  kind: EventKind,

  method: z.string().max(16).optional(),
  host: z.string().max(255).optional(),
  path: short.optional(),
  query: short.optional(),
  status: z.number().int().min(100).max(599).optional(),
  durationMs: z.number().nonnegative().optional(),
  referrer: short.optional(),
  accept: z.string().max(512).optional(),
  contentType: z.string().max(255).optional(),
  userAgent: z.string().max(1024).optional(),
  /** The caller's address. The server turns it into a keyed hash and never stores it. */
  ip: z.string().max(64).optional(),
  /** Request headers for Web Bot Auth. Only these three are kept. */
  signature: z.string().max(4096).optional(),
  signatureInput: z.string().max(4096).optional(),
  signatureAgent: z.string().max(1024).optional(),

  step: z.string().max(64).optional(),
  text: z.string().max(4096).optional(),
  accountId: z.string().max(256).optional(),
  /** Minor units, so cents and paise add up without floating point. */
  amount: z.number().int().optional(),
  currency: z.string().max(8).optional(),
  ok: z.boolean().optional(),
  error: z.string().max(1024).optional(),

  mcpClient: z.string().max(128).optional(),
  mcpClientVersion: z.string().max(64).optional(),
  tool: z.string().max(128).optional(),

  /**
   * A session id the collector already knows: an MCP session, a CLI login, an API key hash. It joins
   * events more reliably than address and user agent.
   */
  sessionHint: z.string().max(256).optional(),
  /** Set by the agent runner, so test runs never mix with real traffic. */
  runId: z.string().max(128).optional(),
})
export type IncomingEvent = z.infer<typeof IncomingEvent>

export const IncomingBatch = z.object({ events: z.array(IncomingEvent).min(1).max(500) })
export type IncomingBatch = z.infer<typeof IncomingBatch>

/** What the server stores, after redaction and attribution. */
export type StoredEvent = Omit<IncomingEvent, 'ip' | 'signature' | 'signatureInput'> & {
  readonly siteId: string
  /** Keyed hash of the address. Joins requests without keeping the address. */
  readonly ipHash?: string
  /** Set only when the Web Bot Auth signature checked out. The value is the key directory host. */
  readonly verifiedOperator?: string
}
