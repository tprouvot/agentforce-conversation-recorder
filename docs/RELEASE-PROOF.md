# How afrec keeps working across Salesforce releases

Salesforce ships three major releases a year (Spring, Summer, Winter), and each can change the markup of the
Agentforce panel or of the Embedded Messaging widget: a renamed class, a new wrapper component, a different
button label. A recorder that hard-codes its selectors breaks on release day, usually right before a demo.

afrec is built so that a markup change:

1. rarely breaks a run (the locators are layered and semantic first);
2. when it does, does not stop the run (a structural fallback finds the chat again);
3. is seen weeks before it reaches production orgs (a doctor, preview sandboxes, an upstream watch);
4. is fixed as data, offline, without a new release of the tool (selector packs, fixtures, repair bundles).

**No AI runs at record time and no token is spent.** AI is optional, and only used for maintenance (step 4), on
redacted data.

## The concepts

### 1. Locators as data: selector packs

Every locator lives in a JSON file per surface (`packs/lightning.json`, `packs/messaging.json`), validated by
`schema/pack.schema.json`. The code only knows element names: `input`, `agentText`, `userText`, `busy`,
`launcher`, `frame`, and so on. Fixing a locator is a data change.

- **Ordered candidates.** Each element lists candidates, tried in order; the first that matches wins. A new
  release adds a candidate in front, and the older ones stay for orgs still on the previous release.
- **Versioned by release.** A pack applies from its `minApiVersion`. For an org at API version *V* (read from
  `sf org display`), afrec picks the pack of that surface with the highest `minApiVersion` <= *V*. When a release
  changes things incompatibly, a `lightning@v70.json` pack takes over from Summer '27 (API 70) on, and orgs on older
  releases keep the old pack.
- **Two kinds of matching.** Playwright locators (role and accessible name, CSS piercing open shadow roots, title,
  label, text) for what the recorder clicks and types into. In-page matchers (tag, class, regex on classes, CSS
  `matches`, explicit role, `not`, `within` an ancestor) for the chat reader, which walks shadow roots itself.
- **`first` or `any`.** For most elements the first candidate that matches is used. For busy indicators and system
  events, an element matching any candidate counts.

### 2. Semantic first: accessibility roles, then the design system, then components

Candidates go from the most stable contract to the least:

1. **ARIA roles and accessible names** (`role: textbox`, `name: "chat message input|..."`, `role: button`,
   `name: "^Agentforce$"`). Salesforce must keep these for accessibility compliance, whatever the markup.
2. **SLDS classes** (`slds-chat-message__text_inbound`, `slds-chat-listitem`): the published Salesforce Lightning
   Design System chat blueprint, shared by the Lightning panel and the widget.
3. **Component tags** (`runtime_copilot_base-assistant-panel`): the most specific, and the first to change.

The reader also avoids generated ids, positions, and state classes (`slds-is-*`, `slds-has-*`).

### 3. Behavior over markup: how an answer is detected

An answer is not "the element with class X appeared". It is:

- **echo anchoring**: the user's own bubble is found by the text that was just sent, so a late answer to the
  previous question, or a panel that re-renders without its history, does not confuse the reader;
- **quiescence**: the agent's messages after that bubble, once nothing has changed for `settle` seconds;
- **busy indicators as hints**: progress or typing indicators extend the wait, but an answer still ends on the
  settle timer when none is found;
- **hand-off detection**: a new "left", "transferred" or "ended" event with no answer ends the conversation there.

### 4. Self-healing at run time, without AI: the structural fallback

When no candidate finds the user's bubble after sending, the run does not fail. A structural fallback looks at the
chat the way a person would:

- the **bubble** is the element whose text is exactly the message just sent (shadow roots included);
- its **direction marker** is the nearest class on the bubble or its ancestors that says "sent by me": `outbound`,
  `outgoing`, `sent`, `self`, `mine`, `user`, `customer`, `right`...;
- the **agent's messages** use the **mirrored** marker (`inbound`, `incoming`, `received`, `agent`, `left`...),
  checked against the classes that exist in the chat.

The same idea applies to the launcher (a header button named like the assistant), the input (the visible text
box), and the widget's launcher. `fixtures/lightning/synthetic-renamed` is a chat where every class was renamed: the
pack misses, the fallback finds the messages, and the reply is read (see `test/fixtures.test.js`).

### 5. A healing ledger with a confirmation step

What the fallback finds is written to `.afrec/overrides.json` and tried first by the next runs, so a batch keeps
working. It is not trusted silently:

- every transcript, `report.md` and `report.html` says **"Running on healed locators"** while overrides are used;
- `afrec doctor` **confirms** them when a later, independent check works with them (a check that just healed
  something does not confirm it);
