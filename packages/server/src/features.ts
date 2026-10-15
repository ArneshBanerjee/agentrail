import type { Hono } from 'hono'
import type { AppContext } from './app.ts'

/** Routes for collectors and features beyond the core API. Each milestone adds its own here. */
export const extend = (_app: Hono, _ctx: AppContext): void => {}
