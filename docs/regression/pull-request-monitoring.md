# Pull Request Monitoring

## Capability

A coding-agent session can watch explicit GitHub pull requests, receive readiness-aware `[PR Monitor]` reports when
head, review, comment, CI, mergeability, or terminal state changes, and automatically manage a handoff label.
OpenCode, Claude Code, Codex, Pi, and OMP share the same per-PR state machine and session runtime while retaining host-native
delivery and lifecycle ownership.

The highest required regression level is **L5 Full** because the complete claim crosses published artifacts, real
host loaders, authenticated GitHub state, and ready-label mutation.

## Required Behavior

### Watch and report semantics

- `start` accepts `owner/repo#number` or a full GitHub pull-request URL, rejects non-open targets, deduplicates
  owner/repository casing within one session, delivers the initial snapshot by default, and starts one owned timer.
- `status`, `flush`, `stop`, `mark_ready`, and `unmark_ready` expose the same action contract in every host. Label
  actions do not require an active watch; watch actions never infer a target from the current directory.
- Ordinary activity is debounced from the latest visible change. A due report waits for running CI only up to
  `maxCiWaitMinutes`. Entering CI `running` and non-failing per-check progress are not ordinary activity.
- With `flushOnCiFailure` enabled, a newly failing check is urgent and bypasses both debounce and the CI hold.
  Newly definite merge conflict, merge, and close are always urgent. Instant CI failure is limited to one delivery
  per head commit; the concluded suite can report later.
- Check contexts, latest reviews, review threads, and labels are paginated to completion before readiness is
  evaluated. A GraphQL payload containing `errors` is rejected even when it also contains partial `data` and remains
  retryable; only a clean response proving the top-level PR absent is terminal. Head changes, reviews, review
  summaries, issue comments, thread resolution, and relevant thread follow-ups count as
  activity. Stable IDs preserve same-second follow-ups. A local-account comment is an agent
  acknowledgement only when it begins with `ignoreCommentTag`; those replies remain in readiness ordering but not
  relevant-comment signatures.
- Reports contain state, counts, authors, labels, readiness, check names, changed inline-thread paths/lines and
  unique thread IDs, pending-review markers, and required workflow direction, but never comment bodies. A
  local-account comment lacking
  the prefix is identified explicitly as new human feedback rather than an earlier agent reply. Pending-review
  feedback warns that REST pull-comment results may omit it and directs the agent to inspect the listed thread via
  GraphQL before marking ready. Delivery failure restores the prior baseline and urgency. Ten consecutive poll
  failures stop with a notice; ten consecutive delivery failures stop after logging and best-effort persist a
  terminal stop notice through the shell's persistent channel where one exists, because the failed delivery channel
  itself cannot carry it.
- Merge/close produces one terminal report and removes the watch. Explicit stop, session cleanup, and failed starts
  leave no timer. Cleanup drains an already-started readiness operation before unregistering the watch, including
  an auto-merge already in flight. If stop wins while the label call is pending, it fences the not-yet-started merge.
  Cleanup does not wait for a stalled fetch or report delivery. A cleanup crossing an
  in-flight start still prevents late registration.

### Ready-label lifecycle

- After startup, an active watch automatically adds `readyLabel` as observed activity settles when CI is passing
  or absent, mergeability is `MERGEABLE`, every
  review thread ends in a prefixed local reply, and flat issue/review-summary feedback is followed by a prefixed
  local reply. Resolution state, stale `CHANGES_REQUESTED`, pending review requests, and draft state do not block.
- A later head, relevant comment/summary, acknowledgement edit/deletion, CI regression, or definite conflict
  automatically removes readiness and flushes urgently. Resolution-only activity, approvals without summary
  feedback, transient `UNKNOWN`, merge, and close preserve it. An acknowledged state is restored only after the
  normal quiet window.
