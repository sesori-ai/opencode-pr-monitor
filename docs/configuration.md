# Configuration

[← README](../README.md)

Defaults work without a config file. Add global configuration for personal preferences or project configuration for
repository-specific behavior.

## Locations and precedence

Global configuration applies to every host:

```text
~/.config/pr-monitor/config.json
```

If `XDG_CONFIG_HOME` is an absolute path, PR Monitor uses
`$XDG_CONFIG_HOME/pr-monitor/config.json` instead. Relative `XDG_CONFIG_HOME` values are ignored.

Project paths are checked in order. The first successfully parsed project file is used; unreadable files are skipped,
and malformed JSON is logged before checking the next candidate:

| Host | Project configuration search order |
|---|---|
| OpenCode | `.pr-monitor.json` → `.opencode/pr-monitor.json` |
| Claude Code | `.pr-monitor.json` → `.claude/pr-monitor.json` → `.opencode/pr-monitor.json` |
| Codex | `.pr-monitor.json` → `.codex/pr-monitor.json` → `.opencode/pr-monitor.json` |
| Pi | `.pr-monitor.json` → `.pi/pr-monitor.json` → `.opencode/pr-monitor.json` |
| OMP | `.pr-monitor.json` → `.omp/pr-monitor.json` → `.opencode/pr-monitor.json` |
| Hermes | `.pr-monitor.json` → `.hermes/pr-monitor.json` → `.opencode/pr-monitor.json` |

Pi reads project-local configuration only after project trust. Global configuration remains available before trust.

Values resolve in this order:

1. built-in defaults;
2. global configuration;
3. first successfully parsed project configuration; then
4. explicit `SESORI_PR_MONITOR_AUTO_MERGE` environment override for `autoMerge` only.

Valid project values replace matching global values. Unknown keys are ignored. Invalid values in valid JSON leave
the lower layer unchanged; malformed JSON is logged and skipped. Configuration is loaded for each new watch and
standalone ready action. An
active watch keeps the values captured when it started.

> Project configuration can enable auto-merge. Review configuration in untrusted repositories before starting a
> monitor with a GitHub account that can merge.

## Complete example

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

## Settings

### Reporting

| Key | Default | Purpose |
|---|---:|---|
| `debounceMinutes` | `2` | Quiet window after ordinary activity. New activity resets it. |
| `maxCiWaitMinutes` | `30` | Maximum hold for a due report while CI remains running. |
| `pollIntervalSeconds` | `60` | Poll interval per PR, clamped from 30 seconds to 24 hours. |
| `announceOnStart` | `true` | Send a full initial status report when a watch starts. |
| `flushOnCiFailure` | `true` | Report the first new failure per head immediately instead of debouncing. |

`maxCiWaitMinutes` limits idle waiting for CI; after the limit, the report names unfinished checks. Later failures on
the same head ride with the suite-conclusion report instead of creating one notification per matrix job.

### Feedback and readiness

| Key | Default | Purpose |
|---|---:|---|
| `ignoreCommentTag` | `<!-- pr-monitor:reply -->` | Required prefix for agent-authored GitHub replies. |
| `readyLabel` | `ready-for-human-review` | Label managed by automatic readiness and ready actions. |
| `autoMerge` | `false` | Attempt one safe squash merge after monitor-owned readiness. |

The reply prefix must be the first text in a local-account comment. A local comment without it is treated as human
feedback. Prefixed replies do not count as new relevant comments, but they remain acknowledgement evidence.

### Claude Code and Codex delivery

These keys are read only by the shared Claude Code/Codex adapter:

| Key | Default | Purpose |
|---|---:|---|
| `desktopNotifications` | `false` | Show an OS notification when a report is delivered or spooled. |
| `keepAlive` | `true` | Keep fallback hook delivery active until readiness handoff. |
| `keepAliveMaxMinutes` | `120` | Maximum quiet time for the fallback keep-alive loop. |

Push-capable Claude Code sessions ignore keep-alive settings because incoming reports already start turns. Codex
and socketless Claude Code sessions use them as described in the [installation guide](installation.md).

## Auto-merge

> **Warning:** merging is irreversible. Enable auto-merge only in personal configuration or a trusted repository
> whose authenticated GitHub account should be allowed to merge its pull requests.

Enable it in global or project configuration:

```json
{
  "autoMerge": true
}
```

An explicitly defined environment value overrides both files:

- `true` or `1` enables auto-merge;
- `false`, `0`, or an empty value disables it; and
- any other value fails closed, disables it, and logs a warning.

```sh
# Shell-launched hosts
export SESORI_PR_MONITOR_AUTO_MERGE=true

# macOS GUI hosts for this login session; restart the app afterward
launchctl setenv SESORI_PR_MONITOR_AUTO_MERGE true
```

### What triggers a merge

Only a completed readiness transition owned by PR Monitor authorizes a merge:

- automatic readiness from an active watch; or
- a successful watched or standalone `mark_ready` action.

Observing a label added externally does not trigger a merge. A failed or ambiguous label mutation does not trigger
one either.

### Safety guarantees

- **Fresh startup assessment.** Starting a monitor with auto-merge enabled removes a pre-existing ready label and
  requires fresh agent assessment before `mark_ready` can authorize a merge.
- **Head fencing.** Standalone `mark_ready` captures the head before adding readiness and checks it again afterward.
  A changed or unverifiable head cancels the merge and attempts to withdraw readiness.
- **One exact merge.** The request is fenced to the accepted head SHA, always uses squash mode, uses the PR title as
  the commit title, and sends an explicitly empty commit-message body.
- **No blind replay.** After an ambiguous transport, timeout, malformed, or server failure, PR Monitor re-queries
  GitHub once. A merged matching head proves success; an unproven outcome remains unknown without retrying.
- **Definitive failures stay definitive.** GitHub 4xx rejection reasons are reported directly. HTTP 409 invalidates
  the accepted head.
- **No unchanged retry.** Rejected or unknown outcomes keep readiness in place and are not retried automatically
  while that readiness state remains unchanged. A later readiness transition or explicit `mark_ready` is a new
  attempt.
- **Merge marker.** Confirmed success dynamically creates and applies the blue `automatically-merged` label. Marker
  failure is reported as a warning but cannot undo the merge.

See [monitor behavior](behavior.md) for readiness and feedback semantics.
