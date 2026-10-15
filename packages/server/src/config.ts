import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type Config = {
  readonly port: number
  readonly dataDir: string
  /** Keys the address and account hashes. Generated once and kept in the data folder. */
  readonly secret: string
  /** Protects the dashboard API. Unset means open, which is only safe on a machine of your own. */
  readonly adminToken?: string
  readonly publicUrl: string
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const dataDir = resolve(env.AGENTRAIL_DATA_DIR ?? 'data')
  mkdirSync(dataDir, { recursive: true })
  const secretFile = join(dataDir, 'secret')
  let secret = env.AGENTRAIL_SECRET
  if (!secret) {
    if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 })
    secret = readFileSync(secretFile, 'utf8').trim()
  }
  const port = Number(env.PORT ?? 4318)
  return {
    port,
    dataDir,
    secret,
    ...(env.AGENTRAIL_ADMIN_TOKEN ? { adminToken: env.AGENTRAIL_ADMIN_TOKEN } : {}),
    publicUrl: env.AGENTRAIL_PUBLIC_URL ?? `http://localhost:${port}`,
  }
}
