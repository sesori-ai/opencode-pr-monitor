# AGENTS.md

Quick orientation for agents working on this repo. Read this before exploring; it captures the architecture and key facts.

## What this is

`pr-monitor` is a GitHub PR watcher that posts factual status updates back into the owning agent session. It targets **OpenCode** (`opencode/`), **Claude Code and Codex** (`claude-codex/`, one plugin root serving both hosts), and the shared **Pi/OMP** package (`pi/`), all built on the same core (`core/`) and session runtime (`runtime/`).

## Project layout

One directory per target, plus shared core and runtime layers. Dependency flows
adapter → `runtime/` → `core/`; **`core/` imports nothing from a shell**.
Adapters own delivery/lifecycle/config paths, not watch orchestration.

```
core/                # Pure per-PR state, GitHub normalization, reports, config types/loading.
  config.ts    # Common/Claude config; global base + first project override + env precedence.
  target.ts    # Parses PR target: "owner/repo#n" or full GitHub URL.
  github.ts    # GraphQL polling via injected GhRunner; normalizes into PrSnapshot.
  activity.ts  # detectActivity(prev, next): what counts as a change.
  watch.ts     # PrWatch — per-PR state machine (tick, readiness, debounce, deliver); no session ownership.
  readiness.ts # Automatic eligibility/invalidation from CI, mergeability, heads, and acknowledged feedback.
  report.ts    # Markdown report rendering.
  label.ts     # mark_ready / unmark_ready: add or remove the readyLabel via gh REST.
  merge.ts     # Config/env-gated, head-fenced title-only squash merge + successful marker label.

runtime/             # Host-neutral application/session layer.
  monitor-session.ts # Watch registry, auth identity, actions, timers, labels, shutdown channels.
  node-gh.ts         # child_process gh runner shared by Node-based adapters.
  tool.ts            # Shared action enum and autonomous-delivery/no-delay tool wording.

skills/              # Canonical monitor-pr skill copied into push-host npm artifacts at build time.

docs/regression/     # Durable monitoring and installation acceptance matrices used for release/plan evidence.

opencode/            # OpenCode source plus publishable npm workspace.
  index.ts     # Sole source export PrMonitorPlugin (loader invokes EVERY export — keep it the only one).
  gh.ts        # OpenCode's injected Bun-shell GhRunner.
  package.json # @sesori/pr-monitor-opencode; exports the generated dist/index.js bundle.
  dist/        # Ephemeral JS bundle + sole-export declaration, ignored; never commit.

pi/                  # @sesori/pr-monitor-pi workspace shared by upstream Pi and OMP.
  index.ts      # Upstream Pi entry; package manifest owns skill discovery.
  omp.ts        # Thin OMP package entry; delegates registration only.
  omp-adapter.ts # OMP post-switch cleanup and resources_discover compatibility seam.
  extension.ts  # Shared Pi-family tool, delivery, config, and MonitorSession ownership.
  dist/         # Ephemeral publish output, ignored; never commit.

claude-codex/         # Claude Code + Codex shell. THIS DIRECTORY IS THE PLUGIN ROOT for both (= ${CLAUDE_PLUGIN_ROOT}).
  .codex-plugin/
    plugin.json      # Codex manifest: same metadata/version, points at ./skills/, ./hooks/codex-hooks.json, ./.codex-mcp.json.
  .codex-mcp.json    # Codex server declaration: command "./dist/mcp-server.mjs" (shebang + exec bit), cwd ".", args ["--codex"].
                     # Codex 0.153 expands NO ${...} placeholders in args/env and exports NO plugin/project env to the server;
                     # a relative cwd resolves against the plugin root; a contained ./ command resolves against that cwd.
  src/               # Bundled; never executed from source.
    mcp-server.ts# MCP stdio adapter: MonitorSession wiring, push-first delivery with spool fallback, handoff, shutdown notices.
    push.ts      # active delivery: injects reports as user messages over the session's uds-messaging socket (env CLAUDE_CODE_MESSAGING_SOCKET/TOKEN).
    spool.ts     # spool write/GC/ownership: ~/.claude/pr-monitor/spool/<claude pid>/<ts>-<server pid>-<seq>.md (tmp+rename).
    session-state.ts # keep-alive state published to the hooks: <spool dir>/session.json.
  hooks/
    hooks.json       # wires drain-spool.mjs to UserPromptSubmit / PostToolUse / Stop.
    drain-spool.mjs  # dependency-free: drains this session's spool, injects reports (additionalContext / Stop block), runs the keep-alive loop.
    await-activity.mjs # dependency-free blocking waiter; NOT a hook — the Stop block tells the session to run it via Bash.
  skills/
    monitor-pr/      # the behavior: start on PR creation, act on every report, hand off when clean, take back on human feedback.
  commands/          # /pr-monitor:watch, /pr-monitor:status, /pr-monitor:ready, /pr-monitor:unready
  .mcp.json          # declares the MCP server (node ${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.mjs) — plugin-root convention.
  .claude-plugin/
    plugin.json      # plugin metadata only (name/version/description/...); components are discovered by convention
                     # (.mcp.json, hooks/hooks.json, commands/) — an inline mcpServers field here is NOT picked up (tested on 2.1.216).
  dist/
    mcp-server.mjs   # committed esbuild bundle (plugin installs run NO build step — rebuild + commit on change).

.claude-plugin/
  marketplace.json # MUST stay at the repo root — `/plugin marketplace add <repo>` reads it from there.
                   # Its plugin entry points at the plugin root with "source": "./claude-codex";
                   # relative sources resolve against the directory containing .claude-plugin/.
.agents/plugins/
  marketplace.json # Codex marketplace, also repo-root ("codex plugin marketplace add <repo>"); local source ./claude-codex.
```

