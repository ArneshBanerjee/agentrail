/**
 * Remove sensitive values from text before it is stored.
 *
 * Agents put real data in what they send: an email in a query string, a customer's card in a task,
 * an API key in a pasted curl command. A product that records agent traffic records all of that
 * unless something removes it first. The design comes from Blindfold: checksums decide where a
 * pattern alone would guess (Luhn for cards, Verhoeff for Aadhaar, mod 97 for IBAN), and each value
 * becomes a token that names its kind, so a reader still knows what was there.
 *
 * Names and street addresses are not detected. That needs a language model, and a regular
 * expression for names finds every capitalised word.
 */

export type SensitiveKind =
  | 'EMAIL'
  | 'PHONE'
  | 'CARD'
  | 'AADHAAR'
  | 'PAN'
  | 'SSN'
  | 'IBAN'
  | 'SECRET'
  | 'IP'

export type Redacted = {
  readonly text: string
  readonly kinds: readonly SensitiveKind[]
}

const luhn = (digits: string): boolean => {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

const verhoeff = (digits: string): boolean => {
  let c = 0
  const reversed = [...digits].reverse()
  for (let i = 0; i < reversed.length; i++) {
    const d = Number(reversed[i])
    c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![d]!]!
  }
  return c === 0
}

const ibanValid = (raw: string): boolean => {
  const iban = raw.replaceAll(' ', '').toUpperCase()
  const moved = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of moved) {
    const value = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

const onlyDigits = (s: string) => s.replace(/\D/g, '')

type Detector = {
  readonly kind: SensitiveKind
  readonly pattern: RegExp
  readonly valid?: (match: string) => boolean
}

/**
 * Order matters. Secrets go first because a key can contain a run of digits that would otherwise
 * be read as a card, and the more specific number formats go before the phone pattern.
 */
const DETECTORS: readonly Detector[] = [
  {
    kind: 'SECRET',
    pattern:
      /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { kind: 'SECRET', pattern: /\b(?<=Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g },
  { kind: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    kind: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    valid: ibanValid,
  },
  { kind: 'CARD', pattern: /\b\d(?:[ -]?\d){12,18}\b/g, valid: (m) => luhn(onlyDigits(m)) },
  {
    kind: 'AADHAAR',
    pattern: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    valid: (m) => verhoeff(onlyDigits(m)),
  },
  { kind: 'PAN', pattern: /\b[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z]\b/g },
  { kind: 'SSN', pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  {
    kind: 'IP',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    // A phone needs a plus sign or separators, or the Indian mobile shape. Bare runs of digits are
    // order numbers, amounts and timestamps far more often than they are phones. A group that is
    // part of a longer run of digit groups is a card-like number that failed its checksum.
    kind: 'PHONE',
    pattern: /(?<![\w+]|\d[ .-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]\d{3,4}\b(?![ .-]\d)|(?<![\w+]|\d[ .-])(?:\+91[ -]?)?[6-9]\d{9}\b(?![ .-]\d)/g,
  },
]

/** Query parameters whose value is sensitive whatever it looks like. */
const SENSITIVE_PARAMS = /^(?:token|access_token|refresh_token|id_token|key|api_key|apikey|secret|client_secret|password|passwd|pwd|pass|auth|authorization|code|session|sessionid|sid|sig|signature|otp|email|phone|mobile)$/i

/**
 * Replace each sensitive value with `[KIND_n]`. The same value gets the same token within one call,
 * so "refund a@b.co and email a@b.co" still reads as one person.
 */
export const redactText = (input: string): Redacted => {
  const seen = new Map<string, string>()
  const counts = new Map<SensitiveKind, number>()
  const kinds = new Set<SensitiveKind>()
  let text = input
  for (const detector of DETECTORS) {
    text = text.replace(detector.pattern, (match) => {
      if (/^\[[A-Z]+_\d+\]$/.test(match)) return match
      if (detector.valid && !detector.valid(match)) return match
      const key = `${detector.kind}:${match}`
      const known = seen.get(key)
      if (known) return known
      const n = (counts.get(detector.kind) ?? 0) + 1
      counts.set(detector.kind, n)
      kinds.add(detector.kind)
      const token = `[${detector.kind}_${n}]`
      seen.set(key, token)
      return token
    })
  }
  return { text, kinds: [...kinds] }
}

/**
 * Redact a query string. Values of sensitive parameters go whatever they hold, and every other value
 * is scanned like text. Keys are kept, because "which parameter did the agent get wrong" is the
 * question a fix needs answered.
 */
export const redactQuery = (query: string): Redacted => {
  const raw = query.startsWith('?') ? query.slice(1) : query
  if (!raw) return { text: '', kinds: [] }
  const kinds = new Set<SensitiveKind>()
  const parts = raw.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    if (eq < 0) return pair
    const key = pair.slice(0, eq)
    let value: string
    try {
      value = decodeURIComponent(pair.slice(eq + 1).replaceAll('+', ' '))
    } catch {
      value = pair.slice(eq + 1)
    }
    if (SENSITIVE_PARAMS.test(key)) {
      kinds.add('SECRET')
      return `${key}=[REDACTED]`
    }
    const r = redactText(value)
    for (const k of r.kinds) kinds.add(k)
    return r.kinds.length > 0 ? `${key}=${r.text}` : pair
  })
  return { text: parts.join('&'), kinds: [...kinds] }
}

/** Paths carry ids and sometimes emails: `/users/a@b.co/settings`. */
export const redactPath = (path: string): Redacted => {
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // A path that does not decode is scanned as it came.
  }
  const r = redactText(decoded)
  return r.kinds.length > 0 ? r : { text: path, kinds: [] }
}
