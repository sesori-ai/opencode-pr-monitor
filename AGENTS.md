# AGENTS.md

Quick orientation for agents working on this repo. Read this before exploring; it captures the architecture and key facts.

## What this is

`opencode-pr-monitor` is an **opencode plugin** that watches a GitHub PR and posts factual status updates back into the owning opencode session. No build step — opencode executes the TypeScript directly. Depends only on `@opencode-ai/plugin`.

## Project layout

```
src/
  index.ts     # Plugin entry. Sole export PrMonitorPlugin (loader invokes EVERY export — keep it the only one).
  config.ts    # Loads .opencode/pr-monitor.json; defaults + permissive validation.
  target.ts    # Parses PR target: "owner/repo#n" or full GitHub URL.
  github.ts    # GraphQL polling via `gh`; normalizes payload into PrSnapshot.
  activity.ts  # detectActivity(prev, next): what counts as a change.
  watch.ts     # PrWatch — per-PR state machine (tick, debounce, deliver).
  report.ts    # Markdown report rendering.
```

## Core flow

1. **Plugin load** — `PrMonitorPlugin({ client, directory, worktree, $ })` (`src/index.ts:18`) builds hooks + registers the `pr_monitor` tool. Maintains `watches: Map<"${sessionID} ${owner/repo#n}", Entry>`.
2. **Tool** — `pr_monitor` with `action: start|stop|flush|status` and optional `pr` (`src/index.ts:140-188`).
3. **start** — `startWatch` (`src/index.ts:87`): parse target → dedupe → `loadConfig` → fetch initial snapshot → reject if not `OPEN` → `new PrWatch(...)` → arm `setInterval(tick, pollIntervalSeconds*1000)`.
4. **tick** — `PrWatch.tick()` (`src/watch.ts:65`): fetch snapshot → `detectActivity` → mark dirty/reset debounce → `maybeAutoFlush()`.
5. **deliver** — `deliver(sessionID, agent)` (`src/index.ts:64`) calls `client.session.promptAsync({ path:{id}, body:{agent, model, parts:[{type:"text", text}]} })`. `promptAsync` never rejects on server error — check `result.error`. All messages are Markdown, prefixed `[PR Monitor]` with a clickable `[owner/repo#n](url)` link.

## Key behaviors / gotchas

- **agent captured at start time** and passed into `deliver` (the default agent is a subagent, which fails — must be explicit). **model captured per-message** via the `chat.message` hook (`sessionModels` map) so reports use the user's current model.
- **Debounce + CI-hold** in `maybeAutoFlush` (`src/watch.ts:139`): wait `debounceMinutes` of quiet after activity; if CI is running on an OPEN PR, hold up to `maxCiWaitMinutes` before flushing.
- **detectActivity** (`src/activity.ts:22`): state, mergeable, reviews, unresolved threads, inline comments, issue comments, and CI **conclusion** count as activity. CI transitions into "running" and per-check progress do **NOT**.
- **Failure handling** — `handlePollFailure` (`src/watch.ts:124`): notFound → stop with notice; 10 consecutive poll failures → stop. 10 consecutive delivery failures → stop. Delivery failures roll back the baseline so the same activity is retried.
- **Reentrancy guard** — `ticking` flag prevents overlapping polls.
- **Reload takeover** — `globalThis.__sesoriPrMonitorTakeovers` (`src/index.ts:37`) kills zombie timers from prior plugin instances; old watches send one factual stop notice.
- **Lifecycle** — `session.deleted` event and `dispose` hook stop matching watches.
- Reports are **facts only**: counts and authors, never comment bodies or advice.

## Configuration

File: `.opencode/pr-monitor.json` (searched in `directory`, then `worktree`). Loaded fresh per `startWatch`. See `src/config.ts`.

`MonitorConfig` (`src/config.ts:7`):

| Key | Default | Notes |
|---|---|---|
| `debounceMinutes` | 5 | Quiet window after activity before flushing. |
| `maxCiWaitMinutes` | 30 | Upper bound on CI-hold. |
| `pollIntervalSeconds` | 60 | Clamped to min 30 (`MIN_POLL_INTERVAL_SECONDS`). |
| `ignoreCommentTag` | undefined | Drops own comments containing this tag (resolves self login via `gh api user`). |
| `announceOnStart` | true | Deliver a full status report immediately on start (`PrWatch.announceInitial`, `src/watch.ts`) so the session sees outstanding items. Reports against baseline 0, then advances baseline to the initial snapshot. |

`resolveConfig` is permissive: unknown keys ignored, non-positive numbers and non-string tags dropped, invalid JSON logged (not thrown), missing file → defaults.

## GitHub layer

- `createGhRunner($)` (`src/github.ts:39`) wraps Bun `$` shell: ``$`gh ${args}`.quiet().nothrow()``, throws `PollError(msg, { notFound })` on non-zero exit.
- Single GraphQL doc `PR_QUERY` (`src/github.ts:51`) fetches title, url, state, mergeable, head SHA, latest commit's check rollup, review requests/latestReviews, review threads + comments, issue comment count.
- `normalizeSnapshot` (`src/github.ts:111`) → `PrSnapshot`; `ciPhase` → `none|running|concluded`.
