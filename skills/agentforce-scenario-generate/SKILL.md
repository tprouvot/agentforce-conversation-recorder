---
name: agentforce-scenario-generate
description: Writes afrec conversation scenarios (.md or .csv) for an Agentforce agent from what it really does - the topics, actions and instructions of its active version, read from the org with afrec new - for a demo recording or a regression suite, then calibrates their checks on a probe run so they pass on good answers and flag bad ones. Use when the user wants test conversations, a demo script or scenarios for an Agentforce agent, does not know what to write in a scenario, or has expect checks that fail on correct answers.
---

# Agentforce scenario generation

You write the conversations `afrec` replays; recording them is the
[agentforce-conversation-recorder](../agentforce-conversation-recorder/SKILL.md) skill. Format reference:
[docs/SCENARIOS.md](../../docs/SCENARIOS.md); a complete set: [examples/ebike/](../../examples/ebike/).

## 1. Settle the goal

Ask when the user has not said:

| | Demo (a video, a GIF, screenshots) | Regression suite (checks, release after release) |
| --- | --- | --- |
| Files | one `.md` per story, 3 to 6 messages | a `.csv`, or one `.md` per topic or risk |
| Messages | the happy path, as the persona would phrase it | every topic, follow-ups, an off-topic request, a hand-off |
| Checks | few: `expect-not:` on failures, `expect-button:` on a card | on every answer, calibrated on a probe run (step 5) |
| Record | the default: screenshots, video, GIF | `record: screenshots` or `none`, then a baseline |

Settle too who signs in (the sf alias's user, Login-As of a persona's user, a guest) and where: the Lightning
panel, or the page where the Messaging widget loads. Never guess a site URL: ask for it.

## 2. Read what the agent can do

```bash
afrec orgs                       # the sf aliases
afrec new <name> --org <alias> [--agent <label>] [--user <username>] [--site <url>] --json
```

It prints the active agents, the one picked, the topics of its active version (description, scope, instructions,
actions; `confirm: true` when the agent asks before running an action) and the user, checked (on Messaging, with
the site they belong to). Its errors say what to add: several agents, `--agent`; Messaging, `--site`. Without
`--json` it writes `scenarios/<name>.md` with the settings and that list in a comment: write the steps there.

Write questions only for what these topics cover; anything else is the off-topic test. The instructions tell what
the agent must refuse or hand off: those are the guardrail tests.

## 3. Write the conversations

- Phrase each message as the persona would, about their own records. When a question needs data (an account, an
  order number, a station), ask the user for names that exist in the org, or query them (`sf data query`) and
  confirm. Never invent one: the agent answers "not found", and the check flakes.
- One story per conversation, with follow-ups that lean on the previous answer ("Group them by station"): keeping
  that context is part of what is tested.
- After an action with `confirm: true`, the next step answers the confirmation: `click: /confirm|yes/` on a card,
  or a `yes` message.
- One-time codes: `type-from: prompt one-time code`. Never a password in a scenario.
- A hand-off to a person ends the recording: put it last.
- The Lightning panel's suggestions are generated, their wording changes: click them with a `/regex/`.

## 4. Checks, before any answer is known

Start loose; step 5 tightens them.

- `expect-not: sorry|went wrong|unable` on every answer of a suite.
- `expect:` with the topic's own words, as alternatives (`battery|charge`), never a sentence: the agent rewords
  every run. No exact number or date unless the data is fixed.
- `expect-button:` for the card or quick reply an action sends.
- `max-seconds:` only when timing matters, and generous (30 or more).

Then `afrec run --dry-run <files>`: fix every error, and show the user the plan.

## 5. Calibrate on a probe run

Every message spends agent credits and can run real actions (create a task, send an email): name them before the
run, prefer a sandbox, and wait for the user's go-ahead.

```bash
afrec run <files> --record none     # transcripts only (a record: setting in a file wins over the flag)
```

Read each `transcript.md` (every answer and its check results), then:

- a check that failed on a good answer: loosen it to the words that carry the meaning;
- a check that passed on a bad answer: tighten it, or add an `expect-not:`;
- an answer showing the agent misread the question: rephrase the message, not the check;
- for a suite, probe a second time and keep in `expect:` only the words both answers share.

Once it passes, `afrec baseline set latest`: later runs compare every answer with this one.

## 6. Hand over

Give the user the files, one line per conversation (what it shows, who signs in), the actions it runs, and the
command to record: `afrec run`, or `afrec ui`.
