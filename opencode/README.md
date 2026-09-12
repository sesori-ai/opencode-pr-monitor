# @sesori/pr-monitor-opencode

OpenCode plugin that watches your GitHub pull requests and posts `[PR Monitor]` status reports back into the session
that opened them. It also manages the ready-for-human-review label.

## Install

Needs OpenCode 1.17 or newer and a logged-in GitHub CLI (`gh auth status`).

Add the plugin to your project `opencode.json`, or to `~/.config/opencode/opencode.json` for every project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@sesori/pr-monitor-opencode"]
}
```

Restart OpenCode and you are done.

## What it does

The plugin adds a `pr_monitor` tool with `start`, `stop`, `flush`, `status`, `mark_ready`, and `unmark_ready`
actions, plus one `monitor-pr` skill. The skill tells the agent to start a monitor after opening a PR, act on every
report, mark its GitHub replies with the reply prefix so the monitor can recognise them, and end its turn instead of
polling on its own. Your repositories do not need their own copy of the skill.

Reports cover new commits, CI, reviews and comments, merge conflicts, and the PR merging or closing. Each one says
whether the PR is ready for human review and never quotes comment bodies. When CI is green, the PR is mergeable, and
all feedback has been answered, the monitor adds the ready label. A new commit or new feedback removes it again.

The monitor owns the waiting. Agents should not sleep, schedule checks, poll in the background, run `gh pr checks`
repeatedly, or call `status` and `flush` in a loop. Reports arrive on their own.

Monitors live in memory and belong to the OpenCode session that started them. They stop when the PR merges or closes
or the session is deleted, and they do not survive an OpenCode restart.

## Configuration

Global settings live in `~/.config/pr-monitor/config.json`. A repository can override them in `.pr-monitor.json` or
`.opencode/pr-monitor.json`. Settings:

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
