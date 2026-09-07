# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Hermes Git plugin backed by the shared monitoring runtime, with Desktop/TUI conversation delivery, native
  CLI/messaging-gateway injection, acknowledged report failures, lifecycle cleanup, and packaged adapter tests.
  Desktop uses a guarded gateway compatibility adapter; ACP and isolated Desktop turns remain unsupported.

### Changed

- Document Codex's post-handoff idle-delivery limitation: merged/closed reports remain in the owning conversation's
  spool until another prompt or hook event.
- Codex setup now explicitly requires review of all four delivery hooks, with terminal instructions for Sesori,
  remote bridges, and other clients without `/hooks`, plus guidance for renewed review after plugin updates.
- Missing-registration errors and the Claude Code/Codex monitor skill explain the separate hook-trust step and
  how to recover in the same host configuration without repeatedly retrying or creating registration by hand.

### Fixed

- Hermes teardown rejects late worker admission and drains already admitted report delivery; busy Desktop delivery
  rechecks conversation ownership before redirecting. Host-confirmed resumes can restart finalized conversations.
  Admission cancellation is scoped to its conversation; bounded weak identity records avoid retaining old agents or
  confusing a resumed agent with a reused object ID.
- Hermes builds remove stale generated artifacts, release output names the Hermes manifest, and worker tests retain
  normal unittest assertion reporting. The Codex workflow links directly to the hook-trust setup instructions.

## [0.4.1]

### Changed

- Repository renamed from `sesori-ai/opencode-pr-monitor` to `sesori-ai/pr-monitor-plugin`; GitHub redirects the old
  name, so existing marketplace installs keep working. The Claude Code + Codex plugin root moved from `claude-code/`
  to `claude-codex/`, since it serves both hosts. Plugin and package names are unchanged.

- Monitor startup now preserves the existing ready label and asks the agent to assess current-head CI, expected
  automated reviews, and feedback before marking a settled PR ready. Empty results on a newly opened PR or fresh
  commit do not establish readiness; later activity retains automatic readiness across all hosts.
- Monitor skills require an immediate readiness assessment after a restart and manual `mark_ready` when only
  non-actionable feedback remains, without waiting for another event or replying to bot acknowledgements.
- Repository instructions now require a changelog update in every PR, including documentation and instruction changes.

### Fixed

- Codex reports, project configuration, and keep-alive state are scoped to the owning conversation instead of the
  shared app-server process. Hook registration is bound to the current host lifetime so a resumed conversation
  cannot silently reuse stale delivery setup after a restart.
- Automatic readiness still runs when CI completes or feedback is handled before a failed startup report is
  retried or manually flushed. An unchanged startup retry continues to require agent assessment.
- Hook commands retain their shell-level failure fallback, and malformed waiter arguments are handled without
  an uncaught second parsing error.

## [0.4.0]

### Added

- Claude Code delivery is push-first: the MCP server injects each report over the session's messaging socket
  (`CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`) as a visible `[PR Monitor]` message, starting a turn when the session is
  idle. With a working socket the keep-alive Stop block and waiter are never armed; the spool + hooks + keep-alive
  loop remains only as the fallback for hosts without the socket.
- Inline-feedback reports list the exact changed review-thread locations (path and line), mark comments that belong
  to a pending review, state that an unprefixed local-account comment is new human feedback, and warn that
  pending-review comments may be missing from REST results so agents inspect the listed thread via GraphQL.
- `make bump VERSION=X.Y.Z` and `make publish` script the lockstep version bump and the ordered
  check → npm publish → registry verify → tag release procedure.
- Codex support. The Claude Code plugin root is now also a Codex plugin (`.codex-plugin/plugin.json`,
  `.codex-mcp.json`, root `.agents/plugins/marketplace.json`) sharing the MCP server, hooks, and skill. Codex has no
  messaging socket, so it always uses the spool + hooks delivery with the keep-alive waiter; the server detects the
  host from a verbatim `--codex` arg, reads the project directory from the Codex process, and falls back to
  `.codex/pr-monitor.json` for config. The PostToolUse hook now records waiter runs itself because Codex's sandbox
  keeps the waiter from writing its own proof.

