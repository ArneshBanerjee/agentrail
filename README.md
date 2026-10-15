# Agentrail

Open-source analytics for the agent customer journey.

AI agents such as Claude Code, Codex and Cursor now read docs, install packages, sign up and pay
for products on behalf of people. Normal analytics do not see them, because agents do not run page
scripts. Agentrail records them on the server side and shows:

- which agents arrive, and how each one found you;
- the task each agent was given, in the person's own words;
- every step of each journey, and the step where it stopped;
- conversion and revenue by agent, by intent and by page;
- ranked fixes for what blocks agents, ready to review and publish;
- the change in conversion after a fix, tested on real agents first.

It is free, MIT licensed and self-hosted. Sensitive values are removed before anything is stored.

> Status: under active development. The plan is in [`docs/PLAN.md`](docs/PLAN.md).

## Requirements

Node.js 22.18 or newer.

## Development

```bash
npm install
npm run check
```

## Credits

The privacy layer follows the design of Blindfold, a privacy-first browser agent built for Smart
India Hackathon 2026.

## License

MIT
