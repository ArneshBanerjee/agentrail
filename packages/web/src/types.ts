import type { Attribution, Blocker, BreakdownRow, Discovery, FixCandidate, FunnelRow, IntentGroup, Overview, TimelineItem } from '@agentrail/core'

export type { Attribution, Blocker, BreakdownRow, FixCandidate, FunnelRow, IntentGroup, Overview, TimelineItem }

export type Site = { id: string; workspaceId: string; name: string; host: string; ingestKey: string }
export type Me = { workspaces: { id: string; name: string }[]; workspaceId: string; sites: Site[]; ingestUrl: string }

export type FixRecord = {
  key: string
  status: 'open' | 'drafted' | 'testing' | 'published' | 'dismissed'
  draft?: { file: string; servePath?: string; title?: string; before?: string; after: string; summary: string; provider: string }
  drafting?: boolean
  draftError?: string
  prUrl?: string
  publishedAt?: number
  updatedAt: number
}

export type Summary = {
  overview: Overview
  funnel: FunnelRow[]
  funnelSteps: { id: string; label: string }[]
  agents: BreakdownRow[]
  intents: IntentGroup[]
  fixes: (FixCandidate & { record?: FixRecord })[]
  pages: BreakdownRow[]
  currency: string
  window: { from: number; to: number }
}

export type SessionSummary = {
  id: string
  host?: string
  steps: number
  stage?: { id: string; label: string }
  lastStep?: { name: string; detail: string; failed: boolean }
  agent: Attribution
  startedAt: number
  endedAt: number
  durationMs: number
  live: boolean
  discovery: Discovery
  landingPath?: string
  intent?: string
  inferredIntent?: string
  intentVia?: string
  searches: string[]
  reached: string[]
  stoppedAt?: string
  stoppedBy?: Blocker
  blockers: number
  failedCalls: number
  revenue: number
  currency?: string
  payments: number
  mcpConnected: boolean
  events: number
  runId?: string
}

export type SessionDetail = Omit<SessionSummary, 'failedCalls'> & {
  stepper: { id: string; label: string; at?: number; independent: boolean }[]
  blockerList: Blocker[]
  timeline: TimelineItem[]
  gotTo?: { id: string; label: string }
  stoppedAtLabel?: string
  failedCalls: { failed: number; of: number }
}

export type AgentRow = BreakdownRow & {
  operator: string
  surface: string
  labels: Record<string, number>
  evidence: { text: string; sessions: number }[]
  discovery: BreakdownRow[]
}

export type RunRecord = {
  id: string
  fixKey: string
  phase: 'before' | 'after'
  agent: string
  task: string
  status: 'queued' | 'running' | 'done' | 'failed'
  reachedStep?: string
  converted?: boolean
  output?: string
  createdAt: number
  finishedAt?: number
}

export type Impact = {
  before: { sessions: number; converted: number; conversion: number; hitRate: number }
  after: { sessions: number; converted: number; conversion: number; hitRate: number }
  days: number
}

export type FixDetail = FixCandidate & {
  record?: FixRecord
  runs: RunRecord[]
  runSummary: { before: { runs: number; converted: number }; after: { runs: number; converted: number } }
  impact?: Impact
  sessions: SessionSummary[]
}

export type Providers = {
  available: { id: string; label: string; ready: boolean; detail: string }[]
  selected?: string
  agents: { id: string; label: string; ready: boolean; detail: string }[]
}
