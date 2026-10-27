# Scenario reference

A scenario is a conversation to replay: where it runs, who is signed in, and the steps. Write it in Markdown (one
conversation per file) or CSV (several per sheet), by hand or with the form editor of `afrec ui`. Both formats are
validated by `schema/scenario.schema.json`.

## Start from your agent

```sh
afrec new --org myAdminAlias --user fleet.manager            # Lightning, the org's employee agent
afrec new rider-extends --org myAdminAlias --user rider.demo --site https://example.my.site.com/rides/
```

`afrec new` checks the settings in the org (the agent, the user, the site of a community user) and writes
`scenarios/<name>.md` (by default the agent's name) with them, who signs in, and in a comment what the agent can
do: the topics of its active version, their scope and actions, and which actions ask for a confirmation. You write
the messages; until there is one, a run stops with "has no message to send".

With several active agents, pick one with `--agent`. On Messaging, give `--site`: the org cannot tell which page
carries the widget. `--json` prints what the org says, topic instructions included, and writes nothing.

## Markdown (.md)

```markdown
---
surface: messaging
site: https://example.my.site.com/rides/
org: myAdminAlias
user: rider.demo
---
# A signed-in rider extends a rental

1. Hi
2. I'd like to extend my current rental by one hour.
   - expect: code|verify
3. type-from: prompt one-time code
4. click: /confirm|yes/
   - expect: extended
   - expect-not: sorry|went wrong
   - max-seconds: 20
```

- Optional YAML front matter between `---` lines holds the settings. An unknown key is an error, to catch typos.
- Every top-level list item (`1.`, `1)`, `-`, `*`) is one step, in order. Indented lines continue the item: a
  multi-line message is typed with Shift+Enter between lines.
- An indented `- expect: ...` (or any other directive) under a message is its own step, after that message.
- Headings, paragraphs and `<!-- comments -->` are notes. A directive may end with `  # a comment`.
- The conversation is named after the file unless `name:` says otherwise.

## CSV (.csv)

```csv
conversation,surface,org,user,site,message,expect,max seconds
FleetBatteries,lightning,myAdminAlias,fleet.manager,,Which bikes have a low battery?,battery,30
FleetBatteries,,,,,Group them by station.,station,
Guest,messaging,,,https://example.my.site.com/rides/,Hi,,
Guest,,,,,"Is there a monthly pass?
Does it include helmets?",pass,
```

- The first row is the header. `message` is required; `conversation`, the checks (`expect`, `expect not`,
  `expect button`, `max seconds`) and any setting are optional. Header names ignore case, spaces, `_` and `-`.
- One row is one step. A blank `conversation` cell continues the conversation above; without the column, the file
  is one conversation named after the file.
- A setting applies to its whole conversation: give it once. Two different values in one conversation are an error.
- A check column checks the answer to that row's message.
- Comma or semicolon delimiter (detected from the header); RFC 4180 quoting. A spreadsheet export works as is.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `surface` | `messaging` with `site`, `lightning` with `app`, `path` or `agent` | `lightning` (the Agentforce panel) or `messaging` (an Embedded Messaging widget) |
| `org` | | sf CLI alias or username: the Lightning org, the admin who logs in as `user`, the release that picks the selector pack |
| `user` | | username, the part before the @, or full name. With `org` and no `credentials`: Login-As by the org's admin |
| `agent` | the panel's agent | Lightning: the agent to pick in the panel's agent selector (label or API name), when the user has several |
| `app` | the user's last app | Lightning: app API name to open, e.g. `c__MyApp` |
| `path` | `/lightning/page/home` | Lightning: any path, e.g. a record page; wins over `app` |
| `site` | | Messaging: URL of the page where the widget loads |
| `network` | the user's only site | Experience Cloud site (name or Id) for a community user's Login-As |
| `viewport` | `desktop` (1440x900 at 2x) | `mobile` (390x844 at 3x, Messaging only) or `WIDTHxHEIGHT` |
| `record` | `screenshots, video, gif` | any subset; `none` keeps only the transcript |
| `fresh` | `true` | start clean: end a Messaging chat left open, clear the Lightning panel's history |
| `warmup` | `Hi` | Messaging: greeting sent first when the first message isn't one; `false` to disable |
| `hideLoginAsBanner` | `false` | Lightning Login-As: hide the "Logged in as ... Log out" banner |
| `replyTimeout` | `180` | seconds to wait for an answer |
| `settle` | `5` | seconds without change that end an answer (at least 12 for the first Messaging exchange) |
| `typeDelay` | `35` | ms per key while a video is recorded (a long message takes at most about 4.5 s); `0` pastes |
| `inputTimeout` | `600` | seconds a `type-from` step waits for its value |
| `credentials` | | **development only**: a file of `username password  (note)` lines, for a password login |
| `loginUrl` | My Domain, or `<site>login` | **development only**: the login page of a password login |
| `authUrl` | | **development only**: a file holding an sfdx auth URL, authorized as `org` before the run |

Settings missing from a file come from the command line (`--org`, `--site`, ...), then from `defaults` in
`afrec.config.json`.

## Steps

| Step | Effect |
| --- | --- |
| a message | typed like a person (Shift+Enter between lines), sent with Enter; the answer is awaited |
| `click: <label>` | presses the most recent visible button, link, menu item, option, radio, tab or checkbox whose name, title or aria-label contains the label (or matches `/regex/`); waits up to 15 s for it, then for an answer if one starts within 15 s |
| `wait: <seconds>` | pauses; the MP4 keeps one second of it |
| `type-from: prompt [label]` | asks for a value live (a one-time code): the UI shows a masked field, the terminal asks. The chat (so the video) shows it, as it would for a person; the logs, the transcript and the report mask it |
| `type-from: <file>` | the same, and writing the value to the file answers it too (for another script); the file is deleted once read |
| `\click: ...` | a message that really starts with a directive word |

### Checks

Checks apply to the answer of the message (or click) they follow. A failed check flags the conversation; the run
goes on.

| Check | Passes when |
| --- | --- |
| `expect: <regex>` | the answer matches (plain text is a case-insensitive regex; `/.../flags` for a literal one) |
| `expect-not: <regex>` | the answer does not match (for example `sorry|went wrong`) |
| `expect-button: <label>` | a button or link with that label is visible in the chat (a quick reply, a confirmation card) |
| `max-seconds: <n>` | the answer started within *n* seconds |

The panel's suggestions and "Recommendations" are generated: their wording changes from one run to the next.
Click them with a `/regex/`, or type the request instead.

### Automatic checks

Every run also flags: a reply screenshot that is nearly blank or does not show its question, an MP4 longer than
its cut list, a GIF above `checks.gifMaxBytes`, an answer that vanished, the platform's "Something went wrong", and
steps skipped after a hand-off. With a baseline set (`afrec baseline set <run>`), each answer is compared with the
baseline's: a word diff, a similarity score, timing and flag changes.

## Who gets signed in

| Settings | Sign-in |
| --- | --- |
| `org`, no `user` | the alias's own user (a single-use frontdoor URL) |
| `org` + `user` | Login-As by the alias's admin (Lightning, or the community user's site) |
| `site`, no `user` | a guest visitor |
| `user` + `credentials` | development only: the login form, with `username password` from that file |

Login-As needs "Administrators Can Log in as Any User" (Setup > Login Access Policies).
