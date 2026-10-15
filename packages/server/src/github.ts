/**
 * The four GitHub calls a published fix needs: read the file, branch, commit, open a pull request.
 * A pull request and not a direct commit, so a person reviews every change Agentrail proposes.
 */

export type GitHubConfig = { readonly repo: string; readonly token: string; readonly branch?: string | undefined }

const API = 'https://api.github.com'

const call = async <T>(config: GitHubConfig, path: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<T> => {
  const res = await fetcher(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${config.token}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  })
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { message?: string }).message ?? message
    } catch {
      // The status line is enough.
    }
    const error = new Error(`GitHub ${res.status}: ${message}`) as Error & { status: number }
    error.status = res.status
    throw error
  }
  return (await res.json()) as T
}

const toBase64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
const fromBase64 = (b64: string) => Buffer.from(b64, 'base64').toString('utf8')

export const readFile = async (config: GitHubConfig, path: string, fetcher?: typeof fetch): Promise<{ content: string; sha: string } | undefined> => {
  try {
    const ref = config.branch ? `?ref=${encodeURIComponent(config.branch)}` : ''
    const file = await call<{ content: string; sha: string; type: string }>(config, `/repos/${config.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${ref}`, {}, fetcher)
    return file.type === 'file' ? { content: fromBase64(file.content), sha: file.sha } : undefined
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined
    throw error
  }
}

/** The first of these paths that exists. Docs live as `x.md`, `x.mdx` or `x/index.md(x)`. */
export const findDocsFile = async (config: GitHubConfig, docsRoot: string, pagePath: string, fetcher?: typeof fetch) => {
  const clean = pagePath.replace(/^\/+|\/+$/g, '').replace(/\.(md|mdx|html)$/, '')
  const root = docsRoot.replace(/^\/+|\/+$/g, '')
  const stems = [clean, clean.replace(/^docs\//, '')].filter((v, i, a) => a.indexOf(v) === i)
  for (const stem of stems) {
    for (const suffix of ['.md', '.mdx', '/index.md', '/index.mdx']) {
      const path = [root, `${stem}${suffix}`].filter(Boolean).join('/')
      const file = await readFile(config, path, fetcher)
      if (file) return { path, ...file }
    }
  }
  return undefined
}

export type PullRequestInput = {
  readonly path: string
  readonly content: string
  readonly title: string
  readonly body: string
  readonly branchName: string
}

export const openPullRequest = async (config: GitHubConfig, input: PullRequestInput, fetcher?: typeof fetch): Promise<string> => {
  const repo = await call<{ default_branch: string }>(config, `/repos/${config.repo}`, {}, fetcher)
  const base = config.branch ?? repo.default_branch
  const head = await call<{ object: { sha: string } }>(config, `/repos/${config.repo}/git/ref/heads/${encodeURIComponent(base)}`, {}, fetcher)
  await call(config, `/repos/${config.repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${input.branchName}`, sha: head.object.sha }) }, fetcher)
  const existing = await readFile({ ...config, branch: input.branchName }, input.path, fetcher)
  await call(
    config,
    `/repos/${config.repo}/contents/${input.path.split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'PUT',
      body: JSON.stringify({ message: input.title, content: toBase64(input.content), branch: input.branchName, ...(existing ? { sha: existing.sha } : {}) }),
    },
    fetcher,
  )
  const pr = await call<{ html_url: string }>(
    config,
    `/repos/${config.repo}/pulls`,
    { method: 'POST', body: JSON.stringify({ title: input.title, body: input.body, head: input.branchName, base }) },
    fetcher,
  )
  return pr.html_url
}
