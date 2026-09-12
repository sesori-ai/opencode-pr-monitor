# Hermes PR Monitor

Install from the repository's Hermes subdirectory:

```sh
hermes plugins install sesori-ai/pr-monitor-plugin/hermes
hermes plugins enable pr-monitor
```

Restart Hermes Desktop's gateway, and start or resume a conversation. For standalone label actions on another host,
restart that host after enabling the plugin.
Ensure the `pr-monitor` toolset is enabled in that profile if you use an explicit toolset allow-list.
Node.js 18+ and an authenticated GitHub CLI must be on the **Hermes backend's** PATH. No npm install or build
is needed: `dist/worker.mjs`, `dist/tool.json`, and the workflow skill ship with the Git plugin.

Ask Hermes to monitor `owner/repo#123`, or open a PR and let the registered workflow start it automatically.
The tool supports `start`, `stop`, `status`, `flush`, `mark_ready`, and `unmark_ready`. Load the workflow
with `skill_view(name="pr-monitor:monitor-pr")`. Agents end their turn while the monitor owns polling.

## Delivery and lifecycle

- **Desktop/TUI:** reports enter the original live conversation through its background-turn entry point. An idle
  conversation starts a turn; a busy conversation accepts a native active-turn redirect (or steer during tool
  execution). Switching tabs does not retarget delivery. User-composed attachments are preserved. Merge/close
  reports use the same path, even after readiness handoff.
- **CLI, messaging gateways, ACP (including Hermes through Sesori), and Desktop `dashboard.turn_isolation: true`:**
  background monitoring is unsupported and `start` fails explicitly. Native CLI/gateway injection does not bind
  queued reports to the original durable conversation, so switching or resetting a conversation could retarget them.
  Desktop's default `dashboard.turn_isolation: false` is supported.
- **Standalone labels on all hosts:** `mark_ready` and `unmark_ready` work without a background-delivery route or an
  active monitor. A temporary worker performs the action and closes. When the owning Desktop conversation already
  has a worker, these actions reuse it and preserve its active-watch configuration.

Monitors live in one Node worker per conversation. Finalizing/resetting the conversation, unloading the plugin,
quitting the host, or a worker failure stops its monitors. Ordinary turn completion does not stop them.
Resume after a host restart and explicitly restart missing watches. No detached daemon survives the host.
Global `~/.config/pr-monitor/config.json` supplies defaults. Project configuration is captured from the
conversation's working directory: `.pr-monitor.json`, then `.hermes/pr-monitor.json`, then
`.opencode/pr-monitor.json`.

Set `autoMerge: true` in global `~/.config/pr-monitor/config.json` or trusted project config to make automatic
readiness and `mark_ready` perform one head-fenced, title-only squash merge. Project config overrides global config;
an explicit `SESORI_PR_MONITOR_AUTO_MERGE` environment value overrides both. With auto-merge enabled, startup
removes any pre-existing ready label and requires fresh assessment. Successful merges get a dynamically created
`automatically-merged` label. See [configuration and auto-merge safety](../docs/configuration.md#auto-merge) for
failure behavior and setup details.

## Compatibility boundary

Hermes's public Python `inject_message` API does not currently cover Desktop/TUI. `desktop.py` is a narrow
compatibility adapter for the live TUI gateway's session registry, transport binding and synchronous
background-turn admission. It requires those interfaces and verifies the live record belongs to the tool's
conversation. It never starts another gateway or resumes a closed chat. Hosts without these interfaces fail
explicitly. A model-driven smoke test passed through the Desktop gateway with simulated GitHub data; real
GitHub and additional host/platform acceptance remain listed in the regression matrix.

The source contract was inspected at Hermes commit
[`9a84bee265da`](https://github.com/NousResearch/hermes-agent/commit/9a84bee265daad14340a80d7585928cd8ea1f9eb).
See [regression requirements](https://github.com/sesori-ai/pr-monitor-plugin/blob/main/docs/regression/hermes.md) for validation status and remaining host checks.

Development: run `npm run build:hermes` from the repository root and commit the regenerated `hermes/dist/`
and `hermes/skills/` alongside source changes. `npm test` includes the Python adapter contracts; Python 3.10+
is required for development tests. Runtime Python comes from Hermes.
