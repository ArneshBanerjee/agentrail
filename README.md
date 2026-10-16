# Agentrail

Open-source analytics for the agent customer journey.

AI agents such as Claude Code, Codex and Cursor now read docs, install packages, sign up and pay
for products on behalf of people. Normal analytics do not see them, because agents do not run page
scripts. Agentrail records them on your server and shows you:

- which agents arrive, live, and how each one found you;
- the task each agent was given, in the person's own words;
- every step of each journey, and the step where it stopped;
- conversion and revenue by agent, by intent and by page;
- ranked fixes for what blocks agents, drafted for you, live after one click;
- the change in conversion after a fix, tested on real agents first.

It is free, MIT licensed and self-hosted. Sensitive values are removed before anything is stored.

## It works with plain agents

Nothing is installed in the agent. A person types a normal task into plain Claude Code, and the
journey appears in the dashboard with the agent's name, its task and every step. This was tested end
to end with Claude Code 2.1.299 against the example product in [`examples/ledgerly`](examples/ledgerly):

1. Claude Code read `llms.txt`, sent its task to the docs finder, and named itself.
2. It read the docs, registered, ran a device sign-in and polled until it was approved.
3. It copied the wrong auth header from the API keys guide and got a 401.
4. Agentrail ranked that as the top fix. Claude Code, running headless with no API key, drafted the
   corrected page. One click on Confirm served it to agents.
5. The next plain Claude Code run read the corrected page and made its first API call without a 401.

## Quick start

Node.js 22.18 or newer.

```bash
git clone https://github.com/ArneshBanerjee/agentrail.git
cd agentrail
npm install
npm run build
npm run seed
npm start
```

Open http://localhost:4318. `npm run seed` adds a demo workspace with a month of agent traffic, so
the dashboard has something to show before your own agents arrive.

To develop with hot reload, run `npm run dev` and open http://localhost:5173.

## Connect your product

Agents do not run page scripts, so Agentrail collects on your server. Add a collector where agents
arrive: your docs, your API, your MCP server. Requests from people are dropped inside the SDK and
never leave your server.

```bash
npm install @agentrail/sdk
```

```ts
import express from 'express'
import { Agentrail } from '@agentrail/sdk'

const agentrail = new Agentrail({ key: 'ar_...', endpoint: 'http://localhost:4318', applyFixes: true })
const app = express()
app.use(agentrail.node())
```

The SDK also has `handler()` for fetch-style servers (Hono, Next.js, Bun, Deno), `worker()` for
Cloudflare Workers and `hono()` middleware. The Setup page in the dashboard shows each one with your
key filled in.

### Let agents tell you their task

The SDK serves a docs finder at `/api/docs/find`. An agent sends what it is trying to do and gets
back the pages that answer it. Agents use it because it is useful, and the query they send is their
task. Point agents at it from your `llms.txt`:

```ts
import { llmsTxtAgentNote, llmsTxtLine } from '@agentrail/sdk'

const llmsTxt = `# Your product

${llmsTxtAgentNote('https://docs.example.com')}

${llmsTxtLine('https://docs.example.com')}

- [Quickstart](/docs/quickstart): ...
`
```

The note also asks agents to name themselves in their User-Agent. An agent that does is labelled
`declared`. When an agent states no task, Agentrail infers one from the docs it read, and marks it as
inferred, so intent numbers only count what agents said.

### Steps from plain HTTP

Most funnel steps are seen in plain HTTP, with no code in your product: a package download is
Installed, a device sign-in that succeeds is Signed in, the first call to a versioned API is First
API call. For anything else, call `track()`:

```ts
agentrail.track('installed', { sessionHint: cliSessionId })
agentrail.identify(account.id, { sessionHint: cliSessionId })
agentrail.payment({ accountId: account.id, amount: 4900, currency: 'usd' })
```

### Other collectors

| Collector | Use |
|---|---|
| `@agentrail/sdk/mcp` | Wrap an MCP server: connects, tool calls, tool errors and the client name |
| `/v1/drains/vercel/<key>` | Vercel log drain |
| `/v1/drains/cloudflare/<key>` | Cloudflare Logpush |
| `npx -p @agentrail/sdk agentrail import-log access.log --key ...` | nginx or Apache logs |
| `/v1/stripe/<key>` | Stripe webhook for `charge.succeeded` and `charge.failed` |

## Who is who

Every agent name carries a label that says how sure it is:

