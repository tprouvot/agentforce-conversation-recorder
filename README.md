# Agentforce conversation recorder (`afrec`)

Plays scripted Agentforce conversations in a real browser and records them: a screenshot of the chat per answer,
an MP4 and a GIF with the agent's thinking pauses cut, a transcript, and an HTML report with checks. It covers the
**Lightning Agentforce panel** and **Embedded Messaging** widgets on Experience Cloud sites (guests or signed-in
users), runs several conversations in parallel, and works from the **command line** or a **local web UI**.

- **No AI at record time, no tokens.** Everything is deterministic: Playwright, ffmpeg, and selector packs.
- **Built to survive Salesforce releases.** Locators are versioned data with a self-healing fallback, a doctor
  checks orgs (and preview sandboxes) ahead of releases, and fixes ship as data. See
  [docs/RELEASE-PROOF.md](docs/RELEASE-PROOF.md).

## What you get

For each conversation, in `.local/recordings/<date-time>/<conversation>/`:

- `NN-<message>.png`: the chat only (panel or widget), at 2x, scrolled so the question is at the top
- `conversation.mp4`: typing and answers at real speed, each thinking pause cut to about 1.5 s
- `conversation.gif`: the same, cropped to the chat; `conversation.webm`: the raw recording
- `transcript.md`: questions, answers, timings, check results; `timeline.json`: the cut points

And for the run: `report.html` (self-contained: share the folder as is), `report.md`, `report.json`.

## Install

Node.js 20 or later, and the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) with your org
authorized (`sf org login web --alias myOrg`).

```sh
npm install --global agentforce-conversation-recorder
afrec setup          # installs Chromium for Playwright, checks ffmpeg and the sf CLI
```

Or from a clone: `npm install && npm link`.

## Quick start

```sh
mkdir my-demo && cd my-demo
afrec init --org myOrg     # afrec.config.json, scenarios/ with the e-bike examples, .gitignore entries
```

Write a scenario, `scenarios/hello.md`:

```markdown
---
surface: lightning
org: myOrg
---
1. Hi
2. What can you help me with?
   - expect: help
   - max-seconds: 30
```

Then:

```sh
afrec run --dry-run        # who signs in where, what runs in parallel; opens nothing
afrec run                  # records every scenario, 3 at a time
open .local/recordings/*/report.html
```

Or do all of it from the browser:

```sh
afrec ui                   # http://127.0.0.1:4477/?token=... (opens your browser)
```

The UI has four views: **Scenarios** (a form or Markdown editor, validated as you type), **Run** (dry run, record,
live progress per conversation, a masked prompt when a step needs a one-time code), **Recordings** (videos,
screenshots, transcripts, checks, the diff with a baseline run), and **Doctor**.

Every message spends agent credits and can run real actions (records created, emails sent): leave out flows you
don't want triggered.

## Scenarios

Markdown for one conversation, CSV for many. Steps are messages, `click:`, `wait:`, `type-from:`, and checks
(`expect:`, `expect-not:`, `expect-button:`, `max-seconds:`). The full reference is in
[docs/SCENARIOS.md](docs/SCENARIOS.md), and [examples/ebike/](examples/ebike/) has a complete demo: guests, a
signed-in rider with a one-time code, a hand-off, a fleet manager in Lightning, and a CSV batch.

## Who gets signed in

Through the sf CLI, never by typing passwords:

| Settings | Sign-in |
| --- | --- |
| `org`, no `user` | the alias's own user (single-use frontdoor URL) |
| `org` + `user` | Login-As by the alias's admin: an internal user in Lightning, or a community user on their site |
| `site`, no `user` | a guest visitor |
| `user` + `credentials` | development only: a password login from a local credentials file |

## Commands

| Command | What it does |
| --- | --- |
| `afrec run [files]` | record (default: the project's `scenarios/`); `--dry-run`, `--parallel`, `--only`, `--headed`, setting flags |
| `afrec ui` | the local web UI |
| `afrec doctor` | prerequisites, a canary conversation, and the state of every locator, for an org or a site |
| `afrec heal` | a repair bundle for a coding agent, from the last broken doctor check |
| `afrec selectors list \| update \| promote \| check` | the selector packs: see them, download fixes, promote healed locators, validate a pack |
| `afrec fixtures test \| add` | replay the offline fixtures; turn a doctor snapshot into one |
| `afrec baseline set <run>`, `afrec compare <run>` | compare runs: what changed in each answer, timing, flags |
| `afrec setup`, `afrec init`, `afrec orgs` | installation, a new project, the sf CLI's orgs |

`afrec --help` (or `afrec <command> --help`) lists every option.

## Configuration

`afrec.config.json` (schema: [schema/config.schema.json](schema/config.schema.json)):

```json
{
  "scenarios": "scenarios",
  "recordings": ".local/recordings",
  "defaults": { "org": "myOrg" },
  "parallel": 3,
  "baseline": null,
  "checks": { "gifMaxBytes": 15000000 },
  "doctor": { "canary": ["Hi", "What can you help me with?"] }
}
```

## Staying ahead of Salesforce releases

```sh
afrec doctor --org myPreviewSandbox           # the Lightning panel
afrec doctor --site https://.../rides/        # a widget (add --org for its release)
```

Healthy: keep the snapshot as a regression fixture (`afrec fixtures add`). Degraded or broken: `afrec heal` writes
a bundle a coding agent can fix offline; a merged fix reaches everyone with `afrec selectors update`. Why and how:
[docs/RELEASE-PROOF.md](docs/RELEASE-PROOF.md).

## For coding agents

[skills/agentforce-conversation-recorder/SKILL.md](skills/agentforce-conversation-recorder/SKILL.md) teaches an
agent (Claude Code and other skill-aware agents) to write scenarios, run and review recordings, and apply a repair
bundle. The tool itself never calls an AI.

## As a library

Everything the CLI does is importable, for scripts, CI, or a future `sf agent record` plugin:

```js
import { loadProject, planRun, executeRun } from 'agentforce-conversation-recorder';

const project = loadProject();
const { conversations, errors } = planRun({ project, inputs: ['scenarios/'] });
const { results, out } = await executeRun(conversations, { project, emit: e => console.log(e) });
```

## Privacy and security

- Recordings show org data: they go to `.local/` (gitignored by `afrec init`); the run warns when they are not
  ignored.
- The UI listens on 127.0.0.1 only, behind a one-time token; changes need the token in a header, and the Host
  header is checked. Passwords never go through it.
- Frontdoor and Login-As URLs carry sessions: they are never printed or written.
- Doctor snapshots are redacted before they are written (structure and UI labels only), and checked against your
  local denylist of names that must never be published (`.afrec/denylist.txt`, one term per line).

## Development

```sh
npm install
npx playwright install chromium
npm run check                      # type check (JSDoc, tsc --checkJs) and tests, fixtures included
node scripts/check-denylist.js --install   # a pre-commit hook against denylisted terms
node scripts/utam-diff.js          # compare the Lightning pack with Salesforce's UTAM page objects
```

Plain JavaScript (ES modules), no build step. The engine is in `src/engine`, the packs logic in `src/selectors`,
the doctor in `src/doctor`, the UI in `src/ui`.

## License

[Apache-2.0](LICENSE)
