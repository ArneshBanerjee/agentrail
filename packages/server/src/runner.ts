import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findClaude, providerStatus, runClaudeCode, chatFor, type Chat, type ChatMessage } from './llm.ts'
import type { WorkspaceSettings } from './store.ts'

/**
 * Real agents, run on purpose, against a preview of the product. A fix is tested by running the task
 * agents were given before and after the change, and counting how many runs get past the step that
 * stopped them.
 *
 * Every request a run makes carries `X-Agentrail-Run`. The SDK records it as the run id, so the
 * outcome is measured by the product's own collector, the same way real traffic is, and never mixes
 * with real traffic. When the target has no collector, the agent's own report is used and the run
 * says so.
 */

export const RUN_HEADER = 'X-Agentrail-Run'

export type RunnerAgent = { readonly id: string; readonly label: string; readonly ready: boolean; readonly detail: string }

export const runnerAgents = (llm: WorkspaceSettings['llm'], env: NodeJS.ProcessEnv = process.env): RunnerAgent[] => {
  const claude = findClaude(env)
  const apis = providerStatus(llm, env).filter((p) => p.id !== 'claude-code')
  return [
    { id: 'claude-code', label: 'Claude Code', ready: !!claude, detail: claude ? 'Runs headless with curl as its only network tool.' : 'Install Claude Code and sign in on this server.' },
    ...apis.map((p) => ({ id: `api:${p.id}`, label: `${p.label} agent`, ready: p.ready, detail: 'A small HTTP agent loop driven by this model.' })),
  ]
}

export type RunOutcome = {
  /** What the agent said at the end. */
  readonly selfReport?: { readonly success: boolean; readonly summary?: string }
  readonly transcript: string
}

export type RunInput = {
  readonly runId: string
  readonly agent: string
  readonly task: string
  readonly targetUrl: string
  readonly timeoutMs: number
  readonly settings: WorkspaceSettings
  readonly fetcher?: typeof fetch
  readonly env?: NodeJS.ProcessEnv
}

const FINAL = /\{[^{}]*"success"\s*:\s*(true|false)[^{}]*\}\s*$/

const parseFinal = (text: string): RunOutcome['selfReport'] => {
  const match = FINAL.exec(text.trim())
  if (!match) return undefined
  try {
    const value = JSON.parse(match[0]) as { success?: unknown; summary?: unknown }
    return { success: value.success === true, ...(typeof value.summary === 'string' ? { summary: value.summary } : {}) }
  } catch {
    return undefined
  }
}

const brief = (input: RunInput) => `You are testing a product as an AI agent would use it for a real person.

Product: ${input.targetUrl}
Task from the person: ${input.task}

Rules:
- Start from the product's docs. Try ${input.targetUrl.replace(/\/$/, '')}/llms.txt first.
- Every HTTP request you make must send the header "${RUN_HEADER}: ${input.runId}".
- Stay on ${new URL(input.targetUrl).hostname} and its subdomains.
- Use test mode and test data only. Never use a real card, a real person's data or a real secret.
- Stop when the task is done or you are blocked.
- Your last line must be JSON only: {"success": true or false, "summary": "one sentence"}`

/** Claude Code with curl as its only way to reach the network, in an empty folder. */
const runClaude = async (input: RunInput): Promise<RunOutcome> => {
  const binary = findClaude(input.env)
  if (!binary) throw new Error('Claude Code is not installed on this server.')
  const cwd = mkdtempSync(join(tmpdir(), 'agentrail-run-'))
  try {
    const { text } = await runClaudeCode(brief(input), 'You are an AI agent completing a task for a person. Report honestly whether you succeeded.', {
      binary,
      tools: ['Bash'],
      allowedTools: ['Bash(curl *)'],
      cwd,
      timeoutMs: input.timeoutMs,
    })
    const selfReport = parseFinal(text)
    return { transcript: text, ...(selfReport ? { selfReport } : {}) }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

type Step = { action: 'http'; method?: string; url: string; headers?: Record<string, string>; body?: string } | { action: 'done'; success: boolean; summary?: string }

const parseStep = (text: string): Step | undefined => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Step
    return value.action === 'http' || value.action === 'done' ? value : undefined
  } catch {
    return undefined
  }
}

const sameSite = (target: URL, url: URL) => {
  const base = target.hostname.split('.').slice(-2).join('.')
  return url.hostname === target.hostname || url.hostname === base || url.hostname.endsWith(`.${base}`)
}

/**
 * The loop for an API model. One tool, HTTP, spoken as JSON in plain text, so the same loop works on
 * every provider without each one's tool-calling format. The loop adds the run header itself, so a
 * model that forgets it is still measured.
 */
export const runApiAgent = async (input: RunInput, chat: Chat, maxSteps = 20): Promise<RunOutcome> => {
  const target = new URL(input.targetUrl)
  const fetcher = input.fetcher ?? fetch
  const system = `${brief(input)}

You act by replying with exactly one JSON object and nothing else:
{"action": "http", "method": "GET", "url": "https://...", "headers": {}, "body": "..."}
or, when finished:
{"action": "done", "success": true, "summary": "..."}
You will get the response status, headers and body back.`
  const messages: ChatMessage[] = [{ role: 'user', content: 'Begin.' }]
  const log: string[] = []
  for (let i = 0; i < maxSteps; i++) {
    const reply = await chat({ system, messages, maxTokens: 2000 })
    messages.push({ role: 'assistant', content: reply })
    const step = parseStep(reply)
    if (!step) {
      messages.push({ role: 'user', content: 'Reply with one JSON object as described.' })
      continue
    }
    if (step.action === 'done') {
      log.push(`done: ${step.success ? 'success' : 'failure'} ${step.summary ?? ''}`)
      return { transcript: log.join('\n'), selfReport: { success: step.success, ...(step.summary ? { summary: step.summary } : {}) } }
    }
    let url: URL
    try {
      url = new URL(step.url, target)
    } catch {
      messages.push({ role: 'user', content: `Not a URL: ${step.url}` })
      continue
    }
    if (!sameSite(target, url) || !/^https?:$/.test(url.protocol)) {
      messages.push({ role: 'user', content: `Refused: ${url.hostname} is outside the product being tested.` })
      continue
    }
    const method = (step.method ?? 'GET').toUpperCase()
    try {
      const res = await fetcher(url, {
        method,
        headers: { 'user-agent': `agentrail-runner (${input.agent})`, ...(step.headers ?? {}), [RUN_HEADER]: input.runId },
        ...(step.body && method !== 'GET' && method !== 'HEAD' ? { body: step.body } : {}),
      })
      const body = (await res.text()).slice(0, 6000)
      log.push(`${method} ${url.pathname} ${res.status}`)
      messages.push({ role: 'user', content: `HTTP ${res.status}\ncontent-type: ${res.headers.get('content-type') ?? ''}\n\n${body}` })
    } catch (error) {
      log.push(`${method} ${url.pathname} failed`)
      messages.push({ role: 'user', content: `Request failed: ${(error as Error).message}` })
    }
  }
  return { transcript: [...log, 'stopped: step limit'].join('\n'), selfReport: { success: false, summary: 'Ran out of steps.' } }
}

export const runAgent = (input: RunInput): Promise<RunOutcome> => {
  if (input.agent === 'claude-code') return runClaude(input)
  if (input.agent.startsWith('api:')) {
    const provider = input.agent.slice(4) as 'anthropic' | 'openai' | 'gemini'
    return runApiAgent(input, chatFor(provider, input.settings.llm, input.env))
  }
  return Promise.reject(new Error(`Unknown agent ${input.agent}`))
}