- Cross-channel comments sharing GitHub's timestamp second are conservative: readiness requires every latest tied
  entry to be a prefixed local reply. A mixed feedback/reply tie remains blocked until a later reply or manual mark.
- A review summary is feedback when its body is non-empty. An empty, comment-less `CHANGES_REQUESTED` review is also
  flat feedback; an empty review whose inline comments are represented by threads is not duplicated.
- `mark_ready` verifies an open PR, best-effort creates the green label, accepts all activity currently observed by
  an active watch without eligibility restrictions, and succeeds only after GitHub adds the label. Later activity
  still withdraws it. `unmark_ready` removes the label now but creates no persistent suppression of auto-readiness.
- Automatic ready-label mutation failure is reported truthfully and retried. Claude handoff/keep-alive follows
  confirmed label state rather than every report delivery; a readiness-preserving report does not reopen keep-alive.
- Every report and stop notice states last-known readiness. An open, unready report instructs the agent to continue
  work or use `mark_ready` when judgment says no action remains. Terminal reports preserve the label and omit that
  work instruction.

### Config- and environment-gated auto-merge

- `autoMerge: true` may enable auto-merge in user-global or trusted project config. Global config is
  `~/.config/pr-monitor/config.json`, or `$XDG_CONFIG_HOME/pr-monitor/config.json` when that environment variable is
  an absolute path. Project config overrides global config.
- An explicitly defined `SESORI_PR_MONITOR_AUTO_MERGE` overrides both config layers: `true`/`1` enables and
  `false`/`0`/empty disables. Any other value fails closed, disables auto-merge, and logs a warning.
- Only successfully completed readiness transitions performed by the monitor and successful `mark_ready` actions
  trigger one merge attempt. Observing an externally added ready label does not; neither does observing readiness
  after a failed/ambiguous label mutation. Both watched and standalone `mark_ready` are covered.
- The ready label is applied first. Standalone `mark_ready` captures the head before labeling and revalidates it
  afterward; a changed or unverifiable head cancels the merge and triggers best-effort ready-label withdrawal. The
  squash merge is fenced to the accepted head SHA, uses the current PR title as `commit_title`, and sends an
  explicitly empty `commit_message`; PR body text is never copied into the commit body.
- A successful merge best-effort creates and applies the fixed blue `automatically-merged` label. Failure to add that
  marker is reported without misreporting or attempting to undo the completed merge.
- A lost, rejected, or malformed merge response never triggers a blind retry. An indeterminate request is followed
  by one PR-state query: a matching merged head is reported as success, a changed open head invalidates standalone
  readiness, and any other unproven outcome is reported as unknown. Definitive rejection and unknown outcome leave
  readiness present. A later readiness transition or explicit `mark_ready` is a new attempt.
- A manual ready action clears an undelivered automatic-attempt notice so later reports cannot describe an obsolete
  failure after the manual attempt succeeds.
- Reports, start results, status, tool wording, commands, and shipped skills expose enabled state and its irreversible
  consequence. Every host uses the same layered config resolver and core/runtime implementation.

### Startup and restart assessment

- Startup reports normally preserve the existing label without adding it automatically. With auto-merge enabled,
  an open PR carrying the ready label has that label removed before watch registration; start fails if removal cannot
  be confirmed. The start result and, when announcements are enabled, initial report identify the reset and require
  fresh assessment plus an explicit `mark_ready` if the PR is ready. When startup announcements are disabled, the
  start result remains the notice. Startup never merges merely from stale or externally observed label state. The
  reset is lifecycle-owned work that session cleanup drains before a reloaded successor may mutate the same PR.
- Unchanged polls or a flush of unchanged initial state do not add the label. Later observed CI completion and
  feedback handling retain automatic readiness, including when that activity arrives before a failed initial
  delivery is retried or manually flushed.
- An initial report requires the same substantive attention as later reports. After a harness restart, an agent
  inspects current-head CI, expected automated reviews and existing feedback, then calls `mark_ready` immediately
  if the PR is settled and nothing remains. It must not wait for new activity that may never occur.
