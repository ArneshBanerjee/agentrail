# Agentrail plan

Agentrail is a free, open-source, self-hosted platform for the agent customer journey. It shows
which AI agents visit a product, what task each agent has, the steps it takes, where it stops, and
the revenue that follows. It then prepares fixes, publishes them, and measures the change.

The feature set matches the public description of Scope (tryscope.com). The name, the design and
the text are our own. Agentrail takes its privacy design from Blindfold: sensitive values are
removed before anything is stored.

## Feature list

Each row is a feature that Scope shows in public. The last column is where Agentrail builds it.

| # | Feature | Scope shows | Agentrail |
|---|---|---|---|
| F1 | See the moment agents visit | "4 live", arrivals feed | Live arrivals over SSE, in the Overview and Arrivals pages |
| F2 | Name each agent, with evidence | Verified, declared, inferred labels | `core/attribution`: Web Bot Auth signature (verified), user agent or header (declared), behaviour (inferred) |
| F3 | Split an agent by where it runs | Terminal, editor, text | `surface` field on each agent rule |
| F4 | How the agent found you | Via llms.txt, search result, docs search, comparison page, sitemap | Referrer and first-path rules in `core/attribution` |
| F5 | What the agent searched for | Docs search queries, pages opened and skipped | `search` events from the SDK and from query strings |
| F6 | The task in the person's own words | Intents with quotes | `intent` events from the SDK, the MCP wrapper and an intake endpoint |
| F7 | Group tasks into intents | Subscriptions, Checkout, Refunds | `core/intents`: keyword clustering, with optional LLM labels |
| F8 | Follow every step | Docs read, installed, signed in, first API call, MCP connected | `core/journey`: sessionise events into one journey per agent session |
| F9 | Mark the moment it broke | BLOCKED, STOPPED AT, failed calls | `core/journey` blocker detection |
| F10 | Funnel by agent | Discovered to second payment | `core/funnel` with steps that each workspace can set |
| F11 | Track purchases, installs and setup | Installed, signed in, payment | SDK `track()`, Stripe webhook, package-install hook |
| F12 | Revenue by agent, intent and page | Revenue table | `core/revenue`: attribute payments to sessions |
| F13 | Cost of each drop-off | "$6,940 a month at risk" | `core/fixes` ranking: sessions lost x conversion past the step x revenue per conversion |
| F14 | Fixes prepared for you | Diff of a docs change | `core/fixes` detectors, plus an LLM draft of the change (your own key) |
| F15 | Publish a fix with a click | Confirm button | GitHub pull request through your token |
| F16 | Test a fix on real agents before release | 48 runs, before and after | `runner`: run headless agent CLIs on a preview URL, N times each |
| F17 | Watch the change improve conversion | Funnel moves after a fix | Before and after comparison on each published fix |
| F18 | Data from docs, API and MCP server | One journey across all three | Middleware, log drains and MCP wrapper all write the same event shape |
| F19 | Workspaces | Sample workspace | Workspaces, sites and ingest keys |
| F20 | Agents that never run scripts | "Your analytics miss their visits" | Server-side collection only. Nothing depends on page JavaScript |

Agentrail adds one feature that Scope does not claim:

| F21 | Privacy by default | not stated | Paths, queries, intents and headers pass through `core/redact` before they are stored. IPs are kept only as a keyed hash |

## How data gets in

All collectors produce the same `AgentEvent` (see `packages/core/src/events.ts`).

1. **HTTP middleware** (`@agentrail/sdk`). Node `http`, Express, Hono, Next.js middleware and
   Cloudflare Workers. It records each request: method, path, status, user agent, signature
   headers, referrer, accept type and timing. It sends batches to the server and never blocks the
   response.
2. **Track API** (`@agentrail/sdk`). `track('signed_in')`, `identify(accountId)`, `intent(text)` and
   `search(query)` for steps that only the product knows about.
3. **MCP wrapper** (`@agentrail/sdk/mcp`). Wraps a server from `@modelcontextprotocol/sdk`. It
   records connect, tool calls, tool errors and the client name, and it reads an intent from the
   tool arguments when the client sends one.
4. **Log drains** (`server`). Vercel log drain and Cloudflare Logpush endpoints, and an nginx or
   Apache combined log import from the CLI.
5. **Stripe webhook** (`server`). Payments are linked to sessions through the account id from
   `identify`.
6. **Intake endpoint** (`server`). An `llms.txt` line can ask agents to declare their task. An agent
   that does so gets the `declared` intent label.

## Model providers

Three features call a language model: drafting a fix (F14), naming intent groups (F7), and the
agent runner (F16). Each one goes through one interface, `server/src/llm`, with four providers:

| Provider | Needs | How it runs |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | Messages API, Claude Opus 5.5 by default, with server-side fallback on a refusal |
| OpenAI | `OPENAI_API_KEY` | Chat Completions API. Also works with any OpenAI-compatible endpoint, such as a local Ollama |
| Gemini | `GEMINI_API_KEY` | `generateContent` API |
| Claude Code | A signed-in `claude` CLI on the server machine. No API key | `claude -p` runs headless in the background as a child process, with JSON output. It uses the person's existing Claude plan |

Claude Code is the default when the `claude` binary is found and no key is set, because many people
have a Claude plan but no API budget. The agent runner can also drive Claude Code (and Codex or
Gemini CLI if installed) as the agent under test, so "test the fix on real agents" works without
any API key.

Each API provider uses its official SDK. Claude Code is one child process: `claude -p --output-format
json`, with no saved session, no MCP servers from the machine, and `--permission-mode dontAsk`, so a
tool that is not allowed is refused instead of waiting for a person.