**Codex host facts:** MCP calls include `_meta.threadId`; hook `session_id` is that thread ID (verified in
Codex 0.153 source). A Codex app-server can own multiple conversations, so its PID and cwd do not identify a
conversation. The adapter creates one MonitorSession per thread and spools under `<host pid>/<thread id>`;
the PID owner token and dead-process GC still govern the outer directory. Codex hooks only drain the matching
thread subdirectory, never legacy PID-only reports. They record conversation `cwd` in
`spool/codex-contexts/<thread id>.json`, bound to the current host PID/start token. A resumed thread needs fresh
registration after a host restart; an unregistered conversation cannot start a monitor and receives an
explicit hook setup error. The generated `hooks/codex-hooks.json` adds `--codex` to the shared hooks and registers
SessionStart. Codex plugin hooks require trust confirmation. Codex has no messaging socket and uses the
thread-scoped spool/keep-alive path. Synthetic tests do not substitute for a real model-driven host check.

Everything under `claude-codex/` is addressed plugin-root-relative at runtime, so
`.mcp.json` and `hooks.json` (which use `${CLAUDE_PLUGIN_ROOT}`) are unaffected by
where the plugin root sits in the repo.

## Hermes adapter

`hermes/` is a Python Git plugin. `hermes/src/worker.ts` embeds `runtime/` and `core/` in the committed
`hermes/dist/worker.mjs`; `build:hermes` also generates the tool schema and copies the canonical push-host skill.
Python owns one worker per conversation, delivery acknowledgements, profile context, and lifecycle cleanup.
`hermes/desktop.py` contains the experimental Desktop/TUI gateway compatibility seam. CLI, messaging gateways,
ACP and isolated Desktop turns reject background monitoring because their native injection APIs cannot bind
reports to the original durable conversation. Standalone ready actions need no report route and close their
one-shot worker; actions for an existing Desktop watch reuse its worker and captured configuration. Never import
a new Desktop gateway to find a conversation or use foreground selection as delivery identity. Update `docs/regression/hermes.md` for host evidence.
Hermes plugin version is part of the lockstep release check. Rebuild and commit its artifacts on shared changes.

## Core flow (both shells)

1. **start** — adapter calls its session's `MonitorSession` → parse/dedupe → load config/auth → fetch initial snapshot → reject if not `OPEN` → `new PrWatch(...)` → arm the owned interval.
2. **tick** — `PrWatch.tick()` (`core/watch.ts`): fetch snapshot → detect activity/readiness invalidation → mutate
   the label when needed → mark dirty/reset debounce or urgency → `maybeAutoFlush()`.
