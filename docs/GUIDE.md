# Agentrail guide

The details behind the [README](../README.md).

## Collectors

The SDK runs inside your product and sends agent traffic to Agentrail. Requests from people are
dropped inside the SDK and never leave your server.

| Your server | Code |
|---|---|
| Express or Node `http` | `app.use(agentrail.node())` |
| Hono | `app.use(agentrail.hono())` |
| Next.js, Bun, Deno | `export default agentrail.handler(yourHandler)` |
| Cloudflare Workers | `export default { fetch: agentrail.worker(yourHandler) }` |
| MCP server | `instrument(new McpServer(...), agentrail)` from `@agentrail/sdk/mcp` |

The Setup page in the dashboard shows each one with your ingest key filled in.

Without code changes, you can also send logs:

| Source | Address or command |
|---|---|
| Vercel log drain | `/v1/drains/vercel/<ingest key>` |
| Cloudflare Logpush | `/v1/drains/cloudflare/<ingest key>` |
| nginx or Apache logs | `npx -p @agentrail/sdk agentrail import-log access.log --key <ingest key>` |
| Stripe payments | Webhook to `/v1/stripe/<ingest key>` for `charge.succeeded` and `charge.failed` |

## The docs finder

The SDK serves a docs finder at `/api/docs/find`. An agent sends what it is trying to do and gets
back the pages that answer it. The query it sends is its task, which is how Agentrail learns what
plain agents want. Add two lines to your `llms.txt`:

```ts
import { llmsTxtAgentNote, llmsTxtLine } from '@agentrail/sdk'

const llmsTxt = `# Your product

${llmsTxtAgentNote('https://docs.example.com')}

${llmsTxtLine('https://docs.example.com')}

- [Quickstart](/docs/quickstart): ...`
```

The finder reads its pages from your `llms.txt`. When an agent states no task, Agentrail shows one
inferred from the docs it read, and marks it as inferred.

## Funnel steps

Most steps show up in plain HTTP: a package download is Installed, and a device sign-in that
succeeds is Signed in. For other steps, call the SDK:

```ts
agentrail.track('installed', { sessionHint: cliSessionId })
agentrail.identify(account.id, { sessionHint: cliSessionId })
agentrail.payment({ accountId: account.id, amount: 4900, currency: 'usd' })
```

You can change the funnel steps and name your intents in Settings.

## Who is who

Every agent name has a label:

- `verified`: a Web Bot Auth signature (RFC 9421) matched the operator's published keys.
- `declared`: the agent named itself, in its User-Agent or its MCP client name.
- `inferred`: nothing named it, but it is not a browser. It shows as Unnamed.

The agent rules are in [`packages/core/src/agents.ts`](../packages/core/src/agents.ts).

## Models

Fix drafts, intent names and test runs use one model. Choose it in Settings.

| Model | Needs |
|---|---|
| Claude Code | `claude` installed and signed in on the server machine. No API key |
| Anthropic | `ANTHROPIC_API_KEY`, or a key in Settings |
| OpenAI | `OPENAI_API_KEY`, or a base URL for a compatible server such as Ollama |
| Gemini | `GEMINI_API_KEY`, or a key in Settings |

With no model, fixes still show the problem and a rule-based change where one exists.

## Fixes

Agentrail groups what stopped agents and ranks it by the revenue at risk. The top fixes are drafted
in the background. Confirm publishes a fix:

- The corrected page goes to agents at once, from any collector with `applyFixes: true`. People still
  see your page until your docs change.
- With a GitHub repository and token in Settings, a pull request carries the change to your docs.
- A missing page becomes a redirect.

To test a fix on real agents first, set a preview URL in Settings and use "Run before" and "Run
after" on the fix page.

## Privacy

- Requests from people never leave your server.
- Addresses, account ids and session hints are stored as keyed hashes.
- Emails, phone numbers, cards, Aadhaar, PAN, SSN, IBAN, IP addresses and API keys become tokens
  such as `[EMAIL_1]` before anything is stored. Names and street addresses are not detected.

## Server settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4318` | Port to listen on |
| `AGENTRAIL_DATA_DIR` | `./data` | Where the database and the hashing secret live |
| `AGENTRAIL_ADMIN_TOKEN` | unset | Password for the dashboard. Set it on any shared machine |
| `AGENTRAIL_PUBLIC_URL` | `http://localhost:<port>` | The address collectors send to |
| `AGENTRAIL_WEB_BOT_AUTH` | on | `off` stops checking agent signatures |
| `AGENTRAIL_CLAUDE_BIN` | `claude` | Where the Claude Code CLI is |

The Docker image has no Claude Code in it. To use Claude Code as the model, run the server where
`claude` is installed, or use an API key.

## Development

```bash
npm run check    # typecheck and all tests
npm run dev      # server and dashboard with hot reload, on :5173
npm run pack     # build the SDK packages into packages-dist/
```

## Limits

- The SDK is not on npm yet. Use `npm run pack` and install the files it makes.
- On `localhost` every client has the same address, so two agents can join one session. Set a short
  session gap in Settings when you test locally.
- Agents that run inside a normal browser (ChatGPT Atlas, Comet) look like people and are not counted.
