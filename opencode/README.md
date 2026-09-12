# @sesori/pr-monitor-opencode

OpenCode plugin that watches GitHub pull requests, manages ready-for-human-review state, and delivers `[PR Monitor]`
reports to the session that started each watch.

## Install

Add the package to project or global `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@sesori/pr-monitor-opencode"]
}
```

Requirements: OpenCode 1.17 or newer, plus an installed and authenticated GitHub CLI (`gh auth status`).

## Behavior

The plugin registers `pr_monitor` actions for `start`, `stop`, `flush`, `status`, `mark_ready`, and `unmark_ready`.
It also injects one packaged `monitor-pr` skill through OpenCode's configured skill paths, so consuming repositories
do not need their own copy. The skill tells the agent to start monitoring after opening a PR, handle every automatic
report, use prefixed GitHub replies as acknowledgement evidence, and end the turn instead of creating a second wait
mechanism.

The monitor reports commits, CI, reviews/comments, conflicts, and terminal state. It automatically adds readiness
when the current head is clean and feedback is acknowledged, then withdraws it on later commits or relevant feedback.
Every report states readiness and contains no comment bodies.

The monitor owns all polling and notifications arrive automatically. Agents must never create sleeps, scheduled
checks, background polling loops, repeated `gh pr checks`, or routine `status`/`flush` calls while waiting.

Monitors are in memory, belong to the OpenCode session that started them, stop on merge/close or session deletion,
and do not survive an OpenCode restart.

Set `autoMerge: true` in global `~/.config/pr-monitor/config.json` or trusted project config to make automatic
readiness and `mark_ready` perform one head-fenced, title-only squash merge. Project config overrides global config;
an explicit `SESORI_PR_MONITOR_AUTO_MERGE` environment value overrides both. With auto-merge enabled, startup
removes any pre-existing ready label and requires fresh assessment. Successful merges get a dynamically created
`automatically-merged` label. See the root README for failure behavior and setup details.

## Configuration

Global `~/.config/pr-monitor/config.json` supplies defaults beneath repository `.pr-monitor.json`;
`.opencode/pr-monitor.json` remains a project fallback. Available settings:

- `debounceMinutes`, `maxCiWaitMinutes`, and `pollIntervalSeconds`
- `ignoreCommentTag` (mandatory agent-reply prefix; default `<!-- pr-monitor:reply -->`)
- `announceOnStart` and `flushOnCiFailure`
- `readyLabel` and `autoMerge`

See the [repository README](https://github.com/sesori-ai/pr-monitor-plugin#readme) for action semantics, defaults,
configuration examples, and development/release instructions. Durable behavior and artifact checks are cataloged in
the repository's [regression catalog](https://github.com/sesori-ai/pr-monitor-plugin/tree/main/docs/regression):
`pull-request-monitoring.md` and `plugin-installation.md`.

## License

MIT
