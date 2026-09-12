# @sesori/pr-monitor-pi

Pi and Oh My Pi (OMP) extension that watches GitHub pull requests, manages
ready-for-human-review state, and delivers `[PR Monitor]` reports into the active session.

## Install

Pi 0.84.2 or newer:

```sh
pi install npm:@sesori/pr-monitor-pi
```

OMP 18.0.3 or newer:

```sh
omp plugin install @sesori/pr-monitor-pi
```

The package supplies the upstream entry to Pi and the OMP compatibility entry
to OMP automatically. Requirements: Node.js 22.19 or newer for Pi (or the Bun
runtime bundled with OMP), plus an installed and authenticated GitHub CLI
(`gh auth status`).

## Behavior

The extension registers `pr_monitor` actions for `start`, `stop`, `flush`,
`status`, `mark_ready`, and `unmark_ready`. It reports commits, CI,
reviews/comments, conflicts, and terminal state. It automatically adds
readiness when the current head is clean and feedback is acknowledged, then
withdraws it on later commits or relevant feedback. Every report states
readiness, contains no comment bodies, and is delivered through the host's
native custom message API with turn triggering enabled.

The package also supplies one `monitor-pr` skill. It teaches the agent to start
a monitor immediately after opening a PR, handle every automatic report, use
prefixed replies as acknowledgement evidence, and end the turn instead of making
its own wait or polling loop.

Monitors are in memory and belong to the active agent session. Pi clears them
when the current extension instance shuts down after a successful session
replacement or reload. OMP clears them after its successful session-switch
event. Canceled transitions leave the current monitor untouched. Neither host
restores monitors after process restart.

Set `autoMerge: true` in global `~/.config/pr-monitor/config.json` or trusted project config to make automatic
readiness and `mark_ready` perform one head-fenced, title-only squash merge. Project config overrides global config;
an explicit `SESORI_PR_MONITOR_AUTO_MERGE` environment value overrides both. With auto-merge enabled, startup
removes any pre-existing ready label and requires fresh assessment. Successful merges get a dynamically created
`automatically-merged` label. See the root README for failure behavior and setup details.

## Configuration

Global `~/.config/pr-monitor/config.json` supplies defaults. A trusted project then uses repository
`.pr-monitor.json`, `${CONFIG_DIR_NAME}/pr-monitor.json` (`.pi` in Pi and `.omp` in OMP), then
`.opencode/pr-monitor.json`. Pi ignores all project-local monitor config until
the project is trusted. Available settings:

- `debounceMinutes`, `maxCiWaitMinutes`, and `pollIntervalSeconds`
- `ignoreCommentTag` (mandatory agent-reply prefix; default `<!-- pr-monitor:reply -->`)
- `announceOnStart` and `flushOnCiFailure`
- `readyLabel` and `autoMerge`

See the [repository README](https://github.com/sesori-ai/pr-monitor-plugin#readme)
for action semantics, defaults, and development/release instructions. Durable behavior and artifact checks are in
the repository's [regression catalog](https://github.com/sesori-ai/pr-monitor-plugin/tree/main/docs/regression):
`pull-request-monitoring.md` and `plugin-installation.md`.

## License

MIT
