# Agentrail: rules for contributors and coding agents

Agentrail shows how AI agents use a product: who arrives, what task they have, where they stop, and
what to fix. The full plan is in `docs/PLAN.md`.

## Commands

```
npm start       # build the dashboard and run the server on :4318
npm run check   # typecheck and all tests. Must pass before every pull request.
npm run dev     # server on :4318 and dashboard on :5173, with hot reload
npm run seed    # fill a demo workspace with sample data
npm run pack    # build the SDK packages into packages-dist/
```

## Rules

1. **`packages/core` is pure.** No `node:` imports, no network, no clock, no randomness. Time and ids
   are passed in. Every number on the dashboard comes from code that a unit test can run.
2. **Redact before storing.** Every collector sends events through `core/redact` on the server
   before they reach the database. There is no second write path.
3. **Every agent name carries a label.** `verified`, `declared` or `inferred`. Never guess a name.
4. **Agent rules are data.** New agents go in `packages/core/src/agents.ts`, not in code paths.
5. **No new dependency without a reason** in the table in `docs/PLAN.md`.
6. **Comments say why, not what.**
