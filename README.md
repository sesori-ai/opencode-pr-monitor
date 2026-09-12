# pr-monitor

A GitHub PR monitor for coding agents, available for [OpenCode](https://opencode.ai),
[Claude Code](https://code.claude.com), [Codex](https://developers.openai.com/codex),
[Pi](https://github.com/earendil-works/pi), [Oh My Pi](https://omp.sh), and [Hermes](https://hermes-agent.nousresearch.com). It watches pull requests in the background, delivers `[PR Monitor]` reports into the
session that started the watch, and manages the ready-for-human-review label from observable GitHub state.

## What it does

- Polls GitHub via `gh api graphql` (one base query per watched PR per tick, plus overflow pages for checks, latest
  reviews, review threads, or labels only when needed).
- Detects: new commits, CI suite conclusions, reviews and review summaries, inline/issue comments (including
  follow-ups on existing or resolved review threads), review-thread resolution changes, mergeability changes, and
  merge/close.
- Aggregates ordinary activity with a **rolling debounce**: any new activity resets a quiet timer; a report is delivered after the PR has been quiet for the configured window.
- **Instant CI failures**: a check going red skips the debounce and the CI hold — the report goes out at the next poll, carrying whatever else was buffered, so the agent starts fixing CI instead of waiting out a timer that PR comments keep resetting.
- **Instant conflicts and terminal states**: a newly detected merge conflict, merge, or close also reports at the next poll without waiting for the debounce or CI hold.
- **CI hold**: a due report is held while a check suite is still running (bounded by `maxCiWaitMinutes`), so you get one report with the CI verdict instead of two.
- Automatically adds readiness when CI is green/absent, mergeability is `MERGEABLE`, and every feedback channel
  ends in a prefixed local-account reply. A later commit, relevant comment, CI regression, or conflict withdraws it.
- Every report states whether readiness is present and tells the agent to keep working or manually accept
  non-actionable activity. Reports include no comment bodies.
- Monitors are **per-session and in-memory**: they stop automatically when the PR is merged/closed, preserve the
  label as historical evidence, and do not survive a host restart.
- The monitor owns polling and delivers reports automatically. Agents must not create sleeps, scheduled checks, background polling loops, repeated `gh pr checks`, or routine `status`/`flush` calls while waiting.

### Example report

```
[PR Monitor] [sesori-ai/example#42](https://github.com/sesori-ai/example/pull/42) — "feat: add relay reconnect backoff"
- CI: failing (1/8 failed: analyze)
- Mergeable: MERGEABLE
- Reviews: alice ✓ approved · bob ⏳ pending
- [comment:review] 0 new relevant review summaries since last flush
- [comment:inline] ACTION REQUIRED: 2 threads received 2 new relevant comments since last flush (1 currently unresolved, 1 currently resolved; 2 coderabbitai[bot]). The unresolved-thread count is unchanged at 3; inspect every changed thread anyway. Changed threads: `core/watch.ts:412` [thread `PRRT_watch`] (unresolved; 1 coderabbitai[bot]); `core/report.ts:96` [thread `PRRT_report`] (resolved; 1 coderabbitai[bot]).
- [comment:issue] 5 total (1 new relevant since last flush: 1 alice)
- Ready for human review: NO — label "ready-for-human-review" is absent.
- Required next step: Do more work until the PR is ready for review, or use pr_monitor(action: "mark_ready", pr: "sesori-ai/example#42") if you believe nothing else is required.
```

## Requirements

- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated (`gh auth status`).
- For Claude Code: Node.js >= 18 on `PATH` (runs the bundled MCP server), macOS or Linux.
- For Codex: Codex CLI >= 0.153 with plugins enabled, Node.js >= 18 on `PATH`, macOS or Linux.
- For OpenCode: OpenCode >= 1.17.
- For Pi: Pi >= 0.84.2 and Node.js >= 22.19.
- For OMP: OMP >= 18.0.3.

## Hermes

Hermes Desktop/TUI monitoring uses a Python plugin backed by the shared Node engine. Standalone label actions also work on other Hermes hosts:

```sh
hermes plugins install sesori-ai/pr-monitor-plugin/hermes
hermes plugins enable pr-monitor
```

Restart the Hermes host after enabling the plugin. Node.js 18+ and authenticated `gh` must be available
on the backend's PATH. Desktop reports target the original conversation, starting a turn when idle and injecting into the active turn
when busy, including merge/close after handoff. Desktop uses a compatibility adapter for Hermes's internal gateway.
CLI, messaging gateways, ACP (including Hermes through Sesori), and isolated Desktop turns do not support background
monitoring. They can use standalone `mark_ready` / `unmark_ready` actions. See [Hermes setup and lifecycle](hermes/README.md).

## Claude Code

### Install

```
/plugin marketplace add sesori-ai/pr-monitor-plugin
/plugin install pr-monitor@sesori
```

For local development, add the marketplace from a checkout instead: `/plugin marketplace add /path/to/pr-monitor-plugin`.

### Usage

The plugin registers a `pr_monitor` MCP tool with the same actions as the opencode version (see the table below), a `monitor-pr` skill that tells Claude how to use it, and four convenience commands:

- `/pr-monitor:watch [owner/repo#123 | PR URL]` — start monitoring (with no argument, Claude resolves the current branch's PR via `gh pr view`).
- `/pr-monitor:status` — list this session's active monitors.
- `/pr-monitor:ready [owner/repo#123 | PR URL]` — mark the PR as ready for human review (adds the `readyLabel` label on GitHub).
- `/pr-monitor:unready [owner/repo#123 | PR URL]` — withdraw that label again.

### Unattended mode: PR raised → comments addressed → flagged for review

The bundled `monitor-pr` skill turns reports into work, so the normal path needs no prompting from you:

1. Claude opens a PR and starts a monitor for it straight away.
2. Every report is acted on — review comments via the repo's `address-pr-comments` skill, failing CI by fixing the cause, conflicts by merging the base branch in.
3. Agent replies begin with the configured prefix (default `<!-- pr-monitor:reply -->`). Unresolved threads may
   remain intentionally; the prefixed final reply is the acknowledgement signal.
4. The monitor automatically adds readiness when the current head is clean and withdraws it for later commits or
   feedback. Claude uses unconditional `mark_ready` only when new activity is non-actionable and should not receive
   another reply.

### How reports arrive (push-based like opencode, with a passive fallback)

On current Claude Code versions delivery is push-based, exactly like opencode: each session exposes a local
messaging socket, and the bundled MCP server injects finished reports into the owning conversation as visible
`[PR Monitor]` messages. A report arriving while the session sits idle starts its own turn; one arriving mid-turn
surfaces alongside the work in progress. Claude never waits for the monitor — no sleeps, no delays, no waiter
commands — it simply ends its turn and is woken when something happens. A push that fails is retried by the watch at
poll cadence, and persistent failure stops the monitor with a terminal notice left in the fallback spool.

On hosts without the messaging socket, delivery falls back to the passive spool: the MCP server writes reports to
disk and plugin hooks inject them at the next opportunity —

- immediately after any tool call Claude makes (`PostToolUse`),
- when you submit a prompt (`UserPromptSubmit`),
- when Claude tries to end its turn (`Stop`) — a pending report holds the turn open so Claude addresses it before going idle.

That alone still leaves a gap: a report landing while the session sits idle waits until your next message.
**Keep-alive** closes it, on those fallback hosts only. While a monitored PR does not carry the ready label, the
`Stop` hook supplies an exact `claude-codex/hooks/await-activity.mjs` command that blocks until a report is spooled.
That hook-issued command is the only waiting mechanism Claude should ever run; it must never invent a delay or
polling job after starting the monitor.

Bounds, so a loop can never run away:

- It ends when readiness is added automatically or manually, on `stop`, when the PR merges or closes, and when the
  MCP server goes away.
- `keepAliveMaxMinutes` (default 120) caps *idle* waiting; every delivered report refreshes it, so an active PR keeps going and an abandoned one lets go.
- <kbd>Esc</kbd> interrupts the wait like any other tool call, and asking Claude to stop wins over the loop.
- Set `"keepAlive": false` to switch the fallback loop off and keep pure passive delivery. With push delivery
  the loop is never armed, so the setting only matters on socketless hosts.

Prefer being told out of band instead? Set `desktopNotifications: true` for an OS notification when a report is waiting.

Further behavior notes for the Claude Code shell:

- Monitors belong to the Claude Code process. They survive `/clear` (the new conversation keeps receiving reports) and die with the process; they do not survive quitting Claude Code or `claude --resume` into a new process. If the MCP server is restarted while Claude Code keeps running (e.g. `/reload-plugins`), each active monitor delivers a `Monitor stopped` notice; when Claude Code itself exits, monitors simply die with it (no notice — there is no session left to deliver to).
- Config first uses repository `.pr-monitor.json`, then falls back to `.claude/pr-monitor.json` and `.opencode/pr-monitor.json`.

## Codex

The Claude Code plugin root doubles as a Codex plugin: the same MCP server, hooks, and `monitor-pr` skill, declared
through `claude-codex/.codex-plugin/plugin.json` and `claude-codex/.codex-mcp.json`.

### Install

```sh
codex plugin marketplace add sesori-ai/pr-monitor-plugin
codex plugin add pr-monitor@sesori
```

For local development, add the marketplace from a checkout instead: `codex plugin marketplace add /path/to/pr-monitor-plugin`.

### Trust the delivery hooks (required)

**Installing or enabling PR Monitor does not trust its hooks.** Codex skips untrusted hooks, so monitoring cannot
start until you review them. An enabled MCP server and visible `pr_monitor` tool do not mean delivery is ready.

1. Open `codex` in a terminal on the machine running your Codex session, using the same OS user and `CODEX_HOME`
   (the default is `~/.codex`) as your app or CLI.
2. Run `/hooks`, review the entries from `pr-monitor@sesori`, and enable and trust all four: `SessionStart`,
   `UserPromptSubmit`, `PostToolUse`, and `Stop`. They run the installed plugin's `hooks/drain-spool.mjs --codex`.
   At the startup review prompt, choose **Review hooks**. Use **Trust all** only if every listed hook is one you
   intend to approve; otherwise review the PR Monitor entries individually.
3. Return to your original conversation, send a new prompt, and retry monitoring. A hook registers the conversation
   automatically; there is no registration file to create by hand.

**Sesori and other app-server clients:** `/hooks` is a Codex CLI screen, not a PR Monitor slash command. If your app
has no hook-review screen, perform the steps above in a terminal on the app-server machine. For a remote bridge,
that is the remote machine, not the phone or laptop displaying the conversation. You can close the CLI after
reviewing the hooks; trust persists in that Codex configuration.

Codex ties trust to the current hook definition. After a plugin update, new or changed hooks may need review again.
The plugin cannot grant itself trust during installation. See [Codex hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

If you still get **“the PR Monitor delivery hook has not registered this Codex conversation”**:

- Check `/hooks` for disabled entries or entries needing review, including after updates.
- Confirm the CLI and app-server use the same user, `CODEX_HOME`, and plugin installation.
- Confirm hooks are enabled in Codex (`features.hooks` is not `false`) and Node.js is on the app-server's `PATH`.
- Send a new prompt after fixing setup. If the client has not picked up the change, reopen the conversation and retry.

For client implementers, make hook review part of plugin onboarding: use Codex's `hooks/list` response to show the
plugin's enabled state and `trustStatus`, present its commands for review, and persist the user's approval through
Codex's hook trust flow. An **installed, needs hook review** state should link to that review screen or the terminal
steps above. Only show monitoring as ready after hooks run and the conversation registers; never auto-trust hooks
or manufacture registration as part of installation.

### How reports arrive

Codex has no messaging socket, so it always uses the spool + hooks path described above for Claude Code fallback
hosts: the MCP server spools each report, plugin hooks inject it at the next `UserPromptSubmit`, `PostToolUse`, or
`Stop` event, and while a monitored PR lacks the ready label the `Stop` hook keeps the session on the PR by handing
it the exact `await-activity.mjs` waiter command (run with the shell tool's `timeout_ms: 600000`). All the keep-alive
bounds and `keepAlive` / `keepAliveMaxMinutes` / `desktopNotifications` settings apply unchanged.

**Idle after handoff:** Codex's spool is routed to the correct conversation, but writing a report does not wake
an idle conversation. Once readiness hands off the keep-alive waiter, a later merge/close report remains queued
until that conversation's next prompt or tool/hook event. This applies to other post-handoff feedback too.
`desktopNotifications` can announce a report out of band; it does not start an agent turn.

Behavior notes for the Codex shell:

- Monitors belong to the calling Codex conversation, including when several conversations share one app-server.
  The MCP thread ID selects its own watches and report queue. The delivery hook supplies the conversation’s
  working directory; the app-server/plugin working directory is not used as the project directory.
- If the hooks have not registered the conversation, starting a monitor returns an explicit error. Enable and
  trust the plugin hooks, send another prompt, and retry. A missing hook must not look like working delivery.
- Config first uses repository `.pr-monitor.json`, then falls back to `.codex/pr-monitor.json` and
  `.opencode/pr-monitor.json`.
- The slash commands are Claude Code only; use the `pr_monitor` tool directly (`status`, `stop`, `mark_ready`, ...).
- The report spool is shared with Claude Code at `~/.claude/pr-monitor/spool/`. Codex queues are nested under
  `<host pid>/<thread id>`; hooks and waiters select only that conversation. Claude Code retains process routing.
- Startup normally observes the existing ready label. With environment auto-merge enabled, startup instead removes
  a pre-existing ready label and requires a fresh `mark_ready` judgment. The agent must assess the initial report,
  including after a harness restart, and immediately mark an already-settled PR ready. Empty results after creation
  or a fresh push do not establish readiness; age alone is insufficient. Automatic readiness continues for later
  observed activity.
- Across all hosts, clean review summaries, review quota notices and other no-op feedback still require agent
  judgment. After inspecting them and confirming no work remains, the agent calls `mark_ready` explicitly.

## opencode

### Install

Add the plugin to your project's `opencode.json` (committed — the whole team gets it) or to your global `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@sesori/pr-monitor-opencode"]
}
```

opencode installs npm plugins and their dependencies into its package cache on startup. To make upgrades explicit, pin a version such as `@sesori/pr-monitor-opencode@0.3.1` and bump it deliberately. Quit and restart opencode after changing the plugin configuration.

Reports arrive in the owning session as messages starting with `[PR Monitor]`. Monitors stop when the owning session is deleted. On graceful opencode shutdown, a no-reply stop notice is persisted to each owning session before the plugin is disposed, so it is present in history when opencode starts again.

The package injects its `monitor-pr` skill through OpenCode's skill-path config, so the agent learns the complete ownership loop without a consuming repository copying the skill.

## Pi and OMP

Install the shared package in Pi:

```sh
pi install npm:@sesori/pr-monitor-pi
```

Or in OMP:

```sh
omp plugin install @sesori/pr-monitor-pi
```

The package selects the correct entry automatically and supplies one `monitor-pr` skill to each host. Reports use native custom-message delivery with steering and idle turn triggering, so agents end the turn while waiting and wake only for real activity. Pi clears watches after successful session replacement/reload shutdown; OMP clears them on its post-success session-switch event. Canceled transitions retain the active watch.

## The `pr_monitor` tool

All four harnesses register the same tool:

| Action   | `pr` argument                          | Effect |
| -------- | -------------------------------------- | ------ |
| `start`  | `owner/repo#123` or full PR URL        | Begin watching. The repo must be explicit — no cwd inference. |
| `stop`   | PR identifier or `all`                 | Stop watching. |
| `flush`  | PR identifier or `all`                 | On demand: immediately return a full status report and reset the "new since" baseline. Delivered reports already advance the baseline, so a flush after handling one isn't needed. |
| `status` | —                                      | List this session's active monitors. |
| `mark_ready` | `owner/repo#123` or full PR URL    | Add `readyLabel`; auto-merge opt-in also squash-merges. |
| `unmark_ready` | `owner/repo#123` or full PR URL  | Remove the label now. It is idempotent and is not a permanent hold: an active monitor may restore readiness after a later clean assessment. |

## Environment-gated auto-merge

> **Warning:** auto-merge is irreversible. Enable it only in a trusted host environment whose authenticated `gh`
> account is allowed to merge the repositories it monitors.

Set `SESORI_PR_MONITOR_AUTO_MERGE=true` (or `1`) in the host process environment, then fully restart the desktop
host. Unset it, set it to `false`, `0`, or an empty value to disable it. Any other value fails closed and logs a
configuration warning. This switch is deliberately environment-only: an `autoMerge` key in repository
`.pr-monitor.json` is ignored, so checked-out code cannot opt the host into merging.

```sh
# Shell-launched hosts
export SESORI_PR_MONITOR_AUTO_MERGE=true

# macOS GUI hosts for the current login session; restart the app afterward
launchctl setenv SESORI_PR_MONITOR_AUTO_MERGE true
```

When enabled:

- A successfully completed readiness transition performed by the monitor, or any successful `mark_ready` action
  (watched or standalone), first keeps/applies `readyLabel`, then makes one squash-merge attempt. Merely observing a
  label added externally—or after a failed/ambiguous label mutation—does not merge.
- Starting a monitor on an open PR that already carries `readyLabel` removes that label before the watch starts.
  The start result and, when `announceOnStart` is enabled, initial report say it was cleared and require the agent
  to reassess the current head and call `mark_ready` again if appropriate. Startup never merges from stale handoff
  state.
- The merge request is fenced to the accepted head SHA. The squash commit title is the current PR title and its
  commit-message body is explicitly empty.
- A successful merge dynamically creates and applies the blue `automatically-merged` label. Failure to apply this
  marker cannot undo a completed merge and is reported as a warning.
- A rejected merge leaves `readyLabel` in place, reports the failure, and is not retried automatically while that
  readiness state remains unchanged. A later new readiness transition, or an explicit later `mark_ready`, is a new
  attempt.

## Configuration

Optional, per project: use `.pr-monitor.json` for every host. Claude Code falls back to
`.claude/pr-monitor.json` then `.opencode/pr-monitor.json`; OpenCode falls back to `.opencode/pr-monitor.json`;
Hermes falls back to `.hermes/pr-monitor.json` then `.opencode/pr-monitor.json`; Pi/OMP use their
`CONFIG_DIR_NAME` (`.pi`/`.omp`) before `.opencode/pr-monitor.json`. Pi reads project-local config only after project
trust. Auto-merge is not a JSON setting; use the host environment switch above.

```json
{
  "debounceMinutes": 2,
  "maxCiWaitMinutes": 30,
  "pollIntervalSeconds": 60,
  "ignoreCommentTag": "<!-- pr-monitor:reply -->",
  "announceOnStart": true,
  "flushOnCiFailure": true,
  "desktopNotifications": false,
  "readyLabel": "ready-for-human-review",
  "keepAlive": true,
  "keepAliveMaxMinutes": 120
}
```

| Key                    | Default | Meaning |
| ---------------------- | ------- | ------- |
| `debounceMinutes`      | `2`     | Quiet window after the last detected ordinary activity before a report is delivered. Rolling — new activity resets it. |
| `maxCiWaitMinutes`     | `30`    | Upper bound on holding a due report while CI is still running. After this, the report is force-flushed naming unfinished checks. |
| `pollIntervalSeconds`  | `60`    | GitHub poll interval per watched PR (clamped to 30 seconds … 24 hours). |
| `ignoreCommentTag`     | `<!-- pr-monitor:reply -->` | Mandatory prefix for agent-authored GitHub replies. A local-account comment without this exact starting prefix is treated as human feedback; prefixed replies remain private acknowledgement evidence and do not count as new relevant comments. |
| `announceOnStart`      | `true`  | Deliver a full status report immediately when a monitor starts, so the session sees its starting point and can address anything already outstanding on the PR. Set `false` to disable. |
| `flushOnCiFailure`     | `true`  | Report a newly failing check at the next poll instead of waiting out `debounceMinutes` (and any CI hold), so CI fixes start sooner. Counts failures found while the suite is still running. At most one instant report per head commit — later failures on the same commit ride along with the debounced suite-conclusion report. Set `false` for debounce-only delivery. |
| `desktopNotifications` | `false` | Claude Code only: emit an OS notification (macOS/Linux) when a report is delivered or spooled. |
| `readyLabel`           | `ready-for-human-review` | Label managed automatically by active watches and explicitly by `mark_ready`/`unmark_ready`. |
| `keepAlive`            | `true`  | Claude Code fallback hosts only (no messaging socket): while a monitored PR lacks the ready label, refuse turn-end and have Claude wait for the next report. Ignored on push-enabled hosts, where reports arrive on their own. Set `false` for passive delivery. |
| `keepAliveMaxMinutes`  | `120`   | Claude Code fallback hosts only: cap on how long the keep-alive loop waits with *nothing happening*. Refreshed by every delivered report, so it bounds idle time rather than total work time. Ignored on push-enabled hosts. |

## Behavior details

- **Activity** = head changes, state/mergeability changes, review changes, per-thread resolution or relevant-comment
  changes, issue comments, and CI *suite conclusions*. A head change is activity even before GitHub registers checks;
  non-failing per-check progress on the same head remains quiet.
- **CI failures bypass the timers** (`flushOnCiFailure`, default on). A check whose outcome is newly `failure` — including one found while the suite is still running, which is otherwise not activity — flushes on the spot: no quiet window, no CI hold. The report reads the suite honestly (`- CI: running (3/8 done, 1 failed so far: lint)`). The instant path fires at most once per head commit, so a matrix going red job by job cannot wake the session once per job; the suite's eventual conclusion still delivers the full verdict through the normal debounce, and the next push re-arms the instant path.
- **Conflicts and terminal states bypass the timers.** A newly observed `CONFLICTING` state (including an `UNKNOWN -> CONFLICTING` settle), merge, or close reports at the next poll and is never held behind running CI.
- **Review-thread follow-ups are explicit.** Reports lead with `ACTION REQUIRED` when any existing or resolved thread
  receives a relevant comment and explicitly warn that the unresolved count may be unchanged. Local-account comments
  lacking the mandatory prefix are identified as human feedback.
- **Readiness follows acknowledgement, not resolution.** Each review thread may remain unresolved if its latest
  comment is a prefixed local reply. Flat issue/review-summary feedback is acknowledged by a later prefixed local
  issue comment. Editing or deleting that acknowledgement withdraws readiness. Mixed feedback/reply entries in the
  same timestamp second remain conservatively blocked until a later reply or manual mark. Stale `CHANGES_REQUESTED`,
  pending reviewers, thread resolution, and draft status do not independently block readiness.
- **"New since last flush"** compares stable GitHub comment IDs with the last delivered report or manual `flush`, so comments created within the same timestamp second are not lost.
- **Failure handling**: 10 consecutive poll failures (or report-delivery failures) stop the monitor with a notice. A failed initial status report retains its zero comment baseline and retries at the next poll. A deleted/inaccessible PR stops immediately.
- **Terminal states**: an immediate report describing a merged/closed PR is delivered with a `Monitor stopped: PR merged|closed` line, then the monitor stops itself. All stop reasons use the same `Monitor stopped: <reason>` phrasing.

## Development

```sh
npm install
npm test             # core, shared runtime, and adapter regression tests
npm run typecheck    # core + runtime + all adapters
npm run build        # OpenCode/Pi publish bundles + committed Claude MCP bundle
npm run version:check
npm run pack:check   # inspect/install/import both npm artifacts
npm run host:check   # load the Pi and OMP bundles through their real loaders
npm run clean        # remove ephemeral OpenCode/Pi build and generated skill output
```

Layout — one directory per target, plus shared core/runtime layers:

```
core/            per-PR state, config, GitHub normalization, activity, reports
runtime/         session registry/actions/timers, Node gh runner, shared tool contract
skills/          canonical monitor-pr skill for push-capable hosts
opencode/        OpenCode adapter and npm workspace
pi/              shared Pi/OMP adapter entries and npm workspace
claude-codex/     Claude Code + Codex shell — this directory is the plugin root for both hosts (${CLAUDE_PLUGIN_ROOT})
.claude-plugin/  Claude marketplace.json, which stays at the repo root and points at ./claude-codex
.agents/plugins/ Codex marketplace.json, likewise at the repo root and pointing at ./claude-codex
```

Dependency flows adapter → `runtime/` → `core/`; core imports no host SDK and runtime owns common session orchestration. The root is a private npm workspace coordinator. OpenCode source stays in `opencode/`, but publication bundles it with private core/runtime into `opencode/dist/index.js`; both `.` and `./server` resolve to that sole-export bundle. Its tarball contains only the bundle and declaration, target README/license, and manifest; generated OpenCode output stays uncommitted. The Claude Code shell is bundled with esbuild into the committed `claude-codex/dist/mcp-server.mjs`, since Git plugin installs run no build step; `claude-codex/hooks/drain-spool.mjs` is the dependency-free hook that injects spooled reports and runs the keep-alive loop, and `claude-codex/hooks/await-activity.mjs` is the blocking waiter it hands to the session; `claude-codex/skills/monitor-pr/` is the behavior — when to start a monitor, what to do with each report, when to hand off; `claude-codex/.mcp.json` declares the MCP server (plugin-root convention — an inline `mcpServers` field in plugin.json is not picked up). Codex reuses the same root through `claude-codex/.codex-plugin/plugin.json`, which points at `claude-codex/.codex-mcp.json`: Codex substitutes no `${...}` placeholders in server args and exports no plugin env to the server, so that manifest launches the bundle as a contained `./dist/mcp-server.mjs` path (shebang + exec bit, added by the build) with `cwd: "."` and a verbatim `--codex` arg that tells the server which host it is under.

## Regression coverage

Durable acceptance criteria live in [`docs/regression/`](docs/regression/README.md):

- [`pull-request-monitoring.md`](docs/regression/pull-request-monitoring.md) covers shared watch semantics,
  ready-label handoff, autonomous delivery, host lifecycle, and configuration.
- [`plugin-installation.md`](docs/regression/plugin-installation.md) covers exact npm/Claude artifacts, host floors,
  skill discovery, loader compatibility, and lockstep release metadata.

The catalogs distinguish automated, adapter, actual-host, and packaged/external proof. Do not treat a source import
or fake adapter as proof of a packed host integration.

## Releasing

A release uses one version for all targets. The OpenCode workspace publishes `@sesori/pr-monitor-opencode`; the
Pi workspace publishes the shared Pi/OMP package `@sesori/pr-monitor-pi`; and the annotated `vX.Y.Z` tag marks the
Claude Code Git-plugin release. The private root cannot be published, and there is no separate GitHub Release step.

The whole procedure is one command, run on a clean, up-to-date `main`:

```sh
make publish                 # asks for the new version; `make publish 0.4.1` skips the prompt
make bump 0.4.1              # only the version/CHANGELOG step, committed to the current branch
```

It runs each step below in order and stops at the first failure: preflight guards (clean tree, on `main` equal to
`origin/main`, tag absent, `npm whoami`, version not on the registry) → write the version everywhere, rebuild the
bundle, cut the `[Unreleased]` CHANGELOG section, and commit `Release vX.Y.Z` to `main` when anything changed → the
full check matrix → push `main` → publish both npm packages → verify the registry → create and push the tag. The
manual steps, for reference:

Update both workspace manifests and lock entries, `claude-codex/.claude-plugin/plugin.json`,
`claude-codex/.codex-plugin/plugin.json`, the MCP server version, and `CHANGELOG.md`. From a clean candidate commit,
complete the full matrix before publishing:

```sh
npm ci
npm run release:check # tests, types, builds, versions, exact packs, Pi floor, OMP floor
OPENCODE_CLI="$(command -v opencode)" npm run host:check:opencode
OMP_VERSION=18.0.4 npm run host:check:omp
# Also complete the live Claude release-host row documented in docs/regression/plugin-installation.md.
git diff --exit-code -- claude-codex/dist/mcp-server.mjs
```

Use the current supported OpenCode/OMP versions for the two current-host rows; CI records Linux/macOS coverage while
Windows runs the required package/loader smoke. After the candidate PR merges, use a clean checkout of that exact
`main` commit. Publish both npm artifacts before creating the Claude tag, so an npm rejection cannot leave a stale
cross-harness release marker:

```sh
npm whoami
npm publish --workspace @sesori/pr-monitor-opencode --access public
npm publish --workspace @sesori/pr-monitor-pi --access public
npm view @sesori/pr-monitor-opencode@X.Y.Z version
npm view @sesori/pr-monitor-pi@X.Y.Z version
git tag -a vX.Y.Z -m "vX.Y.Z — summary"
git push origin vX.Y.Z
```

The first Pi/OMP publication requires permission to create public packages in the `@sesori` scope (`npm login` if
needed). `publishConfig` already fixes npmjs.org and public access. npm versions are immutable: never tag Claude or
retry a changed tarball under the same version until both npm registry checks above succeed.

## License

[MIT](LICENSE)