## [0.3.1]

### Added

- Active watches now manage the configured ready-for-human-review label across OpenCode, Claude Code, Pi, and OMP.
  Clean acknowledged heads are labeled automatically; later commits, relevant feedback, CI regression, and conflicts
  withdraw readiness, while unconditional `mark_ready` remains the judgment override for non-actionable activity.
- Every report states readiness and makes follow-ups on existing/resolved threads action-required even when the
  unresolved-thread count is unchanged. Local-account comments without the mandatory reply prefix are identified as
  human feedback.

### Changed

- `ignoreCommentTag` is now a starts-with agent-reply prefix and defaults to `<!-- pr-monitor:reply -->`. Prefixed
  replies remain private acknowledgement evidence instead of disappearing from readiness ordering.
- Claude keep-alive follows confirmed label state rather than every report, so resolution-only activity does not
  reopen a handed-off work loop.

### Fixed

- Readiness rejects partial GraphQL responses, fetches all check/review/thread/label pages, and distinguishes
  same-name reruns. Edited/deleted acknowledgements withdraw readiness; mixed same-second feedback/reply ties remain
  conservatively blocked. Ambiguous label failures cannot accept newer feedback during retry.
- Stop/reload cleanup drains only in-flight label mutations before unregistering a watch, preventing stale mutation
  races without hanging on a stalled fetch or report delivery.

## [0.3.0]

### Added

- Added `@sesori/pr-monitor-pi`, one package for upstream Pi and OMP with native steering delivery, session-safe
  lifecycle cleanup, trusted project config, and real-loader checks.
- Added a packaged `monitor-pr` skill for every harness. OpenCode, Pi, and OMP share one generated push-host skill;
  Claude Code retains its keep-alive-aware variant. Consuming repositories no longer need to copy OpenCode guidance
  into `.opencode/skills/`.
- Added durable L1-L5 regression catalogs for cross-host monitoring behavior, exact installation artifacts, loader
  compatibility, and release metadata.

### Changed

- The root is now a private npm workspace coordinator. `@sesori/pr-monitor-opencode` publishes from `opencode/` as
  an ESM bundle containing private core/runtime code, with exact tarball/install/import and lockstep-version checks.
- OpenCode and Claude Code now share one session runtime for watch ownership, timers, GitHub identity, actions,
  labels, and shutdown channels; host adapters retain only delivery and lifecycle policy.
- Repository `.pr-monitor.json` is now the preferred shared config path. Tool/skill guidance makes autonomous
  delivery explicit and forbids agent-created delays or CI polling; Claude handoff is recorded only after
  `mark_ready` confirms label success.

### Fixed

- Pi/OMP actions resolve project trust and configuration from each current tool invocation instead of retaining the
  context that first created the session runtime.
- Monitor skills no longer promise an automatic report for a head push by itself; comments, reviews, CI conclusions,
  conflicts, and terminal state remain reportable activity.

## [0.2.1]

### Added

- The OpenCode plugin is now prepared for npm distribution as the public scoped package `@sesori/pr-monitor-opencode`. Its package entry points support both standard package imports and OpenCode's `./server` lookup, and the published artifact is restricted to the OpenCode shell plus the shared core.
- **Instant CI-failure reports** (config `flushOnCiFailure`, default `true`). A failing check no longer waits out `debounceMinutes` — a window that unrelated PR comments kept resetting, so a red CI could sit unreported for a long time before the session started fixing it. Any check newly in `failure` now flushes on the spot, carrying whatever activity was buffered so far, skipping both the quiet window and the CI hold. Failures found while the suite is still running count too (previously not activity at all, so a lint failure in minute 1 of a 20-minute suite waited for the whole suite plus the debounce); the report states the suite honestly, e.g. `- CI: running (3/8 done, 1 failed so far: lint)`. Capped at one instant report per head commit so a matrix going red job by job cannot wake the session once per job — the suite's conclusion still delivers the full verdict through the normal debounce, and the next push re-arms the instant path.
- **Instant conflict and terminal-state reports.** A newly detected merge conflict, merge, or close now bypasses both the debounce and a running-CI hold and reports at the next poll.
- Inline-comment reports now preserve review-thread and comment identity plus current resolution state. They state how many resolved and unresolved threads received visible comments since the last flush, making a human follow-up on an already answered or resolved thread explicit even when the unresolved-thread total is unchanged. Polling paginates beyond GitHub's first 100 review threads, and ignored tagged replies cannot create false visible-comment activity when a full 100-comment thread window rolls over.

