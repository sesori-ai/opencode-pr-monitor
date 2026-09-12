# @sesori/pr-monitor-pi

Pi and Oh My Pi (OMP) extension that watches your GitHub pull requests and posts `[PR Monitor]` status reports back
into the session that opened them. It also manages the ready-for-human-review label.

## Install

Needs a logged-in GitHub CLI (`gh auth status`).

Pi 0.84.2 or newer, with Node.js 22.19 or newer:

```sh
pi install npm:@sesori/pr-monitor-pi
```

OMP 18.0.3 or newer, using the Bun runtime bundled with OMP:

```sh
omp plugin install @sesori/pr-monitor-pi
```

The package gives Pi its upstream entry and OMP its compatibility entry automatically. Nothing else to configure.

## What it does

The extension adds a `pr_monitor` tool with `start`, `stop`, `flush`, `status`, `mark_ready`, and `unmark_ready`
actions, plus one `monitor-pr` skill. The skill tells the agent to start a monitor right after opening a PR, act on
every report, mark its GitHub replies with the reply prefix so the monitor can recognise them, and end its turn
instead of building its own wait loop.

Reports cover new commits, CI, reviews and comments, merge conflicts, and the PR merging or closing. Each one says
whether the PR is ready for human review and never quotes comment bodies. Reports are delivered through the host's
native custom-message API and can start a turn when the agent is idle. When CI passes (or there is none), the PR is
mergeable, and all feedback has been answered, the monitor adds the ready label. A new commit or new feedback removes it again.

Monitors live in memory and belong to the active session. Pi clears them when the extension shuts down after a
successful session new, resume, fork, or reload. OMP clears them after a successful session switch. A canceled
transition leaves them alone. Neither host restores monitors after a process restart.

## Configuration

Global settings live in `~/.config/pr-monitor/config.json`. Once a project is trusted, it can override them in
`.pr-monitor.json`, then `.pi/pr-monitor.json` (`.omp/pr-monitor.json` in OMP), then `.opencode/pr-monitor.json`.
Pi ignores project-local settings until you trust the project. Settings:

- `debounceMinutes`, `maxCiWaitMinutes`, and `pollIntervalSeconds`
- `ignoreCommentTag`, the prefix agent replies must start with (default `<!-- pr-monitor:reply -->`)
- `announceOnStart` and `flushOnCiFailure`
- `readyLabel` and `autoMerge`

To merge ready PRs automatically, set `autoMerge: true` in the global file or a trusted project file. Project config
overrides global config, and an explicit `SESORI_PR_MONITOR_AUTO_MERGE` environment value overrides both. With
auto-merge on, starting a monitor removes any ready label that is already there and asks the agent to reassess.
Merged PRs get an `automatically-merged` label. Read the
[auto-merge guide](https://github.com/sesori-ai/pr-monitor-plugin/blob/main/docs/configuration.md#auto-merge)
before turning it on.

More in the repository docs:
[how the monitor decides](https://github.com/sesori-ai/pr-monitor-plugin/blob/main/docs/behavior.md),
[configuration](https://github.com/sesori-ai/pr-monitor-plugin/blob/main/docs/configuration.md), and
[development and releases](https://github.com/sesori-ai/pr-monitor-plugin/blob/main/docs/development.md).

## License

MIT