3. **deliver** — shell-specific, injected as `deps.deliver`:
   - opencode (`opencode/index.ts`): `client.session.promptAsync(...)` pushes a `[PR Monitor]` message into the owning session. `promptAsync` never rejects on server error — check `result.error`. `agent` captured at start time (default agent may be a subagent, which fails); model captured per-message via the `chat.message` hook.
   - Claude Code (`claude-codex/src/mcp-server.ts` + `push.ts`): push-first. Claude Code binds a per-session
     uds-messaging socket and exports `CLAUDE_CODE_MESSAGING_SOCKET`/`CLAUDE_CODE_MESSAGING_TOKEN` to child
     processes (the MCP server is one). `pushMessage` writes an auth line then a `{"type":"user"}` line
     (newline-delimited JSON), which injects the report as a visible user message — starting a turn when the
     session is idle, surfacing mid-turn when busy. Injection has no protocol ack: a clean close is success, so a
     stale token after a messaging-server restart is a silent-drop residue healed by the next `/mcp` reconnect.
     A failed push rejects so the watch's delivery-failure path rolls back the baseline and retries at poll
     cadence — able to wake an idle session the moment the socket recovers — and persistent failure ends in the
     watch's stop-after-consecutive-failures notice. Only hosts without the socket fall back to `spoolReport()`
     (one file per report under `~/.claude/pr-monitor/spool/<claude pid>/`) with the plugin's hooks injecting
     spooled text at the next UserPromptSubmit / PostToolUse / Stop event, guarded by the keep-alive loop (below).
   - Pi/OMP (`pi/extension.ts`): `sendMessage(..., { deliverAs: "steer", triggerTurn: true })` queues while busy and starts a model turn while idle. No spool or waiter is needed.

## Key behaviors / gotchas

- **Debounce + CI-hold** in `maybeAutoFlush` (`core/watch.ts`): wait `debounceMinutes` of quiet after ordinary activity; if CI is running on an OPEN PR, hold up to `maxCiWaitMinutes` before flushing.
- **Immediate flushes** bypass both timers. A new CI failure (when `config.flushOnCiFailure` is on), newly observed merge conflict, or terminal state marks the watch `urgent`; `maybeAutoFlush` sends the report at that poll. `hasNewCiFailure(prev, next)` is capped by `ciFailureFlushedSha` to one instant failure report per head commit; later failures ride with the suite-conclusion report. A delivery failure restores urgency so it retries immediately.
- **detectActivity** (`core/activity.ts`): head, state, mergeable, reviews, per-thread resolution/relevant-comment
  signatures, issue comments, and CI **conclusion** count as activity. Review comments retain thread identity and
  current resolution state, allowing reports to distinguish follow-ups on resolved versus unresolved threads;
  prefixed local replies are absent from relevant-activity signatures but retained for readiness ordering. CI
  transitions into "running" and non-failing per-check progress do **NOT** count unless a new head caused them.
  Mergeability is compared against the last *definite* value so transient `UNKNOWN` churn stays quiet while a real
  `MERGEABLE -> UNKNOWN -> CONFLICTING` settle is caught and flushed immediately.
- **Failure handling** — notFound → stop with notice; 10 consecutive poll failures → stop; 10 consecutive delivery failures → stop. Delivery failures roll back the baseline so the same activity is retried. A failed initial announcement keeps its zero baseline, marks the watch urgent, and retries the complete startup report at the next poll.
- **Reentrancy guard** — `runExclusive` (per-watch promise queue) serializes `tick()` and `manualFlush()` so overlapping fetches can't apply out of order; ticks skip while an op is pending, manual flushes queue. Auto-flush delivery is **awaited inside** that op, not fire-and-forget: its failure path rolls back exactly the state a later flush advances (`lastFlushAt`, `lastFlushedSnapshot`, `dirty`, `holdStartedAt`, `urgent`), so a late rejection from an overlapping delivery would otherwise rewind a newer report's baseline and re-fire it immediately. Comment "new since" comparisons use IDs from `lastFlushedSnapshot`, avoiding GitHub's second-granularity timestamp race. Ticks skipping while a report is in flight is the intended consequence. `tick` also re-checks `stopped` after its awaited fetch so a concurrent `stop()` prevents any late apply/deliver.
- **Stop/mutation fencing** — a stopped watch rejects queued flush/ready actions and remains registered until an
  already-started readiness operation drains. An auto-merge already in flight drains; if stop wins while the label
  call is pending, `stopped` fences the not-yet-started follow-on merge. Session cleanup and OpenCode reload takeover
  do not await stalled fetches or deliveries; `stopped` fences their continuations before a successor is mutated.