- `afrec selectors promote` turns confirmed overrides into a pack entry: in the tool's repository it updates
  `packs/*.json` for a pull request; elsewhere it writes a local pack that applies at once.

### 6. A doctor, and preview sandboxes as an early-warning system

`afrec doctor` checks one org end to end, read-only on the org:

- prerequisites: Chromium, ffmpeg, the sf CLI, the org's API version (hence its release and its pack), active
  agents, enabled Embedded Service deployments;
- a **canary conversation** (by default "Hi" and "What can you help me with?") through the real chat;
- **per element**: `ok` (the first candidate matched), `fallback` (a later one: the primary locator broke),
  `healed`, `missing`, or `unused`; the check is healthy, degraded or broken.

Salesforce opens **preview sandboxes** four to six weeks before each release. Running `afrec doctor` on one turns a
release-day surprise into a pull request weeks ahead.

### 7. Snapshot fixtures: offline regression tests per release

The doctor saves a **redacted snapshot** of the chat (`page.html`, plus `frame.html` for the widget) and its
accessibility tree (`aria.yml`):

- shadow roots are serialized as **declarative shadow DOM** (`<template shadowrootmode="open">`), so the snapshot
  replays in Chromium with its structure intact;
- elements that were not displayed carry `hidden`;
- **redaction**: text keeps only the chat UI's own vocabulary (Send, Clear history, End chat...); every other word
  becomes x's, digits become 0, and emails, URLs and Salesforce Ids are replaced. Custom components of the org's
  namespace (`c-...`) are masked. Slot names stay (they are structure);
- a **denylist** (customer names, program names, org domains: `.afrec/denylist.txt`, never committed) is checked
  before anything becomes a fixture or a bundle, and by a pre-commit hook.

`afrec fixtures add` turns a snapshot into `fixtures/<surface>/<release>/`. `npm test` replays every fixture
against the packs in CI, on Linux, macOS and Windows, with no org: a pack change that breaks an older release
fails the build. `fixtures/*/winter-27` were captured from a live Winter '27 org.

### 8. Out-of-band updates: data, not code

`afrec selectors update` downloads `packs/index.json` and the packs it lists from the repository's main branch,
**validates them against the schema** (a pack can never contain code), and keeps the ones newer than what is
installed (`~/.afrec/packs`). A fix reaches users the day it merges, with no new npm release and no upgrade.

### 9. Watching upstream: Salesforce's own page objects

Salesforce publishes UTAM page objects (`salesforce-pageobjects`) for each release, including the Agentforce panel
(`runtime_copilot`, `runtime_copilot_base`). They are not a run-time dependency of afrec: they cover only part of
the panel, nothing of the widget, and come with their own runtime. Instead, `scripts/utam-diff.js` and a weekly
GitHub Action compare them with the Lightning pack:

- a pack candidate taken from UTAM (`"source": "utam"`, such as the agent selector's `section.agent-item`) that
  UTAM no longer has;
- any change of the panel's page objects since the last review (a hash), which usually means a reworked panel.

Either opens an issue, often before the release reaches orgs.

### 10. Stable contracts for signing in

Signing in never scripts a login page (except the development-only password login). It goes through documented
interfaces: `sf org display --json`, `sf org open --url-only` (a single-use frontdoor URL), and the Login-As servlet
(`servlet.su`) for internal and community users. Sessions are built off camera and handed to the recording context,
so recordings start on the app or the site.

### 11. AI only for maintenance, on redacted data: repair bundles

When the doctor finds elements missing, `afrec heal` writes a **repair bundle**: the redacted snapshot, the
accessibility tree, the failing elements with the candidates that no longer match, the pack and its schema, a ready
fixture, any healed overrides, and a `README.md` that is the task description for a coding agent (Claude Code,
Agentforce Vibes, Cursor...). The agent edits `pack.json` and verifies offline:

```sh
afrec selectors check pack.json
afrec fixtures test fixture --pack pack.json
```

The tool itself contains no AI client and needs no API key; the bundle is checked against the denylist and holds
no org data. The skill in `skills/agentforce-conversation-recorder/` tells an agent how to apply a bundle.

## The release playbook

| When | What |
| --- | --- |
| Preview sandboxes open (4 to 6 weeks before a release) | `afrec doctor` on a preview sandbox, for both surfaces |
| Healthy | `afrec fixtures add <doctor-dir> --name <release>`, then a pull request: the new release is now a regression test |
| Degraded or broken | `afrec heal`, give the bundle to a coding agent, check with `afrec fixtures test`, then a pull request with the pack and the fixture |
| A run healed during a demo prep | `afrec doctor` again (confirms), then `afrec selectors promote` |
| The UTAM watch opens an issue | `afrec doctor` on a preview sandbox; close the issue with `node scripts/utam-diff.js --update` once reviewed |
| A fix is merged | users run `afrec selectors update` |
