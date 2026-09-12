# PR Monitor for Hermes

Watches your GitHub pull requests and posts `[PR Monitor]` status reports into the Hermes conversation that started
the monitor. It also manages the ready-for-human-review label.

## Install

```sh
hermes plugins install sesori-ai/pr-monitor-plugin/hermes
hermes plugins enable pr-monitor
```

Then:

- Restart Hermes Desktop's gateway and start or resume a conversation. On other Hermes hosts, where only the manual
  ready actions are available, restart that host after enabling the plugin.
- Make sure Node.js 18+ and a logged-in GitHub CLI (`gh auth status`) are on the **Hermes backend's** `PATH`.
- If your profile uses an explicit toolset allow-list, add the `pr-monitor` toolset.

No npm install or build step is needed. The worker, tool schema, and skill ship inside the plugin.

## Use

Ask Hermes to monitor `owner/repo#123`, or open a PR and let the bundled `monitor-pr` skill start the monitor for
you. The tool offers `start`, `stop`, `status`, `flush`, `mark_ready`, and `unmark_ready`. To read the workflow the
agent follows, run `skill_view(name="pr-monitor:monitor-pr")`. While a monitor runs, the agent ends its turn and
lets PR Monitor do the polling.

## Where it works

- **Hermes Desktop and TUI** with the default `dashboard.turn_isolation: false`: full background monitoring. Reports
  go into the original conversation. An idle conversation starts a turn; a busy one takes the report as a redirect,
  or as a steer during tool execution. Switching tabs does not change where reports go, and anything you are typing
  is kept. Merge and close reports use the same path, even after the ready handoff.
- **Hermes CLI, messaging gateways, ACP (including Hermes through Sesori), and Desktop with
  `dashboard.turn_isolation: true`**: background monitoring is not available, and `start` says so. These hosts
  cannot bind a future report to the original conversation, so a switched or reset conversation could receive
  another conversation's report.
- **Manual ready actions work everywhere.** `mark_ready` and `unmark_ready` need neither a delivery route nor a
  running monitor. A short-lived worker does the job and exits. If the Desktop conversation already has a worker,
  the action reuses it and its settings.

## Lifecycle

Each conversation gets its own Node worker. Monitors stop when the conversation is finalized or reset, the plugin is
unloaded, the host quits, or the worker fails. Finishing a turn does not stop them. Nothing survives a host restart,
so ask Hermes to start monitors again afterwards.

## Configuration

Global settings come from `~/.config/pr-monitor/config.json`. Project settings are read from the conversation's
working directory: `.pr-monitor.json`, then `.hermes/pr-monitor.json`, then `.opencode/pr-monitor.json`.

To merge ready PRs automatically, set `autoMerge: true` in the global file or a trusted project file. Project config
overrides global config, and an explicit `SESORI_PR_MONITOR_AUTO_MERGE` environment value overrides both. With
auto-merge on, starting a monitor removes any ready label that is already there and asks the agent to reassess.
Merged PRs get an `automatically-merged` label. Read
[configuration and auto-merge safety](../docs/configuration.md#auto-merge) before turning it on.

## Compatibility notes

Hermes's public Python `inject_message` API does not cover Desktop/TUI yet. `desktop.py` is a small compatibility
adapter over the live TUI gateway's session registry, transport binding, and synchronous background-turn admission.
It checks that the live record belongs to the tool's conversation, never starts another gateway, and never resumes a
closed chat. Hosts without these interfaces fail with a clear error. A model-driven smoke test passed through the
Desktop gateway with simulated GitHub data. Real GitHub and further host and platform checks are tracked in the
[regression matrix](https://github.com/sesori-ai/pr-monitor-plugin/blob/main/docs/regression/hermes.md).

The contract was inspected at Hermes commit
[`9a84bee265da`](https://github.com/NousResearch/hermes-agent/commit/9a84bee265daad14340a80d7585928cd8ea1f9eb).

## Development

Run `npm run build:hermes` from the repository root and commit the regenerated `hermes/dist/` and `hermes/skills/`
with your source changes. `npm test` includes the Python adapter contracts and needs Python 3.10+. At runtime, Python
comes from Hermes.
