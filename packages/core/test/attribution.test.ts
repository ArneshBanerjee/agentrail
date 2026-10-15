import { expect, test } from 'vitest'
import { attribute, strongest } from '../src/attribution.ts'

test('a verified signature names the operator and beats the user agent', () => {
  const a = attribute({ verifiedOperator: 'chatgpt.com', userAgent: 'Mozilla/5.0 Chrome/140' })
  expect(a).toMatchObject({ agentId: 'chatgpt', label: 'verified' })
  expect(a?.evidence).toContain('chatgpt.com')
})

test('a verified operator with no rule is still named, by its host', () => {
  expect(attribute({ verifiedOperator: 'agent.example.org' })).toMatchObject({
    agentId: 'signed:agent.example.org',
    name: 'agent.example.org',
    label: 'verified',
  })
})

test('an MCP client name is a declaration', () => {
  expect(attribute({ mcpClient: 'Cursor' })).toMatchObject({ agentId: 'cursor', label: 'declared', surface: 'editor' })
  expect(attribute({ mcpClient: 'claude-code' })).toMatchObject({ agentId: 'claude-code', surface: 'terminal' })
})

test('known user agents are declarations', () => {
  expect(attribute({ userAgent: 'Claude-User (claude-code/2.1.83; +https://support.anthropic.com/)' })?.label).toBe('declared')
  expect(attribute({ userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)' })).toMatchObject({ agentId: 'chatgpt' })
  expect(attribute({ userAgent: 'codex_cli_rs/0.46.0 (Mac OS 15.0; arm64)' })).toMatchObject({ agentId: 'codex' })
})

test('crawlers are named but kept apart from agents', () => {
  expect(attribute({ userAgent: 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)' })).toMatchObject({ kind: 'crawler' })
})

test('behaviour gives inferred and an Unnamed name, never a guess', () => {
  expect(attribute({ path: '/llms.txt', userAgent: 'Mozilla/5.0' })).toMatchObject({ name: 'Unnamed', label: 'inferred' })
  expect(attribute({ accept: 'text/markdown, text/html;q=0.5', userAgent: 'Mozilla/5.0' })).toMatchObject({ agentId: 'unnamed:markdown-reader' })
  expect(attribute({ userAgent: 'python-requests/2.32.3' })).toMatchObject({ agentId: 'unnamed:client-python-requests' })
  expect(attribute({})).toMatchObject({ agentId: 'unnamed:no-user-agent' })
})

test('a person in a browser is not an agent', () => {
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  expect(attribute({ userAgent: chrome, path: '/docs', accept: 'text/html' })).toBeUndefined()
})

test('a session takes its strongest name, and the specific one among equals', () => {
  const webfetch = attribute({ userAgent: 'Claude-User' })
  const mcp = attribute({ mcpClient: 'claude-code' })
  const inferred = attribute({ path: '/llms.txt' })
  expect(strongest([inferred, webfetch, mcp])?.agentId).toBe('claude-code')
  expect(strongest([inferred, undefined])?.label).toBe('inferred')
  expect(strongest([attribute({ verifiedOperator: 'claude.ai' }), mcp])?.label).toBe('verified')
})
