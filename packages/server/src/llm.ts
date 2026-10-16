import { spawn, spawnSync } from 'node:child_process'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'
import OpenAI from 'openai'
import type { LlmProvider, WorkspaceSettings } from './store.ts'

/**
 * One interface for every model OpenScope calls: drafting fixes, naming intents and the agent
 * runner. Four providers sit behind it. Claude Code is the one that needs no API key: it runs
 * headless on this machine with the plan its user is signed in with.
 */

export type ChatMessage = { readonly role: 'user' | 'assistant'; readonly content: string }

export type ChatRequest = {
  readonly system: string
  readonly messages: readonly ChatMessage[]
  readonly maxTokens?: number
  /**
   * A JSON schema the reply must follow. Each provider enforces it natively, so the reply is the
   * JSON text and nothing has to be picked out of prose.
   */
  readonly schema?: { readonly name: string; readonly schema: Record<string, unknown> }
}

export type Chat = (request: ChatRequest) => Promise<string>

export type ProviderStatus = { readonly id: Exclude<LlmProvider, 'none'>; readonly label: string; readonly ready: boolean; readonly detail: string }

export class LlmError extends Error {}

const DEFAULT_MODELS = {
  anthropic: 'claude-opus-5-5',
  // OpenAI and Gemini model names change often. These are defaults, and Settings overrides them.
  openai: 'gpt-5',
  gemini: 'gemini-2.5-pro',
} as const

export type LlmEnv = {
  readonly ANTHROPIC_API_KEY?: string | undefined
  readonly OPENAI_API_KEY?: string | undefined
  readonly OPENAI_BASE_URL?: string | undefined
  readonly GEMINI_API_KEY?: string | undefined
  readonly GOOGLE_API_KEY?: string | undefined
  readonly OPENSCOPE_CLAUDE_BIN?: string | undefined
}

/** Probed once per binary per process. A `claude` installed later is picked up on restart. */
const claudeFound = new Map<string, boolean>()
export const findClaude = (env: LlmEnv = process.env): string | undefined => {
  const candidate = env.OPENSCOPE_CLAUDE_BIN ?? 'claude'
  if (!claudeFound.has(candidate)) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 })
    claudeFound.set(candidate, probe.status === 0)
  }
  return claudeFound.get(candidate) ? candidate : undefined
}

const keyFor = (provider: LlmProvider, settings: WorkspaceSettings['llm'], env: LlmEnv): string | undefined => {
  // A key saved in Settings belongs to the provider selected there.
  if (settings.apiKey && settings.provider === provider) return settings.apiKey
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY
  if (provider === 'openai') return env.OPENAI_API_KEY
  if (provider === 'gemini') return env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY
  return undefined
}

export const providerStatus = (settings: WorkspaceSettings['llm'], env: LlmEnv = process.env): ProviderStatus[] => {
  const claude = findClaude(env)
  const openaiBase = (settings.provider === 'openai' && settings.baseUrl) || env.OPENAI_BASE_URL
  return [
    { id: 'claude-code', label: 'Claude Code', ready: !!claude, detail: claude ? 'Runs headless on this server with your Claude plan. No API key.' : 'Install Claude Code and sign in on this server.' },
    { id: 'anthropic', label: 'Anthropic API', ready: !!keyFor('anthropic', settings, env), detail: `Uses ${settings.provider === 'anthropic' && settings.model ? settings.model : DEFAULT_MODELS.anthropic}. Needs ANTHROPIC_API_KEY or a key in Settings.` },
    { id: 'openai', label: 'OpenAI API', ready: !!keyFor('openai', settings, env) || !!openaiBase, detail: `Uses ${settings.provider === 'openai' && settings.model ? settings.model : DEFAULT_MODELS.openai}. Needs OPENAI_API_KEY, or a base URL for a compatible server.` },
    { id: 'gemini', label: 'Gemini API', ready: !!keyFor('gemini', settings, env), detail: `Uses ${settings.provider === 'gemini' && settings.model ? settings.model : DEFAULT_MODELS.gemini}. Needs GEMINI_API_KEY or a key in Settings.` },
  ]
}

/** The provider to use when the caller does not name one: the one chosen in Settings, else the first that is ready. */
export const defaultProvider = (settings: WorkspaceSettings['llm'], env: LlmEnv = process.env): ProviderStatus['id'] | undefined => {
  const all = providerStatus(settings, env)
  if (settings.provider && settings.provider !== 'none') {
    const chosen = all.find((p) => p.id === settings.provider)
    if (chosen?.ready) return chosen.id
  }
  return all.find((p) => p.ready)?.id
}

const anthropicChat = (apiKey: string, model: string): Chat => {
  const client = new Anthropic({ apiKey })
  return async ({ system, messages, maxTokens, schema }) => {
    try {
      // Server-side fallback: if this model declines for policy reasons, the API retries on its
      // default fallback model inside the same call, instead of returning nothing.
      const response = await client.beta.messages.create({
        model,
        max_tokens: maxTokens ?? 16000,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: { effort: 'medium', ...(schema ? { format: { type: 'json_schema', schema: schema.schema } } : {}) },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      })
      if (response.stop_reason === 'refusal') throw new LlmError(`The model declined: ${response.stop_details?.explanation ?? 'no reason given'}`)
      return response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new LlmError('Anthropic rejected the API key.')
      if (error instanceof Anthropic.RateLimitError) throw new LlmError('Anthropic rate limit reached. Try again shortly.')
      if (error instanceof Anthropic.APIError) throw new LlmError(`Anthropic API error ${error.status}: ${error.message}`)
      throw error
    }
  }
}

