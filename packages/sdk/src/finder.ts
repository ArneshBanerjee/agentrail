import { keywords } from '@agentrail/core'

/**
 * A docs finder: an agent sends what it is trying to do and gets back the pages that answer it.
 *
 * This is how a product learns an agent's task without asking the agent to report anything. The
 * agent uses the finder because it is useful, and the query it sends is its task, in the words the
 * person gave it. Plain Claude Code with no plugin does this as soon as `llms.txt` mentions the
 * finder, which is what makes the intent column work for agents nobody configured.
 */

export type DocPage = {
  readonly path: string
  readonly title: string
  readonly description?: string
}

/** Pages listed in an `llms.txt` file: `- [Title](/path): description`. */
export const parseLlmsTxt = (text: string, origin?: string): DocPage[] => {
  const pages: DocPage[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/.exec(line)
    if (!m) continue
    let path = m[2]!
    if (origin && path.startsWith(origin)) path = path.slice(origin.length) || '/'
    if (/^https?:\/\//.test(path)) continue
    pages.push({ title: m[1]!.trim(), path, ...(m[3] ? { description: m[3].trim() } : {}) })
  }
  return pages
}

export type FinderResult = { readonly title: string; readonly path: string; readonly description?: string; readonly score: number }

/** Pages ranked by shared words with the query. Title words count most, then the path, then the description. */
export const findPages = (query: string, pages: readonly DocPage[], limit = 5): FinderResult[] => {
  const want = keywords(query)
  if (want.length === 0) return []
  return pages
    .map((page) => {
      const title = keywords(page.title)
      const path = keywords(page.path.replace(/[/_-]+/g, ' '))
      const description = keywords(page.description ?? '')
      let score = 0
      for (const w of want) {
        if (title.includes(w)) score += 3
        if (path.includes(w)) score += 2
        if (description.includes(w)) score += 1
      }
      return { title: page.title, path: page.path, ...(page.description ? { description: page.description } : {}), score }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/** The question an agent sent, from a JSON body, a form, plain text or a query string. */
export const queryOf = async (request: Request): Promise<string | undefined> => {
  const url = new URL(request.url)
  const fromUrl = url.searchParams.get('q') ?? url.searchParams.get('query') ?? url.searchParams.get('task')
  if (fromUrl) return fromUrl
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  try {
    const type = request.headers.get('content-type') ?? ''
    if (/json/i.test(type)) {
      const body = (await request.json()) as Record<string, unknown>
      const value = body.query ?? body.q ?? body.task ?? body.intent ?? body.goal
      return typeof value === 'string' ? value : undefined
    }
    const text = (await request.text()).trim()
    if (/^[{[]/.test(text)) {
      const body = JSON.parse(text) as Record<string, unknown>
      const value = body.query ?? body.q ?? body.task ?? body.intent
      return typeof value === 'string' ? value : undefined
    }
    return text || undefined
  } catch {
    return undefined
  }
}
