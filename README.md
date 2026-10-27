# Agentforce conversation recorder (`afrec`)

Records Agentforce conversations for you. You write the questions in a small text file; `afrec` types them in a
real browser, waits for each answer, and gives you a screenshot per answer, an MP4, a GIF, a transcript and an
HTML report. It works on the **Lightning Agentforce panel** and on **Embedded Messaging** chat widgets (as a guest
or a signed-in user), from the command line or from a local web page.

No AI at record time: nothing to configure, no tokens spent, the same script plays the same way every time.

## Install

> **Not on npm yet.** `npm install --global agentforce-conversation-recorder` does not work for now: install it
> from GitHub as below.

You need [Node.js](https://nodejs.org) 20 or later, git, and the
[Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) logged in to your org:

```sh
sf org login web --alias myOrg
```

Then, once:

```sh
git clone https://github.com/tprouvot/agentforce-conversation-recorder.git
cd agentforce-conversation-recorder
npm install
npm link             # makes the afrec command available in every folder
afrec setup          # installs the browser afrec drives, checks ffmpeg and the sf CLI
```

To update later: `git pull && npm install` in that folder. To remove: `npm unlink --global agentforce-conversation-recorder`.

## Record your first conversation

**1. Make a project folder**, anywhere outside the clone:

```sh
mkdir my-demo && cd my-demo
afrec init --org myOrg --example none    # afrec.config.json (myOrg by default), an empty scenarios/ folder
```

**2. Start a scenario.** `afrec new` finds your agent in the org and writes `scenarios/<agent>.md`, with what the
agent can do (its topics and actions) in a comment, to give you ideas:

```sh
afrec new                                  # the Agentforce panel in Lightning, as you
afrec new --user jordan.lee                # the same, logged in as another user (Login-As)
afrec new --site https://<your-site>/      # the chat widget on a site, as a guest
```

Several agents in the org? Add `--agent "<agent name>"`.

**3. Write your questions** at the end of that file: one numbered line per message. Under a message, you can add
checks on its answer. For example:

```markdown
1. Hi
2. Which bikes have a low battery?
   - expect: battery
   - expect-not: sorry|went wrong
3. Group them by station.
```

**4. Check, then record:**

```sh
afrec run --dry-run      # who signs in where, what will run; sends nothing
afrec run                # records every scenario in scenarios/, and prints where the report is
```

Open the `report.html` it prints. Each message spends agent credits and can run real actions (records created,
emails sent): don't script what you don't want to happen.

Prefer clicking? `afrec ui` does the same in your browser: write scenarios, run them, watch the progress, browse
the recordings.

## Let a coding agent write the scenarios

With Claude Code (or another agent that reads skills), add the two skills of this repository. From the clone
folder:

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/agentforce-scenario-generate" "$PWD/skills/agentforce-conversation-recorder" ~/.claude/skills/
```

Then ask, for example: *"write a demo scenario for the agent in myOrg, logged in as jordan.lee, and record it"*.
The agent reads what your agent can do, writes the questions and checks, tries them once, then tightens the
checks. [agentforce-scenario-generate](skills/agentforce-scenario-generate/SKILL.md) writes the scenarios;
[agentforce-conversation-recorder](skills/agentforce-conversation-recorder/SKILL.md) runs and reviews the
recordings, and fixes the tool when a Salesforce release changes the chat.

## What you get

For each conversation, in `.local/recordings/<date-time>/<conversation>/`:

- `NN-<message>.png`: the chat only (panel or widget), at 2x, scrolled so the question is at the top
- `conversation.mp4`: typing and answers at real speed, each thinking pause cut to about 1.5 s
- `conversation.gif`: the same, cropped to the chat; `conversation.webm`: the raw recording
- `transcript.md`: questions, answers, timings, check results; `timeline.json`: the cut points

And for the run: `report.html` (self-contained: share the folder as is), `report.md`, `report.json`.

## Scenarios

One conversation per Markdown file, or many in a CSV (a spreadsheet export works). Besides messages, a step can
be `click: <button>`, `wait: <seconds>`, or `type-from: prompt one-time code` (you type the code when asked).
Checks on an answer: `expect:`, `expect-not:`, `expect-button:`, `max-seconds:`; a failed check flags the
conversation, the run goes on.

Everything is in [docs/SCENARIOS.md](docs/SCENARIOS.md). [examples/ebike/](examples/ebike/) is a complete demo:
guests, a signed-in rider with a one-time code, a hand-off to a person, a fleet manager in Lightning, a CSV batch
(`afrec init` without `--example none` copies it into `scenarios/`).

### Who gets signed in

Always through the sf CLI, never by typing a password:

| In the scenario | Signed in |
| --- | --- |
| `org` only | the user of that sf alias |
| `org` + `user` | that user, by Login-As from the alias's admin: in Lightning, or on their site |
| `site` only | nobody: a guest visitor |
| `user` + `credentials` | development only: a password login from a local file |

Login-As needs "Administrators Can Log in as Any User" (Setup > Login Access Policies).

## Commands

| Command | What it does |
| --- | --- |
| `afrec init` | a new project folder: `afrec.config.json`, `scenarios/`, `.gitignore` entries |
| `afrec new [name]` | a scenario to start from: settings checked in the org, the agent's topics and actions listed in it; `--json` prints them |
| `afrec run [files]` | record (default: every scenario in `scenarios/`); `--dry-run`, `--only <name>`, `--headed` to watch |
| `afrec ui` | the local web UI |
| `afrec doctor` | is everything in place? prerequisites, a test conversation, and every element of the chat |
| `afrec heal` | after a broken doctor check: a repair bundle for a coding agent |
| `afrec selectors list \| update \| promote \| check` | the chat locators: see them, download fixes, keep healed ones, validate a pack |
| `afrec fixtures test \| add` | replay the offline test pages; turn a doctor snapshot into one |
| `afrec baseline set <run>`, `afrec compare <run>` | compare two runs: what changed in each answer, timing, flags |
| `afrec setup`, `afrec orgs` | install and check the prerequisites; list the sf CLI's orgs |

`afrec --help` lists every option.

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

`defaults` apply to every scenario that leaves them out; a command-line flag (`--org`, `--user`, ...) does the same.

## Staying ahead of Salesforce releases

Salesforce changes the chat's markup with its releases. `afrec` keeps its locators as versioned data with a
self-healing fallback, and its doctor checks an org (a preview sandbox before a release, for example):

```sh
afrec doctor --org myPreviewSandbox           # the Lightning panel
afrec doctor --site https://.../rides/        # a widget (add --org for its release)
```

Healthy: keep the snapshot as a regression fixture (`afrec fixtures add`). Degraded or broken: `afrec heal` writes
a bundle a coding agent can fix offline; a merged fix reaches everyone with `afrec selectors update`. Why and how:
[docs/RELEASE-PROOF.md](docs/RELEASE-PROOF.md).

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
