import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { OpenScope } from './index.ts'

export type InstrumentOptions = {
  /**
   * Add a `declare_task` tool that agents can call with the task they were given. Its description
   * asks them to leave out personal data, and the server redacts what arrives anyway.
   */
  readonly declareTaskTool?: boolean
  /** Links a tool call to an account, for example from the authenticated token. */
  readonly accountOf?: (extra: { authInfo?: { clientId?: string } | undefined; sessionId?: string | undefined }) => string | undefined
}

type Extra = { sessionId?: string; authInfo?: { clientId?: string } }
type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] }

/**
 * Record what agents do on an MCP server: which client connected, which tools it called, and which
 * calls failed. MCP is often the first place an agent meets a product, and a failing tool is a
 * blocker like a failing API call.
 *
 * Wraps the server in place and returns it, so it drops into existing code:
 * `const server = instrument(new McpServer(...), openscope)`.
 */
export const instrument = <S extends McpServer>(server: S, openscope: OpenScope, options: InstrumentOptions = {}): S => {
  // stdio has no session id. One server instance serves one client, so the instance is the session.
  const instanceHint = `mcp-${crypto.randomUUID()}`
  const client = () => server.server.getClientVersion()
  const hintOf = (extra?: Extra) => extra?.sessionId ?? instanceHint
  const actor = (extra?: Extra) => {
    const account = options.accountOf?.(extra ?? {})
    const c = client()
    return {
      sessionHint: hintOf(extra),
      ...(account ? { accountId: account } : {}),
      ...(c?.name ? { mcpClient: c.name } : {}),
      ...(c?.version ? { mcpClientVersion: c.version } : {}),
    }
  }

  const previous = server.server.oninitialized
  server.server.oninitialized = () => {
    openscope.record({ kind: 'mcp_connect', source: 'mcp', ...actor() })
    previous?.()
  }

  const wrap = (name: string, callback: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      const extra = args.at(-1) as Extra | undefined
      try {
        const result = (await callback(...args)) as ToolResult
        const failed = result?.isError === true
        const error = failed ? result.content?.find((c) => c.type === 'text')?.text?.slice(0, 300) : undefined
        openscope.record({ kind: 'mcp_tool', source: 'mcp', tool: name, ok: !failed, ...(error ? { error } : {}), ...actor(extra) })
        return result
      } catch (e) {
        openscope.record({ kind: 'mcp_tool', source: 'mcp', tool: name, ok: false, error: String((e as Error)?.message ?? e).slice(0, 300), ...actor(extra) })
        throw e
      }
    }

  const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => unknown
  ;(server as { registerTool: unknown }).registerTool = (name: string, config: unknown, callback: (...args: unknown[]) => unknown) =>
    registerTool(name, config, wrap(name, callback))

  // The older `tool()` form takes the callback last, after a varying list of arguments.
  const tool = server.tool.bind(server) as (...args: unknown[]) => unknown
  ;(server as { tool: unknown }).tool = (name: string, ...rest: unknown[]) => {
    const callback = rest.at(-1)
    return typeof callback === 'function' ? tool(name, ...rest.slice(0, -1), wrap(name, callback as (...a: unknown[]) => unknown)) : tool(name, ...rest)
  }

  if (options.declareTaskTool) {
    registerTool(
      'declare_task',
      {
        description:
          'Tell this product what task you were given, in one sentence, so its makers can improve the tools and docs for agents. Leave out names, emails, keys and other personal data.',
        inputSchema: { task: z.string().max(1000) },
      },
      async ({ task }: { task: string }, extra: Extra) => {
        openscope.record({ kind: 'intent', source: 'mcp', text: task, ...actor(extra) })
        return { content: [{ type: 'text', text: 'Thank you. Continue with your task.' }] }
      },
    )
  }

  return server
}
