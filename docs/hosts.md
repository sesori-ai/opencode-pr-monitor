# Host guide

[← README](../README.md)

Install steps for every host are in the [README](../README.md#install). This page covers what is different once the
plugin is running: how reports reach the agent, when monitors stop, and what to check when something is off.

## At a glance

| Host | How reports arrive | What stops a monitor |
|---|---|---|
| OpenCode | Pushed into the owning session | PR done, session deleted, OpenCode restart |
| Claude Code | Pushed over the session's messaging socket, hooks as fallback | PR done, quitting Claude Code, MCP reload |
| Codex | Spooled and injected by trusted hooks, per conversation | PR done, Codex restart |
| Pi | Native custom message that can start a turn | PR done, successful session new/resume/fork/reload |
| Oh My Pi | Native custom message that can start a turn | PR done, successful session switch |
| DeepSeek Harness | Native steer into the exact root Agent | PR done, Agent disposal, bundle unload, host quit |
| Hermes | Background turn in the original Desktop/TUI conversation | PR done, conversation reset, host quit |

"PR done" means merged or closed. On every host, monitors live in memory and need starting again after the host
restarts.

## OpenCode

Reports are pushed straight into the session that started the monitor. Deleting that session stops its monitors.
When OpenCode shuts down cleanly, each session with a monitor gets a short "Monitor stopped" notice.

The package includes one `monitor-pr` skill, so the agent knows when to start a monitor and what to do with each
report. Package details: [`opencode/README.md`](../opencode/README.md).

## Claude Code

### How reports arrive

Current Claude Code versions expose a local messaging socket. PR Monitor pushes each report through it as a message
in the owning conversation. If the agent is idle, the report starts a new turn. If it is busy, the report shows up
mid-turn. The agent just ends its turn and waits. No sleeping or polling needed.

### Without the socket

If the socket is not available (older Claude Code versions), reports are written to a spool and the plugin's hooks
inject them:

- `PostToolUse` adds a report after a tool call;
- `UserPromptSubmit` adds one with your next prompt; and
- `Stop` makes sure a pending report is not skipped.

While a PR is not yet ready, the `Stop` hook may hand the agent the exact `claude-codex/hooks/await-activity.mjs`
command to run. That is the only waiting command the agent is allowed to use. Two settings control this fallback:
`keepAliveMaxMinutes` caps how long it waits and `keepAlive: false` turns it off. Hosts with the socket ignore both.

`desktopNotifications: true` is separate from the fallback and is not tied to the socket. It makes a best-effort
attempt to show an OS notification whenever a report is delivered or queued, using `osascript` on macOS and
`notify-send` on Linux. If that tool is missing or fails, nothing is shown and no error is reported.

### Lifecycle

Monitors belong to the Claude Code process. They survive `/clear`, but not quitting Claude Code or resuming the
conversation in a new process. Reloading the MCP server stops running monitors and says so.

## Codex

Codex uses the same plugin as Claude Code, started in Codex mode by its own manifest. Use the `pr_monitor` tool
directly; the Claude Code slash commands are not available.

### Trusting the hooks

Installing or enabling the plugin does not trust its hooks, and monitoring cannot start until Codex has run a
trusted registration hook for your conversation:

1. Open `codex` in a terminal as the same OS user and with the same `CODEX_HOME` as the CLI or app-server you use.
2. Run `/hooks`. Review and trust all four `pr-monitor@sesori` entries: `SessionStart`, `UserPromptSubmit`,
   `PostToolUse`, and `Stop`.
3. Go back to your conversation, send a new prompt, then start monitoring.

`/hooks` is a Codex CLI screen, not a PR Monitor command. If you use Codex through Sesori or another app-server
client, run it on the machine that hosts the app-server, not on the phone or laptop showing the conversation. Trust
is saved in that Codex configuration. After a plugin update, changed hooks may need trusting again.

### If monitoring says the hook has not registered the conversation

- Open `/hooks` and look for disabled or untrusted PR Monitor entries.
- Check that the CLI and app-server use the same user, `CODEX_HOME`, and plugin installation.
- Check that `features.hooks` is not `false` and that Node.js is on the app-server's `PATH`.
- Send a new prompt after fixing things. If the client has not noticed the change, reopen the conversation.

Codex's own documentation: [Review and trust hooks](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

### How reports arrive

Codex has no messaging socket. Reports are tied to your conversation's thread ID and delivered from a spool by the
trusted hooks. The keep-alive waiter runs only until the ready handoff. After that, feedback or merge/close reports
wait in the queue until your next prompt or hook event. Desktop notifications can tell you something is waiting but
cannot start a turn.

## Pi

Reports use Pi's native custom-message steering and can start a turn when the agent is idle. Pi finds one extension
and one `monitor-pr` skill in the package manifest.

A successful new, resume, fork, or reload stops the old monitors. A canceled one keeps them. Package details:
[`pi/README.md`](../pi/README.md).

## Oh My Pi (OMP)

OMP installs the same package and picks its compatibility entry automatically. Reports use the same native
custom-message delivery, and the same skill is discovered.

A successful session switch stops the old monitors. A canceled switch keeps them. Package details:
[`pi/README.md`](../pi/README.md).

## DeepSeek Harness

DeepSeek Harness support targets its long-lived Web profile. Every root Agent receives its own tool and monitor
registry. Reports use native `agent.steer(...)` delivery: an idle conversation starts a turn, while a busy one gets
the report at its next step boundary. Exact Agent identity keeps other conversations and replacement Agents with a
reused session ID from receiving those reports. A replacement's tool appears only after the prior runtime's
in-flight startup or watched/standalone readiness mutation cleanup drains.

Disposing the Agent, unloading the bundle, or stopping Harness cancels its monitors. They are not restored when a
persisted conversation resumes in another process. Harness's bundled skill catalog is host-global, so a delegated
child may discover `monitor-pr` without receiving the root-only tool. The skill tells it to return the PR target and
monitoring request to its parent/root instead of trying to poll or wait itself.

Harness exposes no project-trust signal to Cordis plugins. PR Monitor therefore ignores repository config files and
invoking-project `.env` values. It reads user-global configuration and accepts the auto-merge environment override
only from the inherited process or Harness-home user environment. Package details:
[`deepseek/README.md`](../deepseek/README.md).

## Hermes

Background monitoring works in Hermes Desktop and TUI with the default `dashboard.turn_isolation: false`. Reports
stay in the conversation that started the monitor: an idle conversation starts a turn, a busy one is steered.
Switching tabs does not redirect them.

The Hermes CLI, messaging gateways, ACP clients (including Hermes through Sesori), and Desktop with
`dashboard.turn_isolation: true` cannot safely route a future report back to the original conversation, so `start`
fails there with a clear message. `mark_ready` and `unmark_ready` work on every Hermes host.

Each conversation gets its own Node worker. Monitors stop when the conversation is reset or finalized, the plugin is
unloaded, or the host quits. Full details: [`hermes/README.md`](../hermes/README.md).
