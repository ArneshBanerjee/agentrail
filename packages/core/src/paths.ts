/**
 * Turn `/v1/customers/cus_8x2Lk/charges/123` into `/v1/customers/:id/charges/:id`.
 *
 * Without this, two agents that hit the same broken endpoint for two customers look like two
 * problems, and a fix is ranked by half the sessions it would save.
 */
export const normalizePath = (path: string): string => {
  const [pathname = ''] = path.split('?')
  return pathname
    .split('/')
    .map((segment) => (isId(segment) ? ':id' : segment))
    .join('/')
}

const isId = (segment: string): boolean => {
  if (!segment) return false
  if (/^\d+$/.test(segment)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true
  if (/^[0-9a-f]{16,}$/i.test(segment)) return true
  // Prefixed ids in the style many APIs use: cus_8x2Lk, ch_3Nf, pi_123.
  if (/^[a-z]{1,8}_[A-Za-z0-9]{3,}$/.test(segment) && /\d/.test(segment)) return true
  // Redaction tokens are ids for grouping purposes.
  if (/^\[[A-Z]+_\d+\]$/.test(segment)) return true
  return segment.length >= 12 && /\d/.test(segment) && /[a-z]/i.test(segment) && !segment.includes('.')
}

/** Paths an API serves. Used to tell a failed API call from a missing docs page. */
export const looksLikeApi = (path: string, host?: string): boolean =>
  /^\/(?:api|v\d+)(?:\/|$)/.test(path) || (host !== undefined && /^api\./.test(host))