- **Sessions, Claude Code shell**: one MCP server process per Claude Code process, so the watches map IS the session scope. Monitors survive `/clear` (same process) and die with the process. Spool routing: spool dirs are named by the owning Claude Code pid (= MCP server's ppid); the hook drains dirs named by its parent/grandparent pid (hook ← sh ← claude; deliberately NOT the full ancestry, which would let a nested claude session steal the outer session's reports) and GCs dead-pid dirs. Ancestry is read from `/proc` where it exists, else `ps`; with neither the hook drains **nothing** — the number of live spools is not evidence of ownership (a session with no monitor still fires hooks), so there is no cardinality trick that substitutes for real ancestry. A pid is not an identity either — the OS recycles them — so `claimSpool` records the Claude Code process's start time in `<spool dir>/owner` (tmp+rename; a torn read must not look like a foreign token) at server startup, and it is enforced in three places: the server discards anything it cannot prove it inherited before spooling (a foreign token *and* an untokened dir, since stamping the latter would launder a vanished session's reports); `spoolReport` re-checks the token before every write, so an orphaned server whose parent's pid got recycled cannot write into the newcomer's spool; the hook *skips* — never deletes — a dir whose token mismatches, because deleting would race the newcomer's `claimSpool`. On macOS the token is `ps -o lstart=` (1-second resolution), a deliberate residue: coarser than ideal, but calling macOS unverifiable would restore pid-only routing there, which is strictly worse. Report filenames carry the *server* pid too (`seq` restarts at 0 in each process while the dir outlives them, so an /mcp restart could otherwise collide within a millisecond and lose a report). Drains claim each report via unlink-before-emit so concurrent hook invocations never deliver one twice, and the script must not process.exit after writing (stdout past the 64KB pipe buffer would be truncated). PostToolUse also fires for tool calls inside Task subagents — those hook inputs carry `agent_id`, and drain-spool.mjs skips them so a report is never consumed by a subagent's context (verified empirically on Claude Code 2.1.216). Shutdown (stdin EOF/SIGTERM) spools a `Monitor stopped` notice per watch — delivered if the same process continues (server restart), silently GC'd if the session is gone.
- **Reload takeover, opencode shell** — `globalThis.__sesoriPrMonitorTakeovers` kills zombie timers from prior plugin instances; old watches send one factual stop notice. (`session.deleted` stops matching watches silently.) Graceful `dispose` cannot use `promptAsync`: OpenCode acknowledges that endpoint before its fork persists the message, then disposal cancels the fork. Shutdown uses synchronous `session.prompt` with `noReply: true`, persisting each notice before disposal without starting a model turn.
- **Pi-family lifecycle** — upstream Pi tears down the old extension instance and emits post-success
  `session_shutdown` on new/resume/fork/reload, so common cleanup lives there. OMP retains its extension runner and
  uses the thin `pi/omp-adapter.ts` post-success `session_switch` handler. Neither adapter clears on cancelable
  before-events.
- Reports never include comment bodies. They include factual counts/authors/readiness plus explicit workflow
  direction when the PR is unready or new feedback needs inspection.