- A freshly created PR or recently pushed head with no reported issues is not evidence of completed checks/reviews.
  The agent keeps monitoring for expected results. PR age alone is not a readiness rule; an old PR can have a new
  head. Pending human review is compatible with handoff to that reviewer.

### Autonomous ownership

- The monitor owns GitHub polling and report timing. Every tool description and shipped skill forbids agent-created
  sleeps, delayed or scheduled commands, cron, background polling, repeated `gh pr checks`, and routine
  `status`/`flush` calls while waiting.
- Push-capable hosts end the turn and rely on native delivery. Codex and Claude Code without a messaging socket
  use the keep-alive loop and may run only the exact `await-activity.mjs` event waiter
  supplied by its keep-alive hook; it must not invent another waiter, delay, or timeout.
- A delivered report already advances the baseline. Agent GitHub replies begin with the configured prefix. A
  non-actionable bot acknowledgement gets no reply; the agent uses unconditional `mark_ready` instead, avoiding an
  acknowledgement loop. This includes clean review summaries, quota notices, and other no-op feedback: inspect
  the full text, confirm no actionable work remains and CI/mergeability are good, then mark ready explicitly.

## Required Host Rows

### OpenCode 1.17 or newer

- `PrMonitorPlugin` is the only package export and registers one `pr_monitor` tool.
- Normal delivery uses `promptAsync` in the owning session with the start-time agent and latest captured model.
  Server errors surfaced in `result.error` count as delivery failures.
- Session deletion stops silently. Reload takeover stops prior-instance timers with notices. Graceful disposal uses
  synchronous no-reply prompts so notices are persisted without starting a model turn.
- The packaged push-host skill is injected exactly once through `config.skills.paths`.

### Codex CLI/app-server with Node.js 18 or newer on macOS/Linux

- Route MCP actions using `_meta.threadId` and hook delivery using `session_id`. Two conversations under one
  app-server PID have separate monitor registries, queues, keep-alive state and handoff. An unrelated thread or
  subagent never drains their reports. Do not deliver legacy PID-only queues to Codex conversations.
- The trusted SessionStart/UserPromptSubmit hook records the conversation's `cwd`; load `.pr-monitor.json`, then
  `.codex/pr-monitor.json`, then `.opencode/pr-monitor.json` there. Never infer a conversation from the host PID or
  use the plugin/app-server cwd as its project directory.
- Hook registration is bound to the current host PID/start token. Resuming a thread under a new host requires
  fresh hook registration; a stale file cannot establish delivery.
- Missing thread metadata or hook registration returns an explicit error without starting a monitor. Enable/trust
  the hooks and send another prompt before retrying. A successful file write alone does not establish host delivery.
- Both hook manifests retain a successful shell exit when Node is missing or fails before the script loads.
  Malformed waiter arguments exit cleanly without writing completion proof for an unvalidated target.
- The Stop hook supplies a waiter with the exact thread ID. The waiter ignores reports in other conversations;
  manual readiness disarms only the owning thread's keep-alive. The Stop report instructs the agent to inspect
  no-op feedback and use `mark_ready` when no actionable work remains.
- Exercise both synthetic MCP/hook isolation tests and an actual model-driven Codex session. Source/fixture tests
  alone do not establish that a given Codex app build dispatches plugin hooks.

### Claude Code with Node.js 18 or newer on macOS/Linux

- When the session exposes its messaging socket (`CLAUDE_CODE_MESSAGING_SOCKET`), the MCP process pushes each report
  into the owning session as a visible message: an auth line then a `{"type":"user"}` line of newline-delimited
  JSON. A pushed report starts its own turn on an idle session and surfaces mid-turn on a busy one; keep-alive stays
  disarmed (`keepAlive: false`) so the Stop hook never blocks and no waiter is suggested.