const openaiChat = (apiKey: string | undefined, model: string, baseURL: string | undefined): Chat => {
  // A local OpenAI-compatible server (Ollama, LM Studio) takes any key.
  const client = new OpenAI({ apiKey: apiKey ?? 'not-needed', ...(baseURL ? { baseURL } : {}) })
  return async ({ system, messages, maxTokens, schema }) => {
    try {
      const response = await client.chat.completions.create({
        model,
        max_completion_tokens: maxTokens ?? 16000,
        ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema, strict: true } } } : {}),
        messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
      })
      return response.choices[0]?.message.content ?? ''
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) throw new LlmError('OpenAI rejected the API key.')
      if (error instanceof OpenAI.APIError) throw new LlmError(`OpenAI API error ${error.status}: ${error.message}`)
      throw error
    }
  }
}

const geminiChat = (apiKey: string, model: string): Chat => {
  const ai = new GoogleGenAI({ apiKey })
  return async ({ system, messages, maxTokens, schema }) => {
    const response = await ai.models.generateContent({
      model,
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens ?? 16000,
        ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema.schema } : {}),
      },
    })
    return response.text ?? ''
  }
}

export type ClaudeCodeOptions = {
  readonly binary: string
  readonly model?: string | undefined
  /** Built-in tools Claude Code may use. Empty for drafting: it only reads and writes text. */
  readonly tools?: readonly string[]
  /** Tool permissions granted without asking, such as `Bash(curl *)`. */
  readonly allowedTools?: readonly string[]
  /**
   * `dontAsk` (the default) refuses anything not allowed. `auto` lets Claude Code's own classifier
   * approve safe commands, which is how people run it, and what a test run should match.
   */
  readonly permissionMode?: 'dontAsk' | 'auto'
  readonly cwd?: string
  readonly timeoutMs?: number
  /** Structured output: Claude Code validates its reply against this and returns it apart. */
  readonly jsonSchema?: Record<string, unknown>
}

/** The JSON `claude -p --output-format json` prints when it finishes. */
type ClaudeResult = { readonly type?: string; readonly subtype?: string; readonly is_error?: boolean; readonly result?: string; readonly structured_output?: unknown }

/**
 * Run Claude Code headless and return its final answer.
 *
 * The prompt goes in on stdin, so a long docs page does not hit the argument length limit. Every run
 * is isolated: no session is saved, no MCP servers from the machine are loaded, and `dontAsk` means a
 * tool not on the allowed list is refused rather than waiting for a person who is not there.
 */
export const runClaudeCode = (prompt: string, system: string, o: ClaudeCodeOptions): Promise<{ text: string; raw: ClaudeResult }> =>
  new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--permission-mode',
      o.permissionMode ?? 'dontAsk',
      '--tools',
      (o.tools ?? []).join(','),
      '--append-system-prompt',
      system,
      ...(o.allowedTools && o.allowedTools.length > 0 ? ['--allowedTools', ...o.allowedTools] : []),
      ...(o.model ? ['--model', o.model] : []),
      ...(o.jsonSchema ? ['--json-schema', JSON.stringify(o.jsonSchema)] : []),
    ]
    const child = spawn(o.binary, args, { cwd: o.cwd ?? process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new LlmError(`Claude Code did not finish within ${Math.round((o.timeoutMs ?? 300_000) / 1000)} seconds.`))
    }, o.timeoutMs ?? 300_000)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new LlmError(`Could not start Claude Code: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let parsed: ClaudeResult | undefined
      try {
        parsed = JSON.parse(out.trim().split('\n').at(-1) ?? '') as ClaudeResult
      } catch {
        parsed = undefined
      }
      if (!parsed) return reject(new LlmError(`Claude Code exited with ${code}: ${(err || out).slice(0, 400)}`))
      if (parsed.is_error) return reject(new LlmError(`Claude Code reported an error: ${(parsed.result ?? parsed.subtype ?? '').slice(0, 400)}`))
      resolve({ text: o.jsonSchema && parsed.structured_output !== undefined ? JSON.stringify(parsed.structured_output) : (parsed.result ?? ''), raw: parsed })
    })
    child.stdin.end(prompt)
  })

/** A transcript for a model that takes one prompt, such as Claude Code in print mode. */
const flatten = (messages: readonly ChatMessage[]) =>
  messages.length === 1 ? messages[0]!.content : messages.map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content}`).join('\n\n')

export const chatFor = (provider: ProviderStatus['id'], settings: WorkspaceSettings['llm'], env: LlmEnv = process.env): Chat => {
  const model = settings.provider === provider ? settings.model : undefined
  switch (provider) {
    case 'anthropic': {
      const key = keyFor('anthropic', settings, env)
      if (!key) throw new LlmError('No Anthropic API key. Set ANTHROPIC_API_KEY or add one in Settings.')
      return anthropicChat(key, model || DEFAULT_MODELS.anthropic)
    }
    case 'openai': {
      const key = keyFor('openai', settings, env)
      const base = (settings.provider === 'openai' && settings.baseUrl) || env.OPENAI_BASE_URL
      if (!key && !base) throw new LlmError('No OpenAI API key. Set OPENAI_API_KEY or add one in Settings.')
      return openaiChat(key, model || DEFAULT_MODELS.openai, base || undefined)
    }
    case 'gemini': {
      const key = keyFor('gemini', settings, env)
      if (!key) throw new LlmError('No Gemini API key. Set GEMINI_API_KEY or add one in Settings.')
      return geminiChat(key, model || DEFAULT_MODELS.gemini)
    }
    case 'claude-code': {
      const binary = findClaude(env)
      if (!binary) throw new LlmError('Claude Code is not installed on this server.')
      return async ({ system, messages, schema }) =>
        (await runClaudeCode(flatten(messages), system, { binary, model, ...(schema ? { jsonSchema: schema.schema } : {}) })).text
    }
  }
}
