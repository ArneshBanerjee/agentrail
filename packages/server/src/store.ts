import { randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_CONVERSION_STEP, DEFAULT_FUNNEL, type FunnelStep, type IntentDefinition, type StoredEvent } from '@agentrail/core'

export type Workspace = { readonly id: string; readonly name: string; readonly createdAt: number }
export type Site = { readonly id: string; readonly workspaceId: string; readonly name: string; readonly host: string; readonly ingestKey: string }

export type LlmProvider = 'anthropic' | 'openai' | 'gemini' | 'claude-code' | 'none'

export type WorkspaceSettings = {
  funnel: FunnelStep[]
  conversionStep: string
  intents: IntentDefinition[]
  currency: string
  llm: { provider?: LlmProvider; model?: string; apiKey?: string; baseUrl?: string }
  github: { repo?: string; token?: string; branch?: string; docsRoot?: string }
  stripe: { webhookSecret?: string }
  runner: { targetUrl?: string; timeoutSec?: number }
  /** Names a model gave to keyword groups. Keyed by group id. */
  intentLabels: Record<string, string>
  /** Draft the top fixes in the background when a model is available. On unless set to false. */
  autoDraft?: boolean
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  funnel: [...DEFAULT_FUNNEL],
  conversionStep: DEFAULT_CONVERSION_STEP,
  intents: [],
  currency: 'usd',
  llm: {},
  github: {},
  stripe: {},
  runner: {},
  intentLabels: {},
}

export type FixStatus = 'open' | 'drafted' | 'testing' | 'published' | 'dismissed'

export type FixRecord = {
  readonly workspaceId: string
  readonly key: string
  status: FixStatus
  /** `servePath` is the URL path the SDK serves `after` at, to agents, once the fix is published. */
  draft?: { file: string; servePath?: string; title?: string; before?: string; after: string; summary: string; provider: string }
  drafting?: boolean
  draftError?: string
  prUrl?: string
  publishedAt?: number
  updatedAt: number
}

export type RunRecord = {
  readonly id: string
  readonly workspaceId: string
  readonly fixKey: string
  readonly phase: 'before' | 'after'
  readonly agent: string
  readonly task: string
  status: 'queued' | 'running' | 'done' | 'failed'
  reachedStep?: string
  converted?: boolean
  /** `collector` when the run's own traffic was measured, `self-report` when only the agent said so. */
  measuredBy?: 'collector' | 'self-report'
  output?: string
  readonly createdAt: number
  finishedAt?: number
}

/**
 * One SQLite file. Events are stored as JSON beside the columns used to query them, so a new event
 * field needs no migration.
 */