Without any provider, every feature still works except the LLM draft: fixes show the detected
problem and a rule-based change where one exists, and intents use keyword groups.

## Attribution rules

- **Verified.** The request carries a valid Web Bot Auth signature (RFC 9421 HTTP Message
  Signatures, `Signature-Agent` header, key directory at
  `/.well-known/http-message-signature-directory`). The key directory host names the operator.
- **Declared.** The user agent or a header names the agent. For example `Claude-User`,
  `ChatGPT-User`, `claude-cli`, an MCP client name.
- **Inferred.** No name, but the behaviour matches a family: it asks for markdown, reads `llms.txt`
  first, runs no scripts, sends no cookies, has a fixed request rhythm. An agent that cannot be named
  is grouped by behaviour as "Unnamed", never guessed.

The rules live in one data file, so contributors can add agents without code changes.

## Architecture

```
packages/core     pure TypeScript. No I/O, no clock, no randomness. Events, attribution,
                  redaction, sessions, journeys, funnels, intents, revenue, fix ranking.
packages/server   Hono API on Node, SQLite through node:sqlite. Ingest, drains, webhooks,
                  dashboard API, SSE, fix drafting, GitHub publish, agent runner.
packages/sdk      collectors: middleware, track API, MCP wrapper. Small, no heavy dependencies.
packages/web      Vite and React dashboard. Built into static files that the server serves.
```

One Docker image runs the server and serves the dashboard. Data is one SQLite file.

The rule that `core/` is pure comes from Blindfold. It keeps every number testable without a
database or a network.

## Dashboard pages

| Page | Content |
|---|---|
| Overview | Agent sessions and live count, conversion, main intent, biggest fix, funnel by agent, top intents, fix list |
| Arrivals | Live feed: agent, surface, how it found you, label, time |
| Agents | Each agent with its label, evidence, sessions by surface |
| Journeys | Session list with filters. One session as a timeline with the blocker marked |
| Intents | Intent groups with quotes and conversion |
| Revenue | Revenue by agent, by intent, by page |
| Fixes | Ranked fixes, each with its sessions, the diff, test runs, publish button, before and after |
| Settings | Workspace, sites, ingest keys, funnel steps, integrations (GitHub, Stripe, LLM key) |

## Dependencies

Each one has a reason. Nothing else is added without a reason in this table.

| Package | Where | Reason |
|---|---|---|
| `typescript`, `vitest` | all | Types and tests |
| `zod` | core | Event contracts, as in Blindfold |
| `hono`, `@hono/node-server` | server | Small HTTP framework that also runs in Workers |
| `react`, `react-dom`, `vite`, `@vitejs/plugin-react` | web | Dashboard |
| `@modelcontextprotocol/sdk` | sdk (peer) | The MCP wrapper wraps this package |
| `@anthropic-ai/sdk` | server | Anthropic provider. The official SDK, so typed errors and new API fields come with updates |
| `openai` | server | OpenAI provider, and any OpenAI-compatible server such as Ollama |
| `@google/genai` | server | Gemini provider |

Built-in instead of a package: SQLite (`node:sqlite`), Ed25519 and HMAC (`node:crypto`), HTTP client
(`fetch`). Node 22.5 or newer is required.

## Milestones

Each milestone ends with green tests and one or more commits. Each is usable on its own.

| M | Content | Done when |
|---|---|---|
| M0 | Repo, license (MIT), README, contributor rules, CI | `npm run check` passes in CI |
| M1 | `core`: event contract, agent rules, attribution, redaction | Tests for each label and each detector |
| M2 | `core`: sessions, journeys, blockers, funnels | A fixture log becomes the expected journeys and funnel |
| M3 | `server`: ingest, storage, dashboard API, SSE | Events in through HTTP, funnel out through HTTP |
| M4 | `sdk`: middleware for Node, Express, Hono, Next.js, Workers; track API | An example app sends events that show up in M3 |
| M5 | `web`: Overview, Arrivals, Agents, Journeys | Dashboard renders seeded data |
| M6 | Intents: capture, grouping, page | Seeded intents group as expected |
| M7 | Revenue: Stripe webhook, attribution, page | A test webhook moves revenue numbers |
| M8 | MCP wrapper | An example MCP server records connect and tool calls |
| M9 | Log drains: Vercel, Cloudflare, nginx import | Each fixture log imports to the same journeys |
| M10 | Web Bot Auth verification | A signed test request gets the verified label |
| M11 | Model providers: Anthropic, OpenAI, Gemini, Claude Code CLI | Each provider passes a contract test with a stubbed transport; Claude Code runs headless |
| M12 | Fixes: detectors, ranking, LLM draft, GitHub publish | A seeded blocker produces a ranked fix and a pull request body |
| M13 | Agent runner: before and after on N runs, through Claude Code or an API key | A run against the example app records results |
| M14 | Demo seed, Docker image, docs, first release | `docker run` shows a full demo workspace |
| M15 | Parity audit | Each row of the feature list is checked against the running product, and gaps are fixed or listed |

## What is not known

- Scope does not say how it collects data or how it gets the task text. Agentrail uses the
  collectors above. The intent text is only as good as what agents send.
- Codex and Cursor do not publish a user agent. They are labelled from MCP client names, Web Bot Auth
  if they adopt it, or behaviour.
- The LLM draft and the agent runner need an API key or a signed-in Claude Code. Without either,
  fixes still show the detected problem and a rule-based change where one exists.
- "1:1" means every feature in the list above. The name, logo, text and visual design are our own.
