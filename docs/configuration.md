# Configuration

[← README](../README.md)

You do not need a config file. The defaults work out of the box. When you want to change something, put personal
preferences in a global file and repository-specific settings in a project file.

## Where config lives

**Global** settings apply to every host and every repository:

```text
~/.config/pr-monitor/config.json
```

If `XDG_CONFIG_HOME` is set to an absolute path, the file is `$XDG_CONFIG_HOME/pr-monitor/config.json` instead. A
relative `XDG_CONFIG_HOME` is ignored.

**Project** settings live in the repository. Each host checks a few paths and uses the first one that parses:

| Host | Project files, in order |
|---|---|
| OpenCode | `.pr-monitor.json`, then `.opencode/pr-monitor.json` |
| Claude Code | `.pr-monitor.json`, then `.claude/pr-monitor.json`, then `.opencode/pr-monitor.json` |
| Codex | `.pr-monitor.json`, then `.codex/pr-monitor.json`, then `.opencode/pr-monitor.json` |
| Pi | `.pr-monitor.json`, then `.pi/pr-monitor.json`, then `.opencode/pr-monitor.json` |
| OMP | `.pr-monitor.json`, then `.omp/pr-monitor.json`, then `.opencode/pr-monitor.json` |
| Hermes | `.pr-monitor.json`, then `.hermes/pr-monitor.json`, then `.opencode/pr-monitor.json` |

Pi and OMP only read project files once you have trusted the project. Global config is always read.

### How settings combine

Later layers override earlier ones:

1. built-in defaults;
2. the global file;
3. the first project file that parses; and
4. the `SESORI_PR_MONITOR_AUTO_MERGE` environment variable, which affects `autoMerge` only.

A project file only replaces the keys it sets. Unknown keys are ignored. An invalid value keeps the value from the
layer below. A file that is not valid JSON is logged and skipped, and the next candidate is tried.

Settings are read each time a monitor starts or a standalone ready action runs. A monitor that is already running
keeps the settings it started with.

> A project file can turn on auto-merge. In a repository you do not trust, check its config before starting a
> monitor with a GitHub account that is allowed to merge.

## All settings

Every key with its default value:

```json
{
  "debounceMinutes": 2,
  "maxCiWaitMinutes": 30,
  "pollIntervalSeconds": 60,
  "ignoreCommentTag": "<!-- pr-monitor:reply -->",
  "announceOnStart": true,
  "flushOnCiFailure": true,
  "desktopNotifications": false,
  "readyLabel": "ready-for-human-review",
  "autoMerge": false,
  "keepAlive": true,
  "keepAliveMaxMinutes": 120
}
```

### Reporting

| Key | Default | What it does |
|---|---:|---|
| `debounceMinutes` | `2` | How long the PR must stay quiet before a batched report goes out. New activity restarts the timer. |
| `maxCiWaitMinutes` | `30` | How long a due report may wait for running CI to finish. |
| `pollIntervalSeconds` | `60` | How often each PR is polled. Clamped between 30 seconds and 24 hours. |
| `announceOnStart` | `true` | Send a full status report as soon as a monitor starts. |
| `flushOnCiFailure` | `true` | Report a newly failing check right away instead of batching it. |

When `maxCiWaitMinutes` runs out, the report goes out anyway and names the checks still running. A check that newly
fails is reported right away only once per commit. Later failures on the same commit ride along with the normal
report instead of each sending their own.

### Feedback and readiness

| Key | Default | What it does |
|---|---:|---|
| `ignoreCommentTag` | `<!-- pr-monitor:reply -->` | The prefix every agent-written GitHub reply must start with. |
| `readyLabel` | `ready-for-human-review` | The label added when a PR is ready and removed when it is not. |
| `autoMerge` | `false` | Make one squash-merge attempt after PR Monitor marks the PR ready itself. See [auto-merge](#auto-merge). |

The reply prefix has to be the very first text in a comment from the monitoring account. A comment without it
counts as human feedback. Comments with it do not count as new activity, but they do count as proof that feedback
was answered.

### Claude Code and Codex only

Only the shared Claude Code and Codex adapter reads these:

| Key | Default | What it does |
|---|---:|---|
| `desktopNotifications` | `false` | Show an OS notification when a report is delivered or queued. |
| `keepAlive` | `true` | Keep the hook-based delivery loop running until the ready handoff. |
| `keepAliveMaxMinutes` | `120` | Longest quiet stretch the hook-based loop will wait. |

Claude Code sessions with a messaging socket ignore the keep-alive settings, because pushed reports already start
turns. Codex and socketless Claude Code sessions use them as described in the [host guide](hosts.md).

## Auto-merge

> **Merging cannot be undone.** Turn auto-merge on only in your personal config or in a repository you trust, using
> a GitHub account that is meant to merge that repository's pull requests.

Turn it on in the global or a project file:

```json
{
  "autoMerge": true
}
```

Or with an environment variable, which wins over both files:

- `true` or `1` turns it on;
- `false`, `0`, or an empty value turns it off; and
- anything else turns it off and logs a warning.

```sh
# Hosts started from a shell
export SESORI_PR_MONITOR_AUTO_MERGE=true

# macOS GUI apps, for this login session; restart the app afterwards
launchctl setenv SESORI_PR_MONITOR_AUTO_MERGE true
```

### When it merges

PR Monitor merges only after a readiness change it made itself:

- automatic readiness from a running monitor; or
- a successful `mark_ready`, with or without a running monitor.

Seeing a ready label that someone else added never triggers a merge. Neither does a label change that failed or
whose result is unclear.

### How it stays safe

- **Fresh look at startup.** Starting a monitor with auto-merge on removes any ready label that is already there.
  The agent has to assess the PR again before `mark_ready` can lead to a merge.
- **Same commit or no merge.** A standalone `mark_ready` notes the head commit before adding the label and checks
  it again afterwards. If the commit changed or cannot be verified, the merge is cancelled and PR Monitor tries to
  take the label off again. If that cleanup fails, the result says so and the label stays until you remove it.
- **One exact merge.** The request is pinned to the accepted commit, always squashes, uses the PR title as the
  commit title, and sends an empty commit body.
- **No blind retries.** If GitHub's answer is lost, times out, is malformed, or is a server error, PR Monitor asks
  GitHub once whether the PR merged at that commit. If it did, that is success. If not, the outcome stays unknown
  and nothing is retried.
- **Clear rejections stay clear.** A GitHub 4xx rejection is reported with its reason. A 409 means the accepted
  commit is no longer valid.
- **No retry while nothing changed.** A rejected or unknown merge keeps the ready label and is not retried until
  readiness changes again or someone calls `mark_ready`.
- **A marker on success.** A confirmed merge gets a blue `automatically-merged` label, created on the fly if needed.
  If adding the label fails, that is reported as a warning. The merge itself is already done.

See [how the monitor decides](behavior.md) for readiness and feedback rules.
