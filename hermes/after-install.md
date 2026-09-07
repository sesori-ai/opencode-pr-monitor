# Finish PR Monitor setup

1. Run `hermes plugins enable pr-monitor` in the profile used by your conversation.
2. Ensure Node.js 18+ and authenticated `gh` are available on the backend's PATH.
3. Restart Hermes Desktop's gateway or the CLI/messaging gateway. Enable the `pr-monitor` toolset if you
   restrict toolsets, then ask Hermes to monitor an explicit PR URL.

Messaging gateways also require `plugins.entries.pr-monitor.allow_gateway_injection: true`.
Desktop/TUI uses the live conversation gateway; ACP and Desktop isolated turns (`dashboard.turn_isolation: true`) are not supported. Watches stop when the conversation or
host closes and must be restarted after a host restart. See README.md for compatibility details.
