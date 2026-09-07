# Finish PR Monitor setup

1. Run `hermes plugins enable pr-monitor` in the profile used by your conversation.
2. Ensure Node.js 18+ and authenticated `gh` are available on the backend's PATH.
3. Restart Hermes Desktop's gateway. Enable the `pr-monitor` toolset if you restrict toolsets, then ask Hermes
   to monitor an explicit PR URL.

Background monitoring uses the original live Desktop/TUI conversation with `dashboard.turn_isolation: false`.
CLI, messaging gateways, ACP and isolated Desktop turns can use standalone `mark_ready` / `unmark_ready`, but
cannot start background monitors. Restart those hosts after enabling the plugin to use label actions.
Watches stop when the conversation or host closes and must be restarted after a host restart. See README.md
for compatibility details.