- A failed push is a delivery failure: the watch rolls back its baseline and retries at poll cadence, and
  persistent failure stops the monitor after logging, best-effort persisting a terminal stop notice into the spool
  for the user's return — a report is never parked on disk behind hook events an idle session cannot fire. Without
  the socket, the MCP process spools one file per report under the owning Claude process identity. Hooks claim
  reports exactly once, do not let Task subagents consume them, and inject them on prompt, tool completion, or turn
  end.
- In that fallback, keep-alive publishes a liveness heartbeat and rolling idle deadline. It ends on confirmed
  handoff, stop, terminal state, MCP death, or idle expiry; only its exact event waiter may block.
- `/clear` retains process-owned watches. Process exit loses them. MCP restart spools factual stop notices when the
  owning process remains able to receive them.
- Claude discovers exactly one conventional waiter-aware `monitor-pr` skill.

### Pi 0.84.2 or newer with Node.js 22.19 or newer

- The package registers one tool and delivers custom `pr-monitor` messages with
  `{ deliverAs: "steer", triggerTurn: true }` while both busy and idle.
- Post-success `session_shutdown` clears all watches for new/resume/fork/reload/quit. Canceled before-events do not
  clear anything, and a stopped instance cannot deliver or remove a successor's watch.
- Project config is read only after Pi marks the project trusted. Manifest-owned discovery supplies exactly one
  packaged push-host skill.

### OMP 18.0.3 or newer

- The OMP entry delegates all monitoring and delivery to the shared Pi-family implementation after compatibility
  import rewriting.
- Post-success `session_switch` clears watches for new/resume/fork; process `session_shutdown` clears remaining
  watches. Canceled before-events retain the active watch.
- `resources_discover` returns exactly one packaged skill path. It must not duplicate Pi manifest discovery.

## Configuration Matrix

All hosts apply defaults, then user-global `~/.config/pr-monitor/config.json` (or an absolute XDG override), then
its first readable project candidate. Every host prefers repository `.pr-monitor.json`; remaining candidates are:

- OpenCode: project/worktree `.opencode/pr-monitor.json` fallbacks.
- Claude Code: `.claude/pr-monitor.json`, then `.opencode/pr-monitor.json`.
- Hermes: `.hermes/pr-monitor.json`, then `.opencode/pr-monitor.json`.
- Trusted Pi and OMP: `${CONFIG_DIR_NAME}/pr-monitor.json`, then `.opencode/pr-monitor.json`.
- Untrusted Pi: defaults plus user-global config; no project-local monitor file is read.

Pi and OMP select config candidates from each `start` and standalone ready action's current cwd/trust context;
creating the session runtime with an earlier `status` call must not pin a different project. OpenCode and Claude
reread adapter-lifetime candidates for starts and standalone actions. Ready actions for an active watch use that
watch's captured label/prefix so automation and manual override cannot target different labels. An active watch keeps
its start-time config. Loading is permissive: the first readable valid project JSON wins, unknown keys are ignored,
and invalid values leave the lower global/default layer unchanged. Invalid JSON is logged before the next candidate
is tried. `ignoreCommentTag` defaults to `<!-- pr-monitor:reply -->` and matches only at the beginning of a
local-account comment. An explicitly defined auto-merge environment value is resolved fresh at each config load and
overrides both JSON layers.

## Regression Levels

- **L1 Smoke:** Core/runtime and every adapter load; one tool and one skill are visible per host; a fake open PR can
  start, report, and stop.
- **L2 Routine:** Automated activity/readiness, acknowledgement ordering, same-account follow-ups,
  debounce/hold/urgency, report baselines, mutation/delivery retry, global/project/environment config layering,
  head-fenced title-only auto-merge calls, startup reset, actions, races, and timer cleanup on Node 22 across Linux,
  macOS, and Windows.
