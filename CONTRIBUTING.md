# Contributing

Thanks for helping.

1. Fork the repo and create a branch.
2. Run `npm install`, then `npm run dev` to work with hot reload.
3. Before you open a pull request, run `npm run check`. It must pass.

Some rules, from [AGENTS.md](AGENTS.md):

- `packages/core` is pure: no network, no clock, no randomness.
- New agents go in `packages/core/src/agents.ts`.
- Keep pull requests small, and add a test for what you change.
