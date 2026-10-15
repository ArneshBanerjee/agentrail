import type { Session } from './journey.ts'

/**
 * Group the tasks agents were given into intents, and say which intents turn into customers.
 *
 * Without a model this is keyword grouping: a workspace can name its own intents with keywords, and
 * whatever matches none of them is grouped by the word it shares most with other tasks. A model
 * can rename the groups later (the server does that when a provider is set), but the grouping
 * itself stays here so the numbers do not change with the model.
 */

export type IntentDefinition = {
  readonly id: string
  readonly label: string
  readonly keywords: readonly string[]
}

export type IntentGroup = {
  readonly id: string
  readonly label: string
  readonly sessions: number
  readonly converted: number
  readonly conversion: number
  readonly revenue: number
  /** Up to three tasks, in the agents' words, newest first. */
  readonly quotes: readonly string[]
  readonly sessionIds: readonly string[]
}

const STOPWORDS = new Set(
  'a an the and or but if then to of for in on at by with from into onto up down out over under via per as is are was were be been being do does did done have has had it its this that these those our your their my me we you they them i he she his her let lets let\'s can could should would will shall may might must not no yes so than too very just also only all any each every some such own same other new set setup make get use using how what which who when where why please need want help create add run return using one two'.split(
    ' ',
  ),
)

/** A stem good enough to make "refunds", "refund" and "refunding" one word. */
export const stem = (word: string): string => {
  let w = word.toLowerCase()
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`
  else if (w.length > 4 && w.endsWith('es') && /(?:ch|sh|ss|x)es$/.test(w)) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  return w
}

export const keywords = (text: string): string[] =>
  [...new Set(
    text
      .toLowerCase()
      .replace(/\[[A-Z_0-9]+\]/gi, ' ')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
      .map(stem),
  )]

const titleCase = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)

export type IntentOptions = {
  readonly definitions?: readonly IntentDefinition[]
  readonly conversionStep?: string
}

/** Which group each session's intent falls into. Sessions with no stated task are left out. */
export const assignIntents = (
  sessions: readonly Session[],
  definitions: readonly IntentDefinition[] = [],
): Map<string, { id: string; label: string }> => {
  const assigned = new Map<string, { id: string; label: string }>()
  const defs = definitions.map((d) => ({ ...d, stems: d.keywords.map(stem) }))
  const leftovers: { session: Session; words: string[] }[] = []

  for (const s of sessions) {
    if (!s.intent) continue
    const words = keywords(s.intent)
    let best: { id: string; label: string; score: number } | undefined
    for (const d of defs) {
      const score = d.stems.filter((k) => words.includes(k)).length
      if (score > 0 && (!best || score > best.score)) best = { id: d.id, label: d.label, score }
    }
    if (best) assigned.set(s.id, { id: best.id, label: best.label })
    else leftovers.push({ session: s, words })
  }

  // Each leftover goes to its most shared word, so the groups that come out are the words agents
  // actually use. A word used once is no group, and those tasks fall into "Other".
  const frequency = new Map<string, number>()
  for (const l of leftovers) for (const w of l.words) frequency.set(w, (frequency.get(w) ?? 0) + 1)
  for (const l of leftovers) {
    const top = l.words
      .filter((w) => (frequency.get(w) ?? 0) >= 2)
      .sort((a, b) => (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0) || a.localeCompare(b))[0]
    assigned.set(l.session.id, top ? { id: `kw:${top}`, label: titleCase(top) } : { id: 'other', label: 'Other' })
  }
  return assigned
}

export const groupIntents = (sessions: readonly Session[], options: IntentOptions = {}): IntentGroup[] => {
  const conversionStep = options.conversionStep ?? 'first_payment'
  const assigned = assignIntents(sessions, options.definitions)
  const groups = new Map<string, { label: string; sessions: Session[] }>()
  for (const s of sessions) {
    const a = assigned.get(s.id)
    if (!a) continue
    const g = groups.get(a.id)
    if (g) g.sessions.push(s)
    else groups.set(a.id, { label: a.label, sessions: [s] })
  }
  return [...groups.entries()]
    .map(([id, g]) => {
      const converted = g.sessions.filter((s) => conversionStep in s.reached).length
      const newest = [...g.sessions].sort((a, b) => b.startedAt - a.startedAt)
      return {
        id,
        label: g.label,
        sessions: g.sessions.length,
        converted,
        conversion: converted / g.sessions.length,
        revenue: g.sessions.reduce((sum, s) => sum + s.revenue, 0),
        quotes: [...new Set(newest.map((s) => s.intent!))].slice(0, 3),
        sessionIds: newest.map((s) => s.id),
      }
    })
    .sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label))
}