export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sites (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL,
        ingest_key TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, site_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
        run_id TEXT, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_site_ts ON events (site_id, ts);
      CREATE TABLE IF NOT EXISTS settings (workspace_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fixes (workspace_id TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (workspace_id, key));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, fix_key TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_fix ON runs (workspace_id, fix_key);
    `)
  }

  /** The first start makes one workspace and one site, so a new install has a key to paste. */
  ensureDefaults(now: number): { workspace: Workspace; site: Site; created: boolean } {
    const existing = this.workspaces()[0]
    if (existing) return { workspace: existing, site: this.sites(existing.id)[0]!, created: false }
    const workspace = this.createWorkspace('My product', now)
    const site = this.createSite(workspace.id, 'Website', 'localhost')
    return { workspace, site, created: true }
  }

  createWorkspace(name: string, now: number): Workspace {
    const w = { id: randomUUID(), name, createdAt: now }
    this.db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(w.id, w.name, w.createdAt)
    return w
  }

  workspaces(): Workspace[] {
    return this.db.prepare('SELECT id, name, created_at FROM workspaces ORDER BY created_at').all().map((r) => ({
      id: String(r.id),
      name: String(r.name),
      createdAt: Number(r.created_at),
    }))
  }

  workspace(id: string): Workspace | undefined {
    return this.workspaces().find((w) => w.id === id)
  }

  createSite(workspaceId: string, name: string, host: string): Site {
    const site = { id: randomUUID(), workspaceId, name, host, ingestKey: `ar_${randomBytes(18).toString('base64url')}` }
    this.db
      .prepare('INSERT INTO sites (id, workspace_id, name, host, ingest_key) VALUES (?, ?, ?, ?, ?)')
      .run(site.id, site.workspaceId, site.name, site.host, site.ingestKey)
    return site
  }

  private toSite = (r: Record<string, unknown>): Site => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    name: String(r.name),
    host: String(r.host),
    ingestKey: String(r.ingest_key),
  })

  sites(workspaceId: string): Site[] {
    return this.db.prepare('SELECT * FROM sites WHERE workspace_id = ? ORDER BY name').all(workspaceId).map(this.toSite)
  }

  siteByKey(key: string): Site | undefined {
    const r = this.db.prepare('SELECT * FROM sites WHERE ingest_key = ?').get(key)
    return r ? this.toSite(r) : undefined
  }

  deleteSite(workspaceId: string, siteId: string): void {
    this.db.prepare('DELETE FROM sites WHERE workspace_id = ? AND id = ?').run(workspaceId, siteId)
  }

  /** Returns how many were new. A retried batch inserts nothing twice. */
  insertEvents(events: readonly StoredEvent[]): number {
    const insert = this.db.prepare('INSERT OR IGNORE INTO events (id, site_id, ts, kind, run_id, body) VALUES (?, ?, ?, ?, ?, ?)')
    let added = 0
    this.db.exec('BEGIN')
    try {
      for (const e of events) {
        const result = insert.run(`${e.siteId}:${e.id}`, e.siteId, e.ts, e.kind, e.runId ?? null, JSON.stringify(e))
        added += Number(result.changes)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return added
  }

  events(siteIds: readonly string[], from: number, to: number): StoredEvent[] {
    if (siteIds.length === 0) return []
    const marks = siteIds.map(() => '?').join(',')
    return this.db
      .prepare(`SELECT body FROM events WHERE site_id IN (${marks}) AND ts >= ? AND ts <= ? ORDER BY ts`)
      .all(...siteIds, from, to)
      .map((r) => JSON.parse(String(r.body)) as StoredEvent)
  }

  eventCount(siteIds: readonly string[]): number {
    if (siteIds.length === 0) return 0
    const marks = siteIds.map(() => '?').join(',')
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE site_id IN (${marks})`).get(...siteIds)?.n ?? 0)
  }

  settings(workspaceId: string): WorkspaceSettings {
    const r = this.db.prepare('SELECT body FROM settings WHERE workspace_id = ?').get(workspaceId)
    if (!r) return structuredClone(DEFAULT_SETTINGS)
    return { ...structuredClone(DEFAULT_SETTINGS), ...(JSON.parse(String(r.body)) as Partial<WorkspaceSettings>) }
  }

  saveSettings(workspaceId: string, settings: WorkspaceSettings): void {
    this.db
      .prepare('INSERT INTO settings (workspace_id, body) VALUES (?, ?) ON CONFLICT (workspace_id) DO UPDATE SET body = excluded.body')
      .run(workspaceId, JSON.stringify(settings))
  }

  fix(workspaceId: string, key: string): FixRecord | undefined {
    const r = this.db.prepare('SELECT body FROM fixes WHERE workspace_id = ? AND key = ?').get(workspaceId, key)
    return r ? (JSON.parse(String(r.body)) as FixRecord) : undefined
  }

  fixes(workspaceId: string): FixRecord[] {
    return this.db
      .prepare('SELECT body FROM fixes WHERE workspace_id = ?')
      .all(workspaceId)
      .map((r) => JSON.parse(String(r.body)) as FixRecord)
  }

  saveFix(fix: FixRecord): void {
    this.db
      .prepare('INSERT INTO fixes (workspace_id, key, body) VALUES (?, ?, ?) ON CONFLICT (workspace_id, key) DO UPDATE SET body = excluded.body')
      .run(fix.workspaceId, fix.key, JSON.stringify(fix))
  }

  saveRun(run: RunRecord): void {
    this.db
      .prepare('INSERT INTO runs (id, workspace_id, fix_key, created_at, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body')
      .run(run.id, run.workspaceId, run.fixKey, run.createdAt, JSON.stringify(run))
  }

  runs(workspaceId: string, fixKey?: string): RunRecord[] {
    const rows = fixKey
      ? this.db.prepare('SELECT body FROM runs WHERE workspace_id = ? AND fix_key = ? ORDER BY created_at').all(workspaceId, fixKey)
      : this.db.prepare('SELECT body FROM runs WHERE workspace_id = ? ORDER BY created_at').all(workspaceId)
    return rows.map((r) => JSON.parse(String(r.body)) as RunRecord)
  }
}