### Changed

- The default `debounceMinutes` quiet window is now 2 minutes (previously 5).

### Fixed

- Auto-flush report delivery is awaited inside the watch's exclusive op instead of being fire-and-forget. Its failure path restores exactly the state a later flush advances (`lastFlushAt`, `lastFlushedSnapshot`, `dirty`, `holdStartedAt`), so a delivery that rejected after a newer report had already flushed could rewind that newer report's "new since" baseline — and, with the instant CI path above, re-fire a duplicate report immediately. Ticks now skip while a report is in flight, which is the intended trade-off: there is nothing useful to do with a fresher snapshot while the previous report is stuck.
- "New since last flush" now compares comment IDs with the last flushed snapshot instead of relying only on second-granularity GitHub timestamps, which could render a newly detected follow-up as `0 new` when it landed in the same second as the prior flush.
- Failed initial status delivery no longer advances the comment or timestamp baseline. The complete startup report is retained as urgent and retried at the next poll, preventing comments present when monitoring began from being permanently hidden. The failed attempt counts toward the standard 10-delivery-failure stop limit.
- OpenCode shutdown notices now use synchronous `session.prompt` with `noReply: true`. The previous `promptAsync` call returned before its background task persisted the message, and instance disposal then cancelled that task, so the advertised shutdown notice was usually lost.

## [0.2.0]

### Added

- **Claude Code plugin.** The repo is now dual-target: alongside the opencode plugin, it ships a Claude Code plugin (`claude-code/` — manifest, bundled MCP stdio server, hooks, `/pr-monitor:watch` and `/pr-monitor:status` commands) built on the same core (`core/`). Claude Code cannot push messages into a session, so delivery is passive: the MCP server (`claude-code/src/mcp-server.ts`, bundled to `claude-code/dist/mcp-server.mjs`) spools reports to `~/.claude/pr-monitor/spool/<claude pid>/`, and plugin hooks (`claude-code/hooks/drain-spool.mjs`) inject them into the conversation at the next user prompt, tool call, or turn end (the Stop hook holds an ending turn to deliver pending reports).
- `desktopNotifications` config option (default `false`, Claude Code shell only): emit an OS notification when a report is spooled, covering the gap where a report lands while the session is idle.
- The Claude Code shell reads config from `.claude/pr-monitor.json`, falling back to `.opencode/pr-monitor.json`.
- `mark_ready` tool action (both shells) and `/pr-monitor:ready` command: add the configured `readyLabel` label (default `ready-for-human-review`, created green with a description if missing from the repo) to a PR on GitHub, signalling it is ready for human review. Works without an active monitor; refuses targets that are not open PRs (plain issues, merged/closed PRs).
- `unmark_ready` tool action (both shells) and `/pr-monitor:unready` command: remove that label again, for when new feedback lands on a PR that was already flagged ready. Idempotent — a PR that does not carry the label reports so instead of failing.
- **`monitor-pr` skill**, shipped with the Claude Code plugin. The behavior layer that was previously missing on the Claude Code side: start a monitor immediately after raising a PR, act on every report (review comments via `address-pr-comments`, failing CI, conflicts), hand the PR off with `mark_ready` once CI is green with no unresolved threads and no pending reviewers, and take it back — withdrawing the label — when a human responds.
- **Keep-alive loop** (Claude Code shell, config `keepAlive` default `true`, `keepAliveMaxMinutes` default `120`). Passive delivery meant a report arriving while the session sat idle waited until the user next typed. Now, while a monitored PR has not been handed off, the `Stop` hook refuses turn-end and hands the session a command running the new `claude-code/hooks/await-activity.mjs`, which blocks until the next report is spooled — so the session wakes on real events rather than polling, at one model round trip per event. Bounded by the handoff, `stop`, PR merge/close, MCP server exit, and the rolling idle cap; interruptible with <kbd>Esc</kbd>. State is published to `<spool dir>/session.json` by the MCP server (`claude-code/src/session-state.ts`) and refreshed on every poll tick as a liveness heartbeat.
- Reports now include a `- Labels:` line when the PR carries labels, so a session can tell whether a PR is already handed off. Labels are deliberately not treated as activity — the agent applies the label itself.

