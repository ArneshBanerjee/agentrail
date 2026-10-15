import { AGENT_PATHS, AGENTS, PROGRAMMATIC_CLIENTS, type AgentRule, type Surface } from './agents.ts'
import { versionIn } from './steps.ts'

/**
 * How sure the name is.
 * - `verified`: a Web Bot Auth signature checked out against the operator's key directory.
 * - `declared`: the client said who it is, in its user agent or its MCP client name.
 * - `inferred`: nothing named it, but it behaves like an agent. It is grouped, never named.
 */
export type Label = 'verified' | 'declared' | 'inferred'

const LABEL_RANK: Record<Label, number> = { verified: 3, declared: 2, inferred: 1 }

export type Attribution = {
  readonly agentId: string
  readonly name: string
  readonly operator: string
  readonly surface: Surface
  readonly kind: 'agent' | 'crawler'
  readonly label: Label
  /** One sentence a person can check: the header, client name or behaviour behind the name. */
  readonly evidence: string
  /** The agent's version, when its user agent or MCP client says it. */
  readonly version?: string
}

export type Signals = {
  readonly userAgent?: string | undefined
  readonly mcpClient?: string | undefined
  readonly mcpClientVersion?: string | undefined
  readonly verifiedOperator?: string | undefined
  readonly accept?: string | undefined
  readonly path?: string | undefined
}

const fromRule = (rule: AgentRule, label: Label, evidence: string): Attribution => ({
  agentId: rule.id,
  name: rule.name,
  operator: rule.operator,
  surface: rule.surface,
  kind: rule.kind,
  label,
  evidence,
})

const hostMatches = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`)

/**
 * Name one event's client, or return `undefined` for a person in a browser.
 *
 * The order is the order of trust: a signature beats a claim, and a claim beats behaviour. A browser
 * agent that sends a normal browser user agent and runs scripts (Atlas, Comet) cannot be told from a
 * person by this function, and it does not pretend to.
 */
export const attribute = (signals: Signals, rules: readonly AgentRule[] = AGENTS): Attribution | undefined => {
  const ua = signals.userAgent ?? ''

  if (signals.verifiedOperator) {
    const host = signals.verifiedOperator.toLowerCase()
    const rule = rules.find((r) => r.signatureHosts?.some((s) => hostMatches(host, s)))
    const evidence = `Web Bot Auth signature verified against ${host}`
    if (rule) return fromRule(rule, 'verified', evidence)
    return {
      agentId: `signed:${host}`,
      name: host,
      operator: host,
      surface: 'unknown',
      kind: 'agent',
      label: 'verified',
      evidence,
    }
  }

  if (signals.mcpClient) {
    const client = signals.mcpClient.toLowerCase()
    const rule = rules.find((r) => r.mcpClients?.includes(client))
    if (rule) {
      const a = fromRule(rule, 'declared', `MCP client name "${signals.mcpClient}"`)
      return signals.mcpClientVersion ? { ...a, version: signals.mcpClientVersion } : a
    }
  }

  if (ua) {
    for (const rule of rules) {
      for (const pattern of rule.userAgent ?? []) {
        const match = pattern.exec(ua)
        if (match) {
          const token = productToken(ua, match.index)
          const version = versionIn(ua, token)
          const a = fromRule(rule, 'declared', `User agent says "${token}"`)
          return version ? { ...a, version } : a
        }
      }
    }
  }

  return infer(signals, ua)
}

/** The name in a user agent without its version, so "Cursor/1.7.38" and "Cursor/1.8.0" are one piece of evidence. */
const productToken = (ua: string, at: number) => (/^[^\s;()/]+/.exec(ua.slice(at))?.[0] ?? ua.slice(at)).replace(/[-_ ]+$/, '')

const unnamed = (fingerprint: string, evidence: string, surface: Surface = 'unknown'): Attribution => ({
  agentId: `unnamed:${fingerprint}`,
  name: 'Unnamed',
  operator: 'unknown',
  surface,
  kind: 'agent',
  label: 'inferred',
  evidence,
})

const infer = (signals: Signals, ua: string): Attribution | undefined => {
  if (signals.mcpClient) {
    return unnamed(`mcp-${signals.mcpClient.toLowerCase()}`, `Unknown MCP client "${signals.mcpClient}"`)
  }
  if (signals.path && AGENT_PATHS.includes(signals.path)) {
    return unnamed('agent-path', `Opened ${signals.path}, a file written for agents`)
  }
  if (signals.accept && /text\/markdown|text\/x-markdown/i.test(signals.accept)) {
    return unnamed('markdown-reader', 'Asked for markdown instead of HTML')
  }
  const client = PROGRAMMATIC_CLIENTS.find((c) => c.pattern.test(ua))
  if (client) return unnamed(`client-${client.name.toLowerCase().replaceAll(' ', '-')}`, `Programmatic client: ${client.name}`)
  if (!ua) return unnamed('no-user-agent', 'Sent no user agent')
  return undefined
}

/**
 * One name for a whole session. The strongest label wins, and among equal labels a specific name
 * beats a generic one: Claude-User on a WebFetch and "claude-code" on the MCP connect in the same
 * session are one Claude Code session.
 */
export const strongest = (attributions: readonly (Attribution | undefined)[]): Attribution | undefined => {
  let best: Attribution | undefined
  for (const a of attributions) {
    if (!a) continue
    if (!best) {
      best = a
      continue
    }
    const rank = LABEL_RANK[a.label] - LABEL_RANK[best.label]
    if (rank > 0) best = a
    else if (rank === 0 && best.surface === 'chat' && a.surface !== 'chat' && a.operator === best.operator) best = a
  }
  return best
}
