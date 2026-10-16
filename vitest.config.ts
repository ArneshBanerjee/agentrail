import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Inside the repo every package runs from source. Published installs get `dist`.
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'], externalConditions: ['source'] } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
  },
})