### Changed

- Repository layout split by dependency direction: `src/` became `core/` (shell-agnostic polling, activity detection, `PrWatch`, report rendering), `opencode/` (the opencode shell) and `claude-code/` (the Claude Code shell, which is also the plugin root). Neither install spec changes: `package.json` `main` points at `opencode/index.ts`, and the root `.claude-plugin/marketplace.json` points its plugin entry at `./claude-code`.
- `loadConfig` now takes explicit candidate file paths instead of directories (shared-core change; opencode behavior unchanged).
- `PrWatch.announceInitial` returns a promise so the Claude Code shell can spool the initial report before the `start` tool call returns (opencode behavior unchanged).

### Fixed

- `PrWatch` operations are serialized through a per-watch promise queue: concurrent `manualFlush` calls could interleave their fetches and restore a stale snapshot/baseline. Ticks now skip while an operation is pending, and manual flushes queue.
- `stop()` during an in-flight poll no longer delivers the late report: `tick` re-checks the stopped flag after its awaited fetch, so nothing is applied or delivered once the tool has reported "Stopped".

## [0.1.6]

### Fixed

- Graceful opencode shutdowns now stop active timers, deliver a factual stop notice to each owning session, and await all delivery attempts before plugin disposal completes. Abrupt process termination remains undetectable.

## [0.1.5]

### Fixed

- Mergeability tracking now compares against the last *definite* state (MERGEABLE/CONFLICTING) instead of the immediately previous poll. A real `MERGEABLE -> UNKNOWN -> CONFLICTING` settle spans two polls; because `0.1.4` suppressed every UNKNOWN-side transition, once the previous snapshot became the transient UNKNOWN the genuine conflict was swallowed and never reported. Carrying the last definite value across UNKNOWN polls keeps base-branch churn quiet while still catching a conflict once it resolves.

## [0.1.4]

### Changed

- Transient `UNKNOWN` mergeability churn from base-branch merges (`MERGEABLE -> UNKNOWN -> MERGEABLE`) no longer counts as activity; only settled transitions between definite mergeability states are report-worthy.

## [0.1.3]

### Added

- `announceOnStart` config option (default `true`): on start, a monitor delivers a full status report immediately so the session sees its starting point and can address anything already outstanding on the PR (including comments added during a delayed startup, which periodic polling would otherwise treat as pre-existing and never report). Set `false` to disable.

## [0.1.2]

### Added

- Reports render the PR as a clickable Markdown link (`[owner/repo#n](url)`); all `[PR Monitor]` messages are Markdown.
- Merged/closed PR reports end with a `Monitor stopped: PR merged|closed` line, so a self-close is explicit.

### Changed

- Every stop reason now uses one consistent `Monitor stopped: <reason>` phrasing (terminal merge/close, PR not found, repeated poll failures, plugin reload).
- The `flush` action is documented as on-demand: a delivered report already advances the "new since" baseline, so a manual flush after handling a report is not needed.

## [0.1.1]

### Fixed

- Report deliveries reuse the session's last user-selected model (captured via the `chat.message` hook) instead of letting the server re-resolve the model at delivery time, which on a long-lived watch could drift onto a model that had since been removed.

## [0.1.0]

### Added

- Initial release: a background GitHub PR monitor that delivers factual `[PR Monitor]` reports into the owning opencode session.
