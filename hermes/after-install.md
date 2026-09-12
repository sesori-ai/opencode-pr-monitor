# Finish PR Monitor setup

1. Run `hermes plugins enable pr-monitor` in the profile your conversation uses.
2. Make sure Node.js 18+ and a logged-in GitHub CLI (`gh auth status`) are on the backend's `PATH`.
3. Restart Hermes Desktop's gateway. If you restrict toolsets, enable the `pr-monitor` toolset. Then ask Hermes to
   monitor a PR URL.

Background monitoring works in the original live Desktop/TUI conversation with `dashboard.turn_isolation: false`.
The CLI, messaging gateways, ACP, and isolated Desktop turns can use the manual `mark_ready` and `unmark_ready`
actions but cannot start background monitors. Restart those hosts after enabling the plugin.
Monitors stop when the conversation or host closes, so start them again after a restart. See README.md for details.