- **The monitor owns waiting.** Tool descriptions and every shipped skill forbid agent-created sleeps, delays, timeouts, scheduled checks, background polling, repeated `gh pr checks`, and routine `status`/`flush`. All shells end the turn and rely on push delivery; only a legacy Claude host without the messaging socket may be handed the exact `await-activity.mjs` command by a keep-alive message, and Claude may run only that.
- **Startup readiness** — normally observe the existing label without auto-adding it, including disabled/retried
  initial announcements. With auto-merge enabled by config or environment, remove a pre-existing ready label before
  registration and tell the agent in the start result—and the initial report when announcements are enabled—to
  reassess and call `mark_ready` again; startup never merges stale handoff state. The initial report and all skills
  require assessment of current-head
  checks, expected automated reviews and feedback. A restarted settled PR can be marked immediately; empty fresh
  results and age alone cannot justify handoff. Later observed activity retains automatic readiness.
- **Automatic readiness** (`core/readiness.ts`, `core/watch.ts`) — adds the label after green/no CI, definite
  mergeability, and prefixed local replies on every feedback channel. A later head, relevant comment/summary,
  acknowledgement edit/deletion, CI regression, or conflict withdraws it urgently. Mixed same-second
  feedback/reply ties remain conservatively unacknowledged. Resolution state, stale review state, pending reviewers,
  draft, and terminal state do not withdraw it.
- **mark_ready / unmark_ready** (all shells, `core/label.ts`) — add/remove `config.readyLabel` (default
  `ready-for-human-review`) via the gh REST API. For an active watch, `mark_ready` unconditionally accepts its current
  snapshot so stable pre-existing blockers do not immediately undo the manual judgment. Both verify the target via
  `pulls/{n}` and refuse non-open targets: label endpoints share the issue namespace, so a plain issue number or a
  terminal PR would otherwise produce false success. `mark_ready` best-effort creates the green label before adding
  it. `unmark_ready` treats a missing label as success. Standalone actions need no active monitor.
- **Configurable auto-merge** (`core/merge.ts`) — `autoMerge: true` in user-global or trusted project config enables
  the feature; an explicitly defined `SESORI_PR_MONITOR_AUTO_MERGE=true|false|1|0` overrides both layers and invalid
  values fail closed. Automatic readiness and watched/standalone `mark_ready` first retain the ready label, then make
  one squash-merge attempt fenced to the accepted head SHA. Squash commit title is the PR
  title and `commit_message` is explicitly empty. Success best-effort creates/applies `automatically-merged`; marker
  failure is a warning because merge is irreversible. Merge rejection keeps readiness and is not retried while that
  readiness state stays unchanged. External/pre-existing label observation never triggers merge.
- **Keep-alive loop, Claude Code shell (fallback only)** — armed only when the session has no messaging socket;
  with a push channel `session.json` carries `keepAlive: false`, the Stop hook never blocks, and the session goes
  idle freely (failed pushes retry through the watch, not through hooks). In fallback: while a monitored PR is not handed off, the
  Stop hook runs
  `claude-codex/hooks/await-activity.mjs`, which blocks until a report is spooled: one model round trip per real event.
  `session-state.ts` publishes liveness and the rolling `keepAliveMaxMinutes` idle deadline. The MCP server refreshes
  it on watch/handoff changes and every poll tick; a lapsed heartbeat tells hooks that the server died. Confirmed
  automatic/manual readiness adds the normalized target to `handedOff`; confirmed withdrawal removes it. Report
  delivery alone does not change handoff, so resolution-only activity can report without reopening keep-alive.
  The waiter detects reports but never unlinks them; the PostToolUse drain owns exactly-once delivery.
  `drain-spool.mjs` counts blocks that produced no wait to bound tight Stop loops. `.waiter` resets that streak after
  a real wait. The waiter path is single-quoted through `shellQuote` because plugin install paths are arbitrary.
  Labels remain outside ordinary `detectActivity`; readiness observes the configured label separately so its own
  mutations do not echo as generic activity.

## Configuration

