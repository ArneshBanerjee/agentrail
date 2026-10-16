#!/usr/bin/env node
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { isAgentTraffic, parseCombinedLine, type IncomingEvent } from '@openscope/core'

const usage = `Usage: openscope import-log <access.log> --key <ingest key> [--endpoint http://localhost:4318] [--host docs.example.com]

Reads an nginx or Apache combined log, keeps only agent traffic, and sends it to OpenScope.
Lines from people are dropped here and never leave this machine.`

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { key: { type: 'string' }, endpoint: { type: 'string', default: 'http://localhost:4318' }, host: { type: 'string' }, help: { type: 'boolean' } },
  })
  const [command, file] = positionals
  if (values.help || command !== 'import-log' || !file || !values.key) {
    console.log(usage)
    process.exit(values.help ? 0 : 1)
  }
  const url = `${values.endpoint!.replace(/\/$/, '')}/v1/events`
  let lines = 0
  let agents = 0
  let stored = 0
  let batch: IncomingEvent[] = []
  const send = async () => {
    if (batch.length === 0) return
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-openscope-key': values.key! }, body: JSON.stringify({ events: batch }) })
    if (!res.ok) throw new Error(`OpenScope answered ${res.status}: ${await res.text()}`)
    stored += ((await res.json()) as { stored: number }).stored
    batch = []
  }
  for await (const line of createInterface({ input: createReadStream(file) })) {
    lines++
    const event = parseCombinedLine(line, values.host)
    if (!event || !isAgentTraffic(event)) continue
    agents++
    batch.push(event)
    if (batch.length === 500) await send()
  }
  await send()
  console.log(`${lines} lines read, ${agents} from agents, ${stored} new events stored.`)
}

main().catch((error: unknown) => {
  console.error((error as Error).message)
  process.exit(1)
})
