import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { chatFor, defaultProvider, LlmError, providerStatus } from '../src/llm.ts'

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures/fake-claude.mjs')
const NO_CLAUDE = { AGENTRAIL_CLAUDE_BIN: '/nonexistent/claude' }

/** Captures what each SDK puts on the wire and answers with a canned body. */
const stubFetch = (body: unknown) => {
  const calls: { url: string; headers: Headers; body: any }[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const request = { system: 'Be brief.', messages: [{ role: 'user' as const, content: 'Fix the header.' }] }

test('Anthropic: Opus 5.5 by default, medium effort, server-side fallback, text blocks joined', async () => {
  const calls = stubFetch({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_details: null,
    content: [{ type: 'text', text: 'Use ' }, { type: 'text', text: 'Authorization: Bearer.' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  })
  const text = await chatFor('anthropic', {}, { ...NO_CLAUDE, ANTHROPIC_API_KEY: 'sk-ant-test' })(request)
  expect(text).toBe('Use Authorization: Bearer.')
  const [call] = calls
  expect(call!.url).toContain('/v1/messages')
  expect(call!.headers.get('x-api-key')).toBe('sk-ant-test')
  expect(call!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
  expect(call!.body).toMatchObject({ model: 'claude-opus-5-5', system: 'Be brief.', fallbacks: 'default', output_config: { effort: 'medium' } })
  expect(call!.body.thinking).toBeUndefined()
})

test('Anthropic: a refusal is an error, not an empty draft', async () => {
  stubFetch({
    id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: null, explanation: 'declined' }, content: [], usage: { input_tokens: 1, output_tokens: 0 },
  })
  await expect(chatFor('anthropic', { provider: 'anthropic', apiKey: 'k' }, NO_CLAUDE)(request)).rejects.toThrow(LlmError)
})

test('OpenAI: system message first, model from settings, compatible base URL', async () => {
  const calls = stubFetch({ id: 'c1', object: 'chat.completion', created: 1, model: 'llama3', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] })
  const chat = chatFor('openai', { provider: 'openai', model: 'llama3', baseUrl: 'http://localhost:11434/v1' }, NO_CLAUDE)
  expect(await chat(request)).toBe('done')
  expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions')
  expect(calls[0]!.body.messages[0]).toEqual({ role: 'system', content: 'Be brief.' })
  expect(calls[0]!.body.model).toBe('llama3')
})

test('Gemini: system instruction and model role mapping', async () => {
  const calls = stubFetch({ candidates: [{ content: { role: 'model', parts: [{ text: 'gemini says hi' }] }, finishReason: 'STOP' }] })
  const chat = chatFor('gemini', {}, { ...NO_CLAUDE, GEMINI_API_KEY: 'g-key' })
  const text = await chat({ system: 'Be brief.', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] })
  expect(text).toBe('gemini says hi')
  expect(calls[0]!.url).toContain('gemini-2.5-pro:generateContent')
  expect(calls[0]!.body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user'])
  expect(JSON.stringify(calls[0]!.body.systemInstruction)).toContain('Be brief.')
})

test('Claude Code: headless, isolated, no tools, prompt on stdin', async () => {
  const chat = chatFor('claude-code', {}, { AGENTRAIL_CLAUDE_BIN: FAKE_CLAUDE })
  const echoed = JSON.parse(await chat(request)) as { args: string[]; input: string }
  expect(echoed.input).toBe('Fix the header.')
  expect(echoed.args.slice(0, 3)).toEqual(['-p', '--output-format', 'json'])
  for (const flag of ['--no-session-persistence', '--strict-mcp-config']) expect(echoed.args).toContain(flag)
  expect(echoed.args[echoed.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
  expect(echoed.args[echoed.args.indexOf('--tools') + 1]).toBe('')
  expect(echoed.args).not.toContain('--bare')
  await expect(chat({ system: 's', messages: [{ role: 'user', content: 'FAIL please' }] })).rejects.toThrow('it broke')
})

test('provider status and the default choice', () => {
  const env = { AGENTRAIL_CLAUDE_BIN: FAKE_CLAUDE, OPENAI_API_KEY: 'o' }
  expect(providerStatus({}, env).map((p) => [p.id, p.ready])).toEqual([
    ['claude-code', true],
    ['anthropic', false],
    ['openai', true],
    ['gemini', false],
  ])
  expect(defaultProvider({}, env)).toBe('claude-code')
  expect(defaultProvider({ provider: 'openai' }, env)).toBe('openai')
  expect(defaultProvider({ provider: 'gemini' }, env)).toBe('claude-code')
  expect(defaultProvider({}, NO_CLAUDE)).toBeUndefined()
  expect(() => chatFor('anthropic', {}, NO_CLAUDE)).toThrow('No Anthropic API key')
})