Config loads fresh per start and standalone ready action. Defaults are overlaid by user-global
`~/.config/pr-monitor/config.json` (or an absolute `$XDG_CONFIG_HOME/pr-monitor/config.json`), then the first
readable project candidate. Active-watch ready actions use config captured at start. Every adapter starts project
candidates with
`.pr-monitor.json`; OpenCode falls back to project/worktree `.opencode/pr-monitor.json`; Claude Code uses `.claude/`
then `.opencode/`; Hermes uses `.hermes/` then `.opencode/`; trusted Pi/OMP use
`${CONFIG_DIR_NAME}/pr-monitor.json` then `.opencode/`. OMP's compatibility shim resolves the config directory to
`.omp`; do not replace it with a hardcoded host branch.
`MonitorConfig` contains common settings; `ClaudeMonitorConfig` adds `desktopNotifications`, `keepAlive`, and
`keepAliveMaxMinutes`. Unknown keys are ignored, invalid values leave the lower layer unchanged, invalid JSON is
logged, and missing files use lower layers/defaults. An explicit auto-merge environment value overrides config.
`ignoreCommentTag` is the mandatory local agent-reply prefix, defaults to `<!-- pr-monitor:reply -->`, and matches
only at the start of a comment.

## GitHub layer

- Injected `GhRunner`: OpenCode wraps Bun `$` in `opencode/gh.ts`; Node adapters use `runtime/node-gh.ts`. Both throw `PollError(msg, { notFound })` on failure; `core/github.ts` imports neither host.
- `PR_QUERY` (`core/github.ts`) fetches title, URL, state, mergeable, head SHA, checks, review requests/latest reviews
  plus summary metadata, review threads/comments, issue comments, and labels. Overflow pages are fetched for check
  contexts, latest reviews, review threads, and labels so readiness cannot be computed from a truncated connection.
  Any top-level or pagination GraphQL `errors` reject the entire snapshot even when partial `data` is present and
  stay retryable; only a clean response proving the top-level PR absent is terminal.
- `normalizeSnapshot` → `PrSnapshot`; `ciPhase` → `none|running|concluded`.

## Regression catalog

- `docs/regression/pull-request-monitoring.md` owns shared watch/report/label behavior plus host delivery, lifecycle,
  config, and autonomous-waiting requirements.
- `docs/regression/plugin-installation.md` owns exact npm/Claude artifacts, host floors, loader/skill discovery, and
  lockstep release behavior.
- `docs/regression/README.md` defines cumulative L1-L5 boundaries and `Pass`/`Partial`/`Fail`/`Blocked`/`Not run`.
  Actual-host, platform, and external rows are not satisfied by source imports or fake adapters.

## Building / releasing

- Always update `CHANGELOG.md` in the same PR as every change, including documentation and agent/skill
  instructions. Add a concise, factual entry under `[Unreleased]` in the appropriate category; do not defer it
  until release or a follow-up PR.
- The root is a private npm workspace coordinator. `npm run build` produces ephemeral OpenCode and Pi/OMP bundles with private core/runtime embedded and rebuilds committed `claude-codex/dist/mcp-server.mjs`. Host SDKs remain external. Claude plugin installs run no build, so rebuild + commit its bundle whenever `claude-codex/src/`, `runtime/`, or `core/` changes; never commit OpenCode/Pi dist or generated package skill copies.
- `claude-codex/hooks/drain-spool.mjs` and `claude-codex/hooks/await-activity.mjs` must stay dependency-free (node builtins only) and keep their path/format schemes in sync with `claude-codex/src/spool.ts` and `claude-codex/src/session-state.ts`. They are shipped as source, not bundled — only `claude-codex/src/` goes through esbuild.
- `claude-codex/skills/monitor-pr/SKILL.md` is Claude's waiter-aware behavior layer. `skills/monitor-pr/SKILL.md` is the canonical push-host behavior layer copied into both npm artifacts. OpenCode injects its generated directory through `config.skills.paths`, Pi uses `package.json#pi.skills`, and OMP returns it from `resources_discover`; each host must discover exactly one `monitor-pr` skill.
- Pi host imports stay external and use `"*"` peer ranges exactly as upstream package guidance requires. Supported
  host floors are enforced by documentation/loader checks; narrowing the peers would conflict with OMP rewriting.
- One version spans both npm workspaces and the Claude manifest (`npm run version:check`). `npm run pack:check` creates both tarballs, enforces exact contents/skills, installs them, and imports every export. Publish both workspaces from a clean commit; only after npm succeeds create/push the annotated Claude release tag.
