# PR Monitor

Your coding agent opens a pull request and moves on. PR Monitor keeps watching the PR for it: new commits, CI
results, reviews, comments, merge conflicts, and the final merge or close. When something happens, a short
`[PR Monitor]` message lands back in the same agent conversation so the agent can act on it.

Works with **OpenCode, Claude Code, Codex, Pi, Oh My Pi (OMP), and Hermes**.

## Install

Every host uses the [GitHub CLI](https://cli.github.com) to talk to GitHub. Install it first, then make sure you are
logged in as the account that should read and label your pull requests:

```sh
gh auth status
```

Then add the plugin to your host.

### OpenCode

Needs OpenCode 1.17 or newer. Add the plugin to your project `opencode.json`, or to
`~/.config/opencode/opencode.json` for every project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@sesori/pr-monitor-opencode"]
}
```

Restart OpenCode. It installs the package on startup. Pin `@sesori/pr-monitor-opencode@X.Y.Z` if you prefer to
upgrade on your own schedule.

### Claude Code

Needs Node.js 18 or newer on macOS or Linux. Inside Claude Code:

```text
/plugin marketplace add sesori-ai/pr-monitor-plugin
/plugin install pr-monitor@sesori
```

You get the `pr_monitor` tool plus four slash commands: `/pr-monitor:watch`, `/pr-monitor:status`,
`/pr-monitor:ready`, and `/pr-monitor:unready`.

### Codex

Needs Codex 0.153 or newer and Node.js 18 or newer on macOS or Linux.

```sh
codex plugin marketplace add sesori-ai/pr-monitor-plugin
codex plugin add pr-monitor@sesori
```

Codex delivers reports through hooks, and it will not run a plugin's hooks until you trust them. One more step:

1. Open `codex` in a terminal as the same user and `CODEX_HOME` that your Codex CLI or app-server uses.
2. Run `/hooks` and trust all four `pr-monitor@sesori` entries: `SessionStart`, `UserPromptSubmit`, `PostToolUse`,
   and `Stop`.
3. Go back to your conversation and send one new prompt. Monitoring can start after that.

If you use Codex through another client, such as Sesori, run `/hooks` on the machine that hosts the Codex
app-server. See [Codex in the host guide](docs/hosts.md#codex) if monitoring says the hook is not registered.

### Pi

Needs Pi 0.84.2 or newer and Node.js 22.19 or newer.

```sh
pi install npm:@sesori/pr-monitor-pi
```

### Oh My Pi (OMP)

Needs OMP 18.0.3 or newer.

```sh
omp plugin install @sesori/pr-monitor-pi
```

### Hermes

Needs Node.js 18 or newer on the Hermes backend.

```sh
hermes plugins install sesori-ai/pr-monitor-plugin/hermes
hermes plugins enable pr-monitor
```

Restart Hermes afterwards. Node.js and the logged-in `gh` must be on the **backend's** `PATH`, not just your
laptop's. If your profile restricts tools, enable the `pr-monitor` toolset.

Background monitoring works in Hermes Desktop and TUI. The Hermes CLI, messaging gateways, and ACP clients can only
use the manual ready and unready actions. Details are in the [Hermes README](hermes/README.md).

### Check it works

Ask your agent to list its PR monitors. It should answer that none are active. Then open a PR and ask the agent to
monitor it, or call the tool yourself:

```text
pr_monitor(action: "start", pr: "owner/repo#123")
```

Full PR URLs work too. Every host ships a `monitor-pr` skill, so after a PR is opened the agent usually starts the
monitor on its own.

## What you get

Once a monitor is running, the agent ends its turn and waits. PR Monitor does the polling. When there is something
worth knowing, a report like this appears in the conversation:

```text
[PR Monitor] [acme/widgets#42] — "Fix reconnect backoff"
- CI: passing (5/5)
- Mergeable: MERGEABLE
- [comment:inline] ACTION REQUIRED: 1 thread received a new relevant comment
- Ready for human review: NO — feedback awaits an agent reply
```

- **Fewer, better messages.** Routine activity is batched. If CI is still running, the report waits for it so you
  see one summary instead of a drip of notifications.
- **Bad news travels fast.** A new CI failure, a merge conflict, or the PR merging or closing is reported at the
  next poll.
- **Facts, not transcripts.** Reports name authors, counts, and statuses. They never quote comment bodies.
- **Hands-off handoff.** When CI is green, the PR is mergeable, and the agent has replied to all feedback, PR Monitor
  adds the `ready-for-human-review` label. New commits or feedback take it off again. Agent replies start with a
  hidden `<!-- pr-monitor:reply -->` marker so the monitor can tell them apart from human comments.
- **Optional auto-merge.** Off by default. When on, a ready PR gets one careful squash merge. Read
  [auto-merge](docs/configuration.md#auto-merge) before turning it on.
- **Stops by itself** when the PR merges or closes.

## Tool actions

The `pr_monitor` tool is the same on every host:

| Action | Target | What it does |
|---|---|---|
| `start` | one PR | Start watching and report the current state. |
| `stop` | one PR or `all` | Stop watching. |
| `flush` | one PR or `all` | Send a full report right now. |
| `status` | none | List the monitors this conversation owns. |
| `mark_ready` | one PR | Add the ready label, accepting the PR as it is. |
| `unmark_ready` | one PR | Remove the ready label. |

`mark_ready` is for feedback you have looked at and decided needs no reply, such as a bot comment. `unmark_ready`
is not a permanent hold: if the PR later looks clean again, the label comes back.

## Configuration

Defaults are sensible and no config file is needed. To change them, create `~/.config/pr-monitor/config.json` for
yourself or `.pr-monitor.json` in a repository. The settings people change most:

```json
{
  "debounceMinutes": 2,
  "readyLabel": "ready-for-human-review",
  "autoMerge": false
}
```

The [configuration guide](docs/configuration.md) lists every setting, where files are looked up, and how auto-merge
keeps itself safe.

## Good to know

- Monitors live in memory and belong to the conversation that started them. Quitting the host loses them, so ask
  the agent to start them again after a restart.
- The monitor owns the waiting. The agent should not sleep, poll, schedule checks, or call `status` and `flush` in
  a loop. Reports arrive on their own.
- Reports reach the agent differently on each host, and some hosts have extra limits. See the
  [host guide](docs/hosts.md).

## More documentation

- [Host guide](docs/hosts.md): how reports are delivered and when monitors stop, per host
- [Configuration](docs/configuration.md): every setting, and auto-merge safety
- [How the monitor decides](docs/behavior.md): polling, batching, feedback acknowledgement, readiness
- [Development and releases](docs/development.md): repository layout, checks, publishing
- [Regression catalog](docs/regression/README.md)
- [Changelog](CHANGELOG.md)

## Contributing

```sh
npm ci
npm run release:check
```

See [development and releases](docs/development.md) for the repository layout, build artifacts, and release steps.

## License

[MIT](LICENSE)