- **L3 Release:** Shared-session adapter contracts represent OpenCode, Claude, Pi, and OMP. Packed OpenCode plus
  bundled Claude checks cover owning-session delivery, reload/process lifecycle, spool/hook injection, and handoff.
- **L4 Extended:** Actual minimum and current Pi/OMP loaders, busy/idle steering, trust/config paths, successful and
  canceled transitions, and required OS rows.
- **L5 Full:** Packaged hosts against an authenticated disposable GitHub PR: initial/ordinary/urgent/terminal
  reports, handoff/withdrawal, config/environment-enabled auto-merge plus marker creation, and cleanup.

## Exploration Guidance

Vary initial versus post-start activity, same-second comments, resolved-thread follow-ups, prefixed replies,
unprefixed local-user follow-ups, bot acknowledgements, review summaries, head changes, running/concluded/no CI,
transient `UNKNOWN`, delivery failure, and casing. Cross lifecycle boundaries while a start, poll, label mutation, or
report is in flight. Vary automatic/manual add, automatic withdrawal, mutation retry, existing/missing label, plain
issue, and terminal PR. Exercise global/project inheritance, project override, enabled/disabled/invalid auto-merge
environment values, stale head rejection, startup with a ready label, merge rejection, and marker-label failure.

## Failure Signals

- A report is delayed behind debounce after a new failure/conflict/terminal state, or running-CI progress creates
  repeated reports without a conclusion.
- A failed delivery advances the baseline, a same-second/thread follow-up disappears, ignored content becomes
  visible activity, or an inline-feedback report omits the changed thread's unique ID, location, or pending-review
  warning needed to distinguish new human feedback from an earlier agent reply.
- A failed label mutation changes handoff, a plain issue is labeled as a PR, a resolution-only report withdraws
  readiness, or a manual mark is immediately undone by state it explicitly accepted.
- Global config does not reach every host, project config fails to override it, an explicit environment value fails
  to override both, or untrusted Pi reads project-local config. Startup auto-merges or preserves a stale ready label
  while auto-merge is enabled; a merge is not head-fenced; squash commit body is non-empty; merge failure removes
  readiness or retries unchanged state; or marker failure falsely reports a successful merge as failed.
- A canceled session transition loses a watch, a successful transition retains an old timer, or an old session
  delivers into/removes readiness from a successor watch.
- An agent creates a second wait/poll mechanism, Pi/OMP fails to trigger an idle turn, or a host discovers duplicate
  `monitor-pr` skills.

## Known Limitations

- Watches and handoff state are in memory and are not restored after a host process restart.
- Multiple host processes can watch one PR but do not share an in-memory acceptance baseline. They converge through
  the GitHub label and snapshots; simultaneous manual/automatic mutations remain last-write-wins.
- Issue-comment details are limited to GitHub's latest 100 comments. Once more than 100 prefixed local replies exist,
  older replies cannot be subtracted from the repository-wide relevant total and may cause false activity.
- GitHub CLI authentication, GitHub GraphQL/REST behavior, rate limits, and external CI timing cannot be proved by
  fakes; those claims remain partial unless their L5 rows run.
- Claude push injection has no protocol acknowledgement: a clean socket close is the success signal, so a token
  rotated underneath a still-running MCP server can drop a report silently until the next `/mcp` reconnect. Desktop
  notifications and the supported live Claude matrix are macOS/Linux only; Pi/OMP use native push and do not use the
  Claude waiter.

## Sources

`core/watch.ts`, `core/activity.ts`, `core/readiness.ts`, `core/report.ts`, `core/github.ts`, `core/label.ts`,
`core/merge.ts`,
`runtime/monitor-session.ts`, `runtime/tool.ts`, `opencode/index.ts`, `claude-codex/src/`, `claude-codex/hooks/`,
`pi/extension.ts`, `pi/index.ts`, `pi/omp.ts`, `skills/monitor-pr/SKILL.md`,
`claude-codex/skills/monitor-pr/SKILL.md`, and `test/*.test.ts`.
