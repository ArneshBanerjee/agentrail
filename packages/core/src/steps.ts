import type { StoredEvent } from './events.ts'
import { looksLikeApi } from './paths.ts'

/**
 * Plain names for what an agent did: "read", "sign-in started", "poll 3 / 7", "subscription
 * created". A journey made of `POST /v1/subscriptions 200` lines is a log. A journey made of names
 * is something a product manager reads.
 *
 * Names come from rules first, so a product can name its own flows, then from the shape of the
 * request: the method, the last resource in the path, and the status.
 */

export type StepRule = {
  /** A path with `*` for one segment and `**` for any number of them. */
  readonly path: string
  readonly method?: string
  readonly name: string
}

export const DOCS_FINDER_PATH = '/api/docs/find'

export const DEFAULT_STEP_RULES: readonly StepRule[] = [
  { path: DOCS_FINDER_PATH, name: 'intent declared' },
  { path: '/.well-known/agent-task', name: 'intent declared' },
  { path: '**/cli/init', name: 'init' },
  { path: '**/device/start', name: 'sign-in started' },
  { path: '**/device/code', name: 'sign-in started' },
  { path: '**/device/poll', name: 'poll' },
  { path: '**/device/token', name: 'poll' },
  { path: '**/oauth/token', name: 'token exchange' },
  { path: '**/login', method: 'POST', name: 'signed in' },
]

const DOWNLOAD = /\.(?:tgz|tar\.gz|zip|whl|dmg|pkg|exe|msi|deb|rpm|AppImage)$|\/(?:dl|download|downloads|releases)\//i

const globToRegex = (glob: string) =>
  new RegExp(
    `^${glob
      .split('/')
      .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]+' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')
      .replace(/\.\*\//g, '(?:.*/)?')}$`,
  )

const ruleCache = new Map<string, RegExp>()
const matchRule = (rules: readonly StepRule[], method: string, path: string) =>
  rules.find((r) => {
    if (r.method && r.method.toUpperCase() !== method) return false
    let re = ruleCache.get(r.path)
    if (!re) {
      re = globToRegex(r.path)
      ruleCache.set(r.path, re)
    }
    return re.test(path)
  })

const isId = (s: string) => /\d/.test(s) && (/^[a-z]{1,8}_[A-Za-z0-9]+$/.test(s) || /^[0-9a-f-]{8,}$/i.test(s) || /^\d+$/.test(s) || /^\[[A-Z]+_\d+\]$/.test(s))

const singular = (word: string) => {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`
  if (/(ss|us)$/.test(word)) return word
  if (/(ches|shes|xes|ses)$/.test(word)) return word.slice(0, -2)
  return word.replace(/s$/, '')
}

/** "meter_events" to "meter event", "webhook_endpoints" to "webhook endpoint". */
const resourceName = (segment: string) => singular(segment.replace(/[-_]+/g, ' ').trim())

export const isDownload = (path: string) => DOWNLOAD.test(path)

/** The plain name of one event. */
export const stepName = (e: StoredEvent, rules: readonly StepRule[] = DEFAULT_STEP_RULES): string => {
  switch (e.kind) {
    case 'intent':
      return 'intent declared'
    case 'search':
      return 'searched'
    case 'step':
      return e.ok === false ? `${(e.step ?? 'step').replaceAll('_', ' ')} failed` : (e.step ?? 'step').replaceAll('_', ' ')
    case 'identify':
      return 'account linked'
    case 'mcp_connect':
      return 'MCP connected'
    case 'mcp_tool':
      return e.ok === false || e.error ? `${e.tool ?? 'tool'} failed` : (e.tool ?? 'tool call')
    case 'payment':
      return e.ok === false ? 'payment failed' : 'payment'
    case 'request':
      break
  }
  const method = (e.method ?? 'GET').toUpperCase()
  const path = e.path ?? '/'
  const status = e.status ?? 200
  const rule = matchRule(rules, method, path)
  if (rule) return status >= 400 && rule.name !== 'poll' ? `${rule.name} failed` : rule.name
  if (method === 'GET' && !looksLikeApi(path, e.host)) {
    if (status === 404) return 'not found'
    return isDownload(path) ? 'download' : 'read'
  }
  const segments = path.split('/').filter(Boolean).filter((s) => !/^(api|v\d+)$/.test(s))
  const last = segments.at(-1) ?? ''
  const hasId = isId(last)
  const resource = resourceName((hasId ? segments.at(-2) : last) ?? 'request') || 'request'
  if (status === 401 || status === 403) return 'unauthorized'
  if (status >= 400) return `${resource.replace(/ endpoint$/, '')} refused`
  if (method === 'GET') return hasId ? `${resource} read` : `${resource} read`
  if (method === 'DELETE') return `${resource} deleted`
  if (method === 'PATCH' || method === 'PUT') return `${resource} updated`
  // An event is the thing itself. A subscription is something created.
  return /\bevent$/.test(resource) || hasId ? resource : `${resource} created`
}

/** The version in a user agent after a product token: "claude-code/2.1.90" gives "2.1.90". */
export const versionIn = (userAgent: string | undefined, token: string): string | undefined => {
  if (!userAgent) return undefined
  const i = userAgent.toLowerCase().indexOf(token.toLowerCase())
  if (i < 0) return undefined
  return /^\/([\d][\w.-]*)/.exec(userAgent.slice(i + token.length))?.[1]
}
