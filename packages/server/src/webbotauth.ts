import type { Verifier } from './ingest.ts'

/** Web Bot Auth verification. Filled in by M10; until then nothing is labelled verified. */
export const verifier = (): Verifier => async () => undefined
