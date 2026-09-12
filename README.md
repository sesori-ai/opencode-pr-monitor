# PR Monitor

Keep a coding agent responsible for its pull request after the PR opens. PR Monitor watches GitHub, sends factual
`[PR Monitor]` updates back to the original agent session, and manages the ready-for-human-review handoff.

Supported hosts: **OpenCode, Claude Code, Codex, Pi, Oh My Pi (OMP), and Hermes**.

## Why use it?

- The agent sees new commits, CI results, reviews, inline threads, issue comments, conflicts, and merge/close events.
- Ordinary activity is grouped into useful reports instead of one notification per event.
- New CI failures, merge conflicts, and terminal states are reported immediately at the next poll.
- Reports contain status and authors, never comment bodies.
- Automatic readiness is added only after the current head is clean and feedback has been acknowledged.
- Monitoring stops automatically when the PR merges or closes.

## How it works

1. The agent opens a PR and starts `pr_monitor` for an explicit `owner/repo#123` target.
2. PR Monitor polls GitHub in the background. The agent ends its turn; it does not create another polling loop.
3. New activity produces a `[PR Monitor]` message in the same conversation.
4. The agent fixes CI, handles feedback, replies with the configured acknowledgement prefix, and pushes changes.
5. PR Monitor adds `ready-for-human-review` when the current head is ready, then withdraws it if new work appears.

```text
[PR Monitor] [acme/widgets#42] — "Fix reconnect backoff"
- CI: passing (5/5)
- Mergeable: MERGEABLE
- [comment:inline] ACTION REQUIRED: 1 thread received a new relevant comment
- Ready for human review: NO — feedback awaits an agent reply
```

## Choose your host

| Host | Integration | Report delivery |
|---|---|---|
| [OpenCode](docs/installation.md#opencode) | npm plugin | Native session push |
| [Claude Code](docs/installation.md#claude-code) | Git marketplace plugin | Native push, with hook/spool fallback |
| [Codex](docs/installation.md#codex) | Git marketplace plugin | Conversation-scoped hooks and spool |
| [Pi](docs/installation.md#pi) | npm package | Native custom-message push |
| [Oh My Pi](docs/installation.md#oh-my-pi-omp) | npm package | Native custom-message push |
| [Hermes](docs/installation.md#hermes) | Python Git plugin | Desktop/TUI conversation delivery |

All hosts require an installed, authenticated [GitHub CLI](https://cli.github.com):

```sh
gh auth status
```

Then follow the [installation guide](docs/installation.md) for your host. Ask the agent to monitor a PR, or call the
shared tool directly:

```text
pr_monitor(action: "start", pr: "owner/repo#123")
```

## Tool actions

Every host exposes the same six actions:

| Action | Target | Purpose |
|---|---|---|
| `start` | One explicit PR | Start monitoring and assess current status. |
| `stop` | One PR or `all` | Stop active monitoring. |
| `flush` | One PR or `all` | Return an immediate full report; not a polling mechanism. |
| `status` | None | List monitors owned by this session. |
| `mark_ready` | One explicit PR | Accept current state and add the configured ready label. |
| `unmark_ready` | One explicit PR | Remove the ready label; later clean activity may restore it. |

PR targets use `owner/repo#123` or a full GitHub pull-request URL.

## Readiness and auto-merge

Automatic readiness requires:

- green or absent CI;
- definite mergeability; and
- a prefixed local-account reply after the latest feedback in every feedback channel.

A later commit, relevant comment, CI regression, or conflict withdraws readiness. Use `mark_ready` after inspecting
non-actionable bot feedback that should not receive another reply.

Auto-merge is **off by default**. When enabled, successful automatic readiness or `mark_ready` makes one
head-fenced, title-only squash-merge attempt. Read [configuration and auto-merge
safety](docs/configuration.md#auto-merge) before enabling it.

## Important limits

- Watches are in memory and belong to the session or conversation that started them.
- Watches do not survive host restarts; restart missing watches after resuming work.
- The monitor owns waiting. Agents must not create sleeps, scheduled checks, background polling loops, repeated
  `gh pr checks`, or routine `status`/`flush` calls.
- Host delivery and lifecycle details differ. Read the matching [host guide](docs/installation.md#choose-a-host).

## Documentation

- [Installation and host behavior](docs/installation.md)
- [Configuration and auto-merge safety](docs/configuration.md)
- [Polling, reporting, feedback, and readiness](docs/behavior.md)
- [Development and releases](docs/development.md)
- [Hermes compatibility details](hermes/README.md)
- [Regression and acceptance catalog](docs/regression/README.md)
- [Changelog](CHANGELOG.md)

## Contributing

```sh
npm ci
npm run release:check
```

See [development and releases](docs/development.md) for repository layout, build artifacts, host checks, and the
release procedure.

## License

[MIT](LICENSE)
