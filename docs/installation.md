# Installation and host behavior

[← README](../README.md)

PR Monitor supports six agent hosts through four adapters. Pick the host below, complete its setup, then verify that
its agent can see the `pr_monitor` tool.

## Choose a host

| Host | Minimums | Integration |
|---|---|---|
| [OpenCode](#opencode) | OpenCode 1.17+ | `@sesori/pr-monitor-opencode` npm plugin |
| [Claude Code](#claude-code) | Node.js 18+, macOS or Linux | `pr-monitor@sesori` Git plugin |
| [Codex](#codex) | Codex 0.153+, Node.js 18+, macOS or Linux | Same Git plugin, Codex manifest |
| [Pi](#pi) | Pi 0.84.2+, Node.js 22.19+ | `@sesori/pr-monitor-pi` npm package |
| [Oh My Pi](#oh-my-pi-omp) | OMP 18.0.3+ | Shared Pi/OMP npm package |
| [Hermes](#hermes) | Node.js 18+ on backend `PATH` | Python Git plugin with bundled Node worker |

## Common setup

Every host needs [GitHub CLI](https://cli.github.com) installed and authenticated as the account that should inspect
and label pull requests:

```sh
gh auth status
```

The account also needs permission to read the target repository. Auto-merge additionally requires merge permission.

## OpenCode

Add the package to project `opencode.json`, or to global `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@sesori/pr-monitor-opencode"]
}
```

OpenCode installs npm plugins into its package cache at startup. Pin `@sesori/pr-monitor-opencode@X.Y.Z` when you
want deliberate upgrades. Restart OpenCode after changing plugin configuration.

Reports are pushed into the session that started the monitor. Deleting that session stops its watches. Graceful
OpenCode shutdown persists a no-reply stop notice into each owning session. The package also injects one
`monitor-pr` skill so the agent learns when to start a watch and how to handle reports.

Package details: [`opencode/README.md`](../opencode/README.md).

## Claude Code

Install from the Git marketplace inside Claude Code:

```text
/plugin marketplace add sesori-ai/pr-monitor-plugin
/plugin install pr-monitor@sesori
```

The plugin registers `pr_monitor`, a `monitor-pr` workflow skill, and four convenience commands:

- `/pr-monitor:watch [owner/repo#123 | PR URL]`
- `/pr-monitor:status`
- `/pr-monitor:ready [owner/repo#123 | PR URL]`
- `/pr-monitor:unready [owner/repo#123 | PR URL]`

### Delivery

Current Claude Code versions expose a local messaging socket. PR Monitor pushes reports into the owning
conversation, starts a turn when idle, and steers an active turn when busy. The agent should end its turn while
waiting; it never needs a sleep or polling command.

If the socket is unavailable, the plugin falls back to its report spool and these hooks:

- `PostToolUse` injects a report after a tool call.
- `UserPromptSubmit` injects one with the next prompt.
- `Stop` prevents a pending report from being skipped.

On fallback hosts, `Stop` may provide the exact `claude-codex/hooks/await-activity.mjs` command while a PR is not
ready. That command is the only supported waiter. `keepAliveMaxMinutes` bounds idle waiting, `keepAlive: false`
disables it, and `desktopNotifications: true` can announce queued reports. Push-capable hosts do not use this loop.

Watches belong to the Claude Code process. They survive `/clear`, but not quitting Claude Code or resuming in a new
process. Reloading the MCP server stops existing watches with a notice.

## Codex

Install from the Codex marketplace:

```sh
codex plugin marketplace add sesori-ai/pr-monitor-plugin
codex plugin add pr-monitor@sesori
```

Codex uses the same plugin root as Claude Code, but its own manifest starts the MCP server in Codex mode. Use the
`pr_monitor` tool directly; Claude Code slash commands are not available.

### Trust the delivery hooks

> Installing or enabling the plugin does not trust its hooks. Monitoring cannot start until Codex has run a trusted
> registration hook for that conversation.

1. Open `codex` in a terminal as the same OS user and with the same `CODEX_HOME` as the target CLI or app-server.
2. Run `/hooks`. Review and trust all four entries from `pr-monitor@sesori`: `SessionStart`, `UserPromptSubmit`,
   `PostToolUse`, and `Stop`.
3. Return to the original conversation, send a new prompt, then start monitoring.

For Sesori and other app-server clients, `/hooks` is a Codex CLI screen—not a PR Monitor command. Run it on the
machine hosting the Codex app-server, not the phone or laptop displaying the conversation. Hook trust persists in
that Codex configuration. Changed hooks may require review again after a plugin update.

If monitoring says the delivery hook has not registered the conversation:

- check `/hooks` for disabled or untrusted PR Monitor entries;
- verify the CLI and app-server use the same user, `CODEX_HOME`, and plugin installation;
- verify `features.hooks` is not `false` and Node.js is on the app-server's `PATH`; and
- send a new prompt after fixing setup, or reopen the conversation if the client has not picked up the change.

Codex has no messaging socket. Reports are conversation-scoped by thread ID and delivered through the spool and
trusted hooks. The keep-alive waiter operates only until readiness handoff. Feedback or merge/close events arriving
after handoff remain queued until that conversation's next prompt or hook event; desktop notifications can announce
that queue but cannot start a turn.

See [Codex hook trust documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

## Pi

Install the shared package:

```sh
pi install npm:@sesori/pr-monitor-pi
```

Pi discovers one extension and one `monitor-pr` skill from the package manifest. Reports use native custom-message
steering and can start an idle turn. Successful new/resume/fork/reload transitions stop old watches; canceled
transitions retain them.

Package details: [`pi/README.md`](../pi/README.md).

## Oh My Pi (OMP)

Install the same package through OMP:

```sh
omp plugin install @sesori/pr-monitor-pi
```

OMP selects its thin compatibility entry automatically, discovers the same workflow skill, and uses native
custom-message delivery. Successful session switches stop old watches; canceled switches retain them.

Package details: [`pi/README.md`](../pi/README.md).

## Hermes

Install and enable the Hermes Git plugin:

```sh
hermes plugins install sesori-ai/pr-monitor-plugin/hermes
hermes plugins enable pr-monitor
```

Restart the Hermes host after enabling it. Node.js 18+ and authenticated `gh` must be on the **backend** `PATH`. If
the profile has an explicit tool allow-list, enable the `pr-monitor` toolset.

Background monitoring is supported for Hermes Desktop/TUI with default `dashboard.turn_isolation: false`. Reports
stay bound to the original conversation, start an idle turn, or steer a busy turn. Switching tabs does not retarget
them.

Hermes CLI, messaging gateways, ACP—including Hermes through Sesori—and isolated Desktop turns cannot safely bind
future reports to the original durable conversation, so `start` fails explicitly there. Standalone `mark_ready` and
`unmark_ready` remain available on every Hermes host.

Full compatibility and lifecycle details: [`hermes/README.md`](../hermes/README.md).

## Verify installation

Start or resume a conversation in the configured host and ask it to list PR monitors. The tool should confirm that
no monitor is active. Most adapters say `No active monitors in this session.`; Hermes identifies the owning
conversation explicitly.

Then monitor a real PR explicitly:

```text
pr_monitor(action: "start", pr: "owner/repo#123")
```

The result identifies delivery behavior, lifecycle, configuration, and the required prefix for agent-authored
GitHub replies. Continue with the [configuration guide](configuration.md) if defaults need changing.
