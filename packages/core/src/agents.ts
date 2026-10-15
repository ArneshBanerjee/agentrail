/**
 * Who is who. This file is data so that a contributor adds an agent here and nowhere else.
 *
 * Patterns are matched against the user agent, the MCP client name a client sends in `initialize`,
 * and the host of a verified Web Bot Auth key directory. A pattern belongs here only when its
 * source is public. Where an agent publishes nothing (Codex and Cursor did not, as of 2026-10), it is
 * named from its MCP client name or not at all.
 */

export type Surface = 'terminal' | 'editor' | 'chat' | 'browser' | 'unknown'

export type AgentRule = {
  readonly id: string
  readonly name: string
  readonly operator: string
  readonly surface: Surface
  /** Crawlers index content for a model. They are counted apart and never enter a funnel. */
  readonly kind: 'agent' | 'crawler'
  readonly userAgent?: readonly RegExp[]
  /** Compared case-insensitively with the `clientInfo.name` an MCP client sends. */
  readonly mcpClients?: readonly string[]
  /** Hosts whose Web Bot Auth key directory proves the operator. */
  readonly signatureHosts?: readonly string[]
}

export const AGENTS: readonly AgentRule[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    operator: 'Anthropic',
    surface: 'terminal',
    kind: 'agent',
    userAgent: [/\bclaude-cli\//i, /\bclaude-code\//i],
    mcpClients: ['claude-code'],
  },
  {
    // Claude Code's WebFetch also sends Claude-User, so this name stays generic: the session takes
    // the more specific name when another event in it says Claude Code.
    id: 'claude',
    name: 'Claude',
    operator: 'Anthropic',
    surface: 'chat',
    kind: 'agent',
    userAgent: [/\bClaude-User\b/i],
    mcpClients: ['claude-ai', 'claude desktop'],
    signatureHosts: ['anthropic.com', 'claude.ai'],
  },
  {
    id: 'codex',
    name: 'Codex',
    operator: 'OpenAI',
    surface: 'terminal',
    kind: 'agent',
    userAgent: [/\bcodex_cli_rs\//i, /\bcodex-cli\//i],
    mcpClients: ['codex', 'codex-mcp-client'],
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    operator: 'OpenAI',
    surface: 'chat',
    kind: 'agent',
    userAgent: [/\bChatGPT-User\b/i, /\bChatGPT Agent\b/i],
    mcpClients: ['openai-mcp', 'chatgpt'],
    signatureHosts: ['chatgpt.com', 'openai.com'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    operator: 'Anysphere',
    surface: 'editor',
    kind: 'agent',
    userAgent: [/\bCursor\/\d/i],
    mcpClients: ['cursor', 'cursor-vscode'],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    operator: 'GitHub',
    surface: 'editor',
    kind: 'agent',
    userAgent: [/\bGitHub-Copilot\b/i],
    mcpClients: ['visual studio code', 'vscode', 'github-copilot'],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    operator: 'Google',
    surface: 'terminal',
    kind: 'agent',
    userAgent: [/\bGeminiCLI\//i],
    mcpClients: ['gemini-cli-mcp-client', 'gemini-cli'],
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    operator: 'Cognition',
    surface: 'editor',
    kind: 'agent',
    mcpClients: ['windsurf-client', 'windsurf'],
  },
  { id: 'cline', name: 'Cline', operator: 'Cline', surface: 'editor', kind: 'agent', mcpClients: ['cline'] },
  { id: 'zed', name: 'Zed', operator: 'Zed Industries', surface: 'editor', kind: 'agent', mcpClients: ['zed'] },
  {
    id: 'perplexity',
    name: 'Perplexity',
    operator: 'Perplexity',
    surface: 'chat',
    kind: 'agent',
    userAgent: [/\bPerplexity-User\b/i],
  },

  { id: 'gptbot', name: 'GPTBot', operator: 'OpenAI', surface: 'unknown', kind: 'crawler', userAgent: [/\bGPTBot\b/i, /\bOAI-SearchBot\b/i] },
  { id: 'claudebot', name: 'ClaudeBot', operator: 'Anthropic', surface: 'unknown', kind: 'crawler', userAgent: [/\bClaudeBot\b/i, /\bClaude-SearchBot\b/i] },
  { id: 'perplexitybot', name: 'PerplexityBot', operator: 'Perplexity', surface: 'unknown', kind: 'crawler', userAgent: [/\bPerplexityBot\b/i] },
  { id: 'ccbot', name: 'CCBot', operator: 'Common Crawl', surface: 'unknown', kind: 'crawler', userAgent: [/\bCCBot\b/i] },
  { id: 'bytespider', name: 'Bytespider', operator: 'ByteDance', surface: 'unknown', kind: 'crawler', userAgent: [/\bBytespider\b/i] },
  { id: 'amazonbot', name: 'Amazonbot', operator: 'Amazon', surface: 'unknown', kind: 'crawler', userAgent: [/\bAmazonbot\b/i] },
  { id: 'meta-agent', name: 'Meta crawler', operator: 'Meta', surface: 'unknown', kind: 'crawler', userAgent: [/\bmeta-externalagent\b/i] },
]

/**
 * Clients that a person rarely drives by hand when they read docs. Alone they are not a name, only
 * a reason to look closer, which is why a match here gives `inferred` and never `declared`.
 */
export const PROGRAMMATIC_CLIENTS: readonly { readonly pattern: RegExp; readonly name: string }[] = [
  { pattern: /\bcurl\//i, name: 'curl' },
  { pattern: /\bpython-requests\//i, name: 'python-requests' },
  { pattern: /\bpython-httpx\//i, name: 'httpx' },
  { pattern: /\baiohttp\//i, name: 'aiohttp' },
  { pattern: /\bnode-fetch\b/i, name: 'node-fetch' },
  { pattern: /^node$/i, name: 'node' },
  { pattern: /\bundici\b/i, name: 'undici' },
  { pattern: /\baxios\//i, name: 'axios' },
  { pattern: /\bGo-http-client\//i, name: 'Go' },
  { pattern: /\bokhttp\//i, name: 'okhttp' },
  { pattern: /\bHeadlessChrome\//i, name: 'headless Chrome' },
  { pattern: /\bPlaywright\b/i, name: 'Playwright' },
  { pattern: /\bPuppeteer\b/i, name: 'Puppeteer' },
]

/** Paths that exist for machines. A client that opens one is reading the site as an agent would. */
export const AGENT_PATHS: readonly string[] = [
  '/llms.txt',
  '/llms-full.txt',
  '/.well-known/mcp.json',
  '/.well-known/mcp',
  '/.well-known/ai-plugin.json',
]
