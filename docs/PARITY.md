# Parity audit

Checked on 2026-10-16 against the feature list and the demo table in [`PLAN.md`](PLAN.md). Each row
says how it was checked:

- **Live**: seen working with real software (plain Claude Code 2.1.299, the dashboard in a browser,
  the example product, a packed and installed SDK).
- **Test**: covered by an automated test in `npm run check`, with stand-ins for outside services.
- **Gap**: not done, or done differently.

## The demo video

| # | The demo shows | Status | How it was checked |
|---|---|---|---|
| V1 | Plain Claude Code with an ordinary task | Live | Runs 1 to 5 against `examples/ledgerly`, Claude Code with no plugin and no system prompt change |
| V2 | "intent declared · POST /api/docs/find · via docs finder" | Live | Run 3: Claude Code sent its task to the docs finder after reading `llms.txt`. Test: `the docs finder answers from llms.txt` |
| V3 | Sessions page, Live list with agent, task, host, last step, pips, stage, clock | Live | Watched during runs 2 to 4 |
| V4 | Recent sessions with search and Agent, Reached, Intent filters | Live | Sessions page with demo data |
| V5 | Session header: agent and version, Live, host, clock, task, "via docs finder" | Live | Run 4 showed "Claude Code 2.1.299" |
| V6 | Step tracker with times | Live | Session view for runs 3 and 4 |
| V7 | Steps by phase with plain names, polls counted, "session ended · Integration complete" | Live, Test | Session view; test `the timeline groups by phase` |
| V8 | Steps appear as they happen | Live | Session view polls and follows the live stream while a session is live |
| V9 | Overview cards: Traffic, Conversion rate, Main intent, Biggest fix, and a date range | Live | Demo workspace; a custom range of Oct 9 to Oct 15 showed 318 sessions, up 10% on the week before |
| V10 | Funnel as stacked columns per agent, drop between columns, MCP connected column | Live | Demo workspace |
| V11 | Fix dialog: action title, evidence with share of the drop, docs patch "In preview", Cancel and Confirm | Live | Demo workspace, and the real Ledgerly fix drafted by Claude Code |
| V12 | Confirm, and it is "live in production" | Live | After Confirm, Ledgerly served the corrected page to agents within a minute; people still got the old page |
| V13 | More agents complete setup afterwards | Live | Run 5 read the corrected page and made its first API call with no 401. Runs 1, 3 and 4 before the fix each hit the 401 |
| V14 | Fixes prepared before anyone asks | Live | The demo workspace's top fix was drafted by Claude Code before the dialog was opened |

## The feature list

| # | Feature | Status | How it was checked |
|---|---|---|---|
| F1 | Agents seen the moment they visit | Live | SSE arrivals; Live list during runs |
| F2 | Each name with its evidence and label | Live, Test | Agents page; `attribution.test.ts`, `webbotauth.test.ts` |
| F3 | Agents split by where they run | Test | `surface` on each rule; Agents page |
| F4 | How the agent found you | Test | `discovery reads the first event` |
| F5 | What the agent searched for | Test | Search events and search query strings |
| F6 | The task in the person's words | Live | V2 |
| F7 | Tasks grouped into intents | Test | `intents group by workspace definitions first`; model naming through `/api/intents/label` |
| F8 | Every step followed | Live | V7 |
| F9 | The moment it broke | Live | The 401 marked Blocked in runs 1, 3, 4 |
| F10 | Funnel by agent | Live | V10 |
| F11 | Purchases, installs and setup tracked | Live | Download or init, device sign-in and payment in the runs |
| F12 | Revenue by agent, intent and page | Live | Revenue page with demo data |
| F13 | Cost of each drop-off | Test | `fixes are ranked by the revenue they put at risk` |
| F14 | Fixes prepared for you | Live | Claude Code drafted the Ledgerly fix. Anthropic, OpenAI and Gemini: Test only, with a stubbed transport |
| F15 | Publish with a click | Live, Test | Live for agents through the SDK (V12). GitHub pull request: Test only, with a stubbed GitHub API |
| F16 | Test a fix on real agents | Live | Claude Code test run measured by the collector, reached First payment |
| F17 | Conversion before and after a fix | Test | Impact block on the fix page |
| F18 | Docs, API and MCP in one journey | Live, Test | Docs and API in one session in the runs; MCP: `mcp.test.ts` with a real MCP client |
| F19 | Workspaces, sites and keys | Live | Several workspaces in one server during the runs |
| F20 | Agents that run no scripts | Live | Every run |
| F21 | Privacy by default | Test | `stored events are redacted and hashed before they reach the database`, `redact.test.ts` |

## Gaps

| Gap | Note |
|---|---|
| Agent names the demo shows that we cannot match | Muse and Instinct publish no user agent or MCP client name we know of. They appear as Unnamed until a rule is added |
| Live API keys | Anthropic, OpenAI and Gemini were tested with stubbed transports, not real keys |
| GitHub, Stripe, Vercel, Cloudflare | Tested with recorded shapes, not live accounts |
| Web Bot Auth | Tested with the RFC 9421 test key, not a real signing agent |
| Docker | Built and run on 2026-10-16 (OrbStack, arm64): health check, admin token, dashboard, demo data, and data kept across a restart. The image is 484 MB, with no build tools in it |
| npm | The packages build and install from a tarball, but are not published |
| WebFetch on localhost | Claude Code uses curl for `localhost`, so a local test names it only if it follows the `llms.txt` note. On a public HTTPS site, WebFetch sends `Claude-User (claude-code/...)` |