- `verified`: a Web Bot Auth signature (RFC 9421) checked out against the operator's published keys.
- `declared`: the agent said who it is, in its User-Agent or its MCP client name.
- `inferred`: nothing named it, but it behaves like an agent. It is grouped as Unnamed, never guessed.

The agent rules are data in [`packages/core/src/agents.ts`](packages/core/src/agents.ts).

## Models

Drafting fixes, naming intents and test runs use one of four providers. Choose one in Settings.

| Provider | Needs |
|---|---|
| Claude Code | A signed-in `claude` CLI on the server machine. No API key. It runs headless in the background with your Claude plan |
| Anthropic API | `ANTHROPIC_API_KEY`, or a key in Settings |
| OpenAI API | `OPENAI_API_KEY`, or a base URL for an OpenAI-compatible server such as Ollama |
| Gemini API | `GEMINI_API_KEY`, or a key in Settings |

Claude Code is used by default when it is installed and no key is set. Without any provider,
everything works except the drafted change: fixes still show the problem and a rule-based change
where one exists.

## Fixes

Agentrail groups what stopped agents (failed calls, missing pages, HTML served to a markdown reader,
MCP tool errors, sign-ins nobody approved, declined payments) and ranks them by the revenue they
put at risk. The top fixes are drafted in the background, so a fix is usually ready when you open it.

Confirm publishes it:

- A corrected page is served to agents at once by any collector with `applyFixes: true`. People
  still see your page until the change lands in your docs.
- With a GitHub repository and token in Settings, a pull request carries the change to your docs.
- A missing page becomes a redirect that the collector serves.

Each fix can be tested on real agents first, before and after, against a preview URL. A run passes
when your own collector sees it get past the step that was failing.

## Privacy

- Requests from people are dropped inside the SDK.
- Addresses, account ids and session hints are stored as keyed hashes.
- Paths, queries, tasks, searches and errors pass through redaction before they are stored. Emails,
  phone numbers, cards (Luhn), Aadhaar (Verhoeff), PAN, SSN, IBAN, IP addresses and API keys become
  tokens such as `[EMAIL_1]`.
- Names and street addresses are not detected.

## Self-hosting

```bash
docker build -t agentrail .
docker run -p 4318:4318 -v agentrail-data:/data -e AGENTRAIL_ADMIN_TOKEN=change-me agentrail
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4318` | Port to listen on |
| `AGENTRAIL_DATA_DIR` | `./data` | Where the SQLite file and the hashing secret live |
| `AGENTRAIL_ADMIN_TOKEN` | unset | Protects the dashboard. Unset means open: use it only on a machine of your own |
| `AGENTRAIL_PUBLIC_URL` | `http://localhost:<port>` | The address collectors send to |
| `AGENTRAIL_WEB_BOT_AUTH` | on | `off` stops fetching agents' key directories |
| `AGENTRAIL_CLAUDE_BIN` | `claude` | The Claude Code binary |

The Docker image has no Claude Code in it. To use Claude Code as the model, run the server on a
machine where `claude` is installed and signed in, or use an API key.

## Example product

[`examples/ledgerly`](examples/ledgerly/server.ts) is a small fake billing API with docs, a device
sign-in and the wrong auth header on purpose. To watch a plain agent's journey:

```bash
npm start                                   # Agentrail on :4318
AGENTRAIL_KEY=ar_... npm run example        # Ledgerly on :4400, with a key from Settings
```

Then ask any coding agent: "set up usage-based billing for my API with Ledgerly, its docs are at
http://localhost:4400".

## Development

```bash
npm run check    # typecheck and all tests
npm run dev      # server and dashboard with reload
npm run build    # core and SDK to dist, and the dashboard
```

The plan is in [`docs/PLAN.md`](docs/PLAN.md), and the parity check against the public product demo
is in [`docs/PARITY.md`](docs/PARITY.md).

## Limits

- The packages are not on npm yet. `npm run build` and `npm pack` produce publishable packages.
- The Docker image is 587 MB, because it still carries the build tools. It was built and run on
  2026-10-16: the dashboard, the admin token and the data volume all worked.
- On `localhost`, every client has the same address, so separate agents can join one session. Use a
  short session gap in Settings when you test locally.
- Agents that run as a normal browser (ChatGPT Atlas, Comet) look like people, and are not counted.

## Credits

The privacy layer follows the design of Blindfold, a privacy-first browser agent built for Smart
India Hackathon 2026. The feature set follows the public description of Scope (tryscope.com). The
name, code, text and design here are our own.

## License

MIT
