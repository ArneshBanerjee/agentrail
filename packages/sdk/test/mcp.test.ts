import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { OpenScope } from '../src/index.ts'
import { instrument } from '../src/mcp.ts'

test('connects, tool calls, tool errors and declared tasks are recorded with the client name', async () => {
  const batches: any[][] = []
  const openscope = new OpenScope({
    key: 'k',
    flushIntervalMs: 0,
    fetch: (async (_u: string, init: RequestInit) => {
      batches.push(JSON.parse(String(init.body)).events)
      return new Response('{}', { status: 202 })
    }) as typeof fetch,
  })
  const server = instrument(new McpServer({ name: 'ledgerly', version: '1.0.0' }), openscope, { declareTaskTool: true })
  server.registerTool('create_meter', { inputSchema: { event_name: z.string().optional() } }, async ({ event_name }) =>
    event_name ? { content: [{ type: 'text', text: 'ok' }] } : { isError: true, content: [{ type: 'text', text: 'missing field: event_name' }] },
  )
  server.registerTool('explode', {}, async () => {
    throw new Error('boom')
  })

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'claude-code', version: '2.1.90' })
  await client.connect(clientSide)
  await client.callTool({ name: 'declare_task', arguments: { task: 'Bill API calls by usage' } })
  await client.callTool({ name: 'create_meter', arguments: { event_name: 'api_call' } })
  await client.callTool({ name: 'create_meter', arguments: {} })
  await client.callTool({ name: 'explode', arguments: {} }).catch(() => undefined)
  await openscope.flush()

  const events = batches.flat()
  expect(events.map((e) => [e.kind, e.tool ?? e.text ?? '', e.ok ?? null])).toEqual([
    ['mcp_connect', '', null],
    ['intent', 'Bill API calls by usage', null],
    ['mcp_tool', 'create_meter', true],
    ['mcp_tool', 'create_meter', false],
    ['mcp_tool', 'explode', false],
  ])
  expect(events.every((e) => e.mcpClient === 'claude-code' && e.source === 'mcp')).toBe(true)
  expect(new Set(events.map((e) => e.sessionHint)).size).toBe(1)
  expect(events[3].error).toBe('missing field: event_name')
  expect(events[4].error).toContain('boom')
})
