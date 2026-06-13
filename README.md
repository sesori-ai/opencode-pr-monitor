# opencode-pr-monitor

An [opencode](https://opencode.ai) plugin that watches GitHub pull requests in the background and delivers factual `[PR Monitor]` reports into the session that started the watch — so an agent (or you) can raise a PR, keep working, and get told when something actually happened.

## What it does

- Polls GitHub via `gh api graphql` (one query per watched PR per tick).
- Detects: CI suite conclusions, new reviews, new inline/issue comments, unresolved-thread count changes, mergeability changes, merge/close.
- Aggregates activity with a **rolling debounce**: any new activity resets a quiet timer; a report is delivered only after the PR has been quiet for the configured window.
- **CI hold**: a due report is held while a check suite is still running (bounded by `maxCiWaitMinutes`), so you get one report with the CI verdict instead of two.
- Reports are **facts only** — counts, authors, check names. No advice, no comment bodies.
- Monitors are **per-session and in-memory**: they stop automatically when the PR is merged/closed or the owning session is deleted, and they do not survive an opencode restart.

### Example report

```
[PR Monitor] sesori-ai/example#42 — "feat: add relay reconnect backoff" (https://github.com/sesori-ai/example/pull/42)
- CI: failing (1/8 failed: analyze)
- Mergeable: MERGEABLE
- Reviews: alice ✓ approved · bob ⏳ pending
- [comment:inline] 3 unresolved threads (2 new since last flush: 2 coderabbitai[bot])
- [comment:issue] 5 total (1 new since last flush: 1 alice)
```

## Requirements

- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated (`gh auth status`).
- opencode >= 1.17.

## Install

Add the plugin to your project's `opencode.json` (committed — the whole team gets it) or to your global `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["github:sesori-ai/opencode-pr-monitor#v0.1.1"]
}
```

opencode installs git-spec plugins into its package cache on startup. Pin a tag and bump it explicitly to pick up new versions.

## Usage

The plugin registers a single `pr_monitor` tool:

| Action   | `pr` argument                          | Effect |
| -------- | -------------------------------------- | ------ |
| `start`  | `owner/repo#123` or full PR URL        | Begin watching. The repo must be explicit — no cwd inference. |
| `stop`   | PR identifier or `all`                 | Stop watching. |
| `flush`  | PR identifier or `all`                 | Immediately return a full status report and reset the "new since" baseline. |
| `status` | —                                      | List this session's active monitors. |

Reports arrive in the owning session as messages starting with `[PR Monitor]`.

## Configuration

Optional, per project: `.opencode/pr-monitor.json` (looked up in the project directory, then the worktree root).

```json
{
  "debounceMinutes": 5,
  "maxCiWaitMinutes": 30,
  "pollIntervalSeconds": 60,
  "ignoreCommentTag": "<!-- pr-monitor:ignore -->"
}
```

| Key                   | Default | Meaning |
| --------------------- | ------- | ------- |
| `debounceMinutes`     | `5`     | Quiet window after the last detected activity before a report is delivered. Rolling — new activity resets it. |
| `maxCiWaitMinutes`    | `30`    | Upper bound on holding a due report while CI is still running. After this, the report is force-flushed naming unfinished checks. |
| `pollIntervalSeconds` | `60`    | GitHub poll interval per watched PR (minimum 30). |
| `ignoreCommentTag`    | unset   | If set, comments authored by the authenticated `gh` user that contain this tag are invisible to the monitor — useful so an agent replying to review threads doesn't trigger its own reports. |

## Behavior details

- **Activity** = state/mergeability changes, review changes, unresolved-thread count changes, new comments, and CI *suite conclusions*. Transitions into "running" (a new push) and per-check progress are intentionally not activity.
- **"New since last flush"** counts comments created after the watch's baseline, which advances on every delivered report or manual `flush`.
- **Failure handling**: 10 consecutive poll failures (or report-delivery failures) stop the monitor with a notice. A deleted/inaccessible PR stops it immediately.
- **Terminal states**: a report describing a merged/closed PR is delivered, then the monitor stops itself.

## Development

```sh
npm install
npm run typecheck
```

The entry point is `src/index.ts`; opencode executes TypeScript directly (no build step). The opencode plugin loader invokes every export of the entry module as a plugin, so `PrMonitorPlugin` must remain its sole export.

## License

[MIT](LICENSE)
