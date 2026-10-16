import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/* ---------- API ---------- */

const read = (key: string) => {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}
const write = (key: string, value: string | undefined) => {
  try {
    if (value === undefined) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage can be blocked. The dashboard still works, it just forgets.
  }
}

export const session = {
  token: () => read('openscope.token'),
  setToken: (t: string | undefined) => write('openscope.token', t),
  workspace: () => read('openscope.workspace'),
  setWorkspace: (w: string) => write('openscope.workspace', w),
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * A custom range replaces `days=` on list and summary requests. Lookups of one session or one fix are
 * left alone, so an item outside the range still opens.
 */
const withRange = (path: string) => {
  const r = range
  if (!r || !/[?&]days=/.test(path) || /^\/api\/(sessions|fixes)\/[^?]/.test(path)) return path
  return path.replace(/([?&])days=\d+/, `$1from=${r.from}&to=${r.to}`)
}

export const api = async <T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> => {
  path = withRange(path)
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  const token = session.token()
  if (token) headers.authorization = `Bearer ${token}`
  const ws = session.workspace()
  if (ws) headers['x-workspace'] = ws
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(path, { ...init, headers, ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) })
  if (!res.ok) {
    let message = `${res.status}`
    try {
      message = ((await res.json()) as { error?: string }).error ?? message
    } catch {
      // Not JSON. The status says enough.
    }
    throw new ApiError(res.status, message)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Refetches when `deps` change and when `bump()` is called, for example on a live arrival. */
const subscribeWindow = (l: () => void) => {
  windowListeners.add(l)
  return () => windowListeners.delete(l)
}

export const useApi = <T,>(path: string | undefined, deps: unknown[] = []) => {
  // A new time window refetches every request, even when the path reads the same.
  const win = useSyncExternalStore(subscribeWindow, () => windowKey)
  const [data, setData] = useState<T>()
  const [error, setError] = useState<ApiError>()
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!path) return
    let alive = true
    setLoading(true)
    api<T>(path)
      .then((d) => alive && (setData(d), setError(undefined)))
      .catch((e: ApiError) => alive && setError(e))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, win, ...deps])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload }
}

/* ---------- Router ---------- */

const listeners = new Set<() => void>()
window.addEventListener('popstate', () => listeners.forEach((l) => l()))

export const navigate = (to: string) => {
  if (to === location.pathname + location.search) return
  history.pushState(null, '', to)
  listeners.forEach((l) => l())
  window.scrollTo(0, 0)
}

export const useLocation = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => location.pathname + location.search,
  )

export const useQuery = () => new URLSearchParams(useLocation().split('?')[1] ?? '')

export const setQuery = (patch: Record<string, string | undefined>) => {
  const q = new URLSearchParams(location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '') q.delete(k)
    else q.set(k, v)
  }
  const s = q.toString()
  history.replaceState(null, '', `${location.pathname}${s ? `?${s}` : ''}`)
  listeners.forEach((l) => l())
}

/* ---------- Window and live ---------- */

const windowListeners = new Set<() => void>()
let days = Number(read('openscope.days') ?? 30) || 30
let range: { from: number; to: number } | undefined
// One key that changes whenever the window changes, so pages refetch on a new custom range too.
let windowKey = `d${days}`
const notify = () => {
  windowKey = range ? `r${range.from}-${range.to}` : `d${days}`
  windowListeners.forEach((l) => l())
}
export const useDays = () => {
  useSyncExternalStore(
    (l) => {
      windowListeners.add(l)
      return () => windowListeners.delete(l)
    },
    () => windowKey,
  )
  const set = (d: number) => {
    days = d
    range = undefined
    write('openscope.days', String(d))
    notify()
  }
  // With a custom range, `days` is its length, for text such as "12 days". `api()` sends the exact range.
  const value = range ? Math.max(1, Math.round((range.to - range.from) / 86_400_000)) : days
  return [value, set] as const
}

export const useRange = () => {
  useSyncExternalStore(
    (l) => {
      windowListeners.add(l)
      return () => windowListeners.delete(l)
    },
    () => windowKey,
  )
  const set = (r: { from: number; to: number } | undefined) => {
    range = r
    notify()
  }
  const now = Date.now()
  return [range ?? { from: now - days * 86_400_000, to: now }, set, range !== undefined] as const
}

export type Arrival = { agent: string; label: string; surface: string; path?: string; kind: string; ts: number }

const liveListeners = new Set<(a: Arrival) => void>()
let liveState: 'off' | 'on' = 'off'
const stateListeners = new Set<() => void>()
let source: EventSource | undefined

export const connectLive = () => {
  source?.close()
  const q = new URLSearchParams()
  const t = session.token()
  const w = session.workspace()
  if (t) q.set('token', t)
  if (w) q.set('workspace', w)
  source = new EventSource(`/api/live?${q}`)
  source.onopen = () => {
    liveState = 'on'
    stateListeners.forEach((l) => l())
  }
  source.onerror = () => {
    liveState = 'off'
    stateListeners.forEach((l) => l())
  }
  source.addEventListener('arrival', (e) => {
    const a = JSON.parse((e as MessageEvent).data) as Arrival
    liveListeners.forEach((l) => l(a))
  })
}

export const useLiveState = () =>
  useSyncExternalStore(
    (l) => {
      stateListeners.add(l)
      return () => stateListeners.delete(l)
    },
    () => liveState,
  )

/** Calls `onArrival` for each live arrival, and `onSettled` once arrivals stop for a moment. */
export const useLive = (onArrival?: (a: Arrival) => void, onSettled?: () => void) => {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const a = useRef(onArrival)
  const s = useRef(onSettled)
  a.current = onArrival
  s.current = onSettled
  useEffect(() => {
    const l = (x: Arrival) => {
      a.current?.(x)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => s.current?.(), 1500)
    }
    liveListeners.add(l)
    return () => {
      liveListeners.delete(l)
      clearTimeout(timer.current)
    }
  }, [])
}

/* ---------- Formatting ---------- */

export const fmt = {
  n: (x: number) => x.toLocaleString('en-US'),
  pct: (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`,
  pts: (x: number) => `${x >= 0 ? '▲' : '▼'} ${Math.abs(x * 100).toFixed(1)} pts`,
  change: (x: number) => `${x >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(x * 100))}%`,
  money: (minor: number, currency = 'usd', compact = false) => {
    const value = minor / 100
    if (compact && Math.abs(value) >= 1000) {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), notation: 'compact', maximumFractionDigits: 1 }).format(value)
    }
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value)
  },
  clock: (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    const pad = (v: number) => String(v).padStart(2, '0')
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
  },
  duration: (ms: number) => {
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s} s`
    if (s < 3600) return `${Math.round(s / 60)} min`
    return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`
  },
  ago: (ts: number, now = Date.now()) => {
    const s = Math.round((now - ts) / 1000)
    if (s < 60) return `${Math.max(s, 0)}s ago`
    if (s < 3600) return `${Math.round(s / 60)}m ago`
    if (s < 86400) return `${Math.round(s / 3600)}h ago`
    return `${Math.round(s / 86400)}d ago`
  },
  date: (ts: number) => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  day: (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
}

/** "First API call" becomes "first API call" in a sentence, not "first api call". */
export const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s)

export const AGENT_COLORS = ['var(--a1)', 'var(--a2)', 'var(--a3)', 'var(--a4)', 'var(--a5)', 'var(--a6)']
