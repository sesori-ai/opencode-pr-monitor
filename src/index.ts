// pr-monitor — opencode plugin that watches GitHub PRs and reports changes.
//
// One watch per PR, owned by the session that started it. Polls GitHub via
// `gh api graphql` (one query per watch per tick). Reports are delivered to
// the owning session via promptAsync as "[PR Monitor]" messages. In-memory
// only: opencode restarts drop all watches by design. See README.md for the
// full design.
//
// The opencode plugin loader invokes EVERY export of this entry module as a
// plugin, so `PrMonitorPlugin` must stay the sole export.

import { tool, type Plugin } from "@opencode-ai/plugin"
import { loadConfig, type MonitorConfig } from "./config"
import { createGhRunner, fetchPrSnapshot, type PrSnapshot } from "./github"
import { parseTarget, targetKey, type Target } from "./target"
import { PrWatch } from "./watch"

export const PrMonitorPlugin: Plugin = async ({ client, directory, worktree, $ }) => {
  type Entry = { watch: PrWatch; timer: ReturnType<typeof setInterval> }
  const watches = new Map<string, Entry>() // key: `${sessionID} ${owner/repo#n}`

  // Latest model per session, captured from user messages and replayed on report
  // deliveries so a long-lived watch keeps using the model the user is working
  // with rather than whatever the server re-resolves at delivery time (which can
  // drift onto a since-removed model). Intentionally never pruned: a session can
  // own several monitors so per-monitor cleanup by session key is unsafe, and
  // entries are tiny — unbounded growth is a non-issue in practice.
  const sessionModels = new Map<string, { providerID: string; modelID: string }>()

  // Plugin reloads can re-instantiate this plugin without finalizing the
  // previous instance, leaving its setInterval timers polling as invisible
  // zombies that deliver duplicate reports (observed live). Each instance
  // registers a killer on globalThis, keyed by project directory (instances
  // are per-directory; a process can host several projects); the next
  // same-directory instance invokes it on init. Killed watches send one
  // factual stop notice so owning sessions can re-start monitoring.
  const globalState = globalThis as { __sesoriPrMonitorTakeovers?: Map<string, () => void> }
  const takeovers = (globalState.__sesoriPrMonitorTakeovers ??= new Map())
  takeovers.get(directory)?.()
  takeovers.set(directory, () => {
    for (const entry of [...watches.values()]) {
      entry.watch.stopWithNotice(
        "Monitor stopped: the pr-monitor plugin was reloaded. Re-start monitoring if still needed.",
      )
    }
  })
  let selfLogin: string | undefined

  const log = (message: string): void => {
    void client.app.log({ body: { service: "pr-monitor", level: "info", message } }).catch(() => {})
  }

  const runGh = createGhRunner($)

  const fetchSnapshot = (target: Target, config: MonitorConfig): Promise<PrSnapshot> =>
    fetchPrSnapshot({ runGh, target, ignoreTag: config.ignoreCommentTag, selfLogin })

  // `agent` must be sent explicitly: agent-less prompts resolve to the server's
  // default agent, which fails when that default is configured as a subagent
  // (observed live: 'default agent "build" is a subagent').
  // The SDK client defaults to responseStyle "fields" / throwOnError false:
  // promptAsync resolves { data, error } and NEVER rejects on server errors,
  // so delivery failure must be detected via the error field explicitly.
  const deliver = (sessionID: string, agent: string) => async (report: string): Promise<void> => {
    const model = sessionModels.get(sessionID)
    const result = await client.session.promptAsync({
      path: { id: sessionID },
      body: { agent, model, parts: [{ type: "text", text: report }] },
    })
    if (result.error !== undefined) {
      throw new Error(`prompt_async rejected: ${JSON.stringify(result.error)}`)
    }
  }

  const sessionWatches = (sessionID: string): PrWatch[] =>
    [...watches.values()].filter((entry) => entry.watch.sessionID === sessionID).map((entry) => entry.watch)

  const selectWatches = (sessionID: string, pr: string): PrWatch[] | { error: string } => {
    if (pr === "all") return sessionWatches(sessionID)
    const target = parseTarget(pr)
    if ("error" in target) return target
    const entry = watches.get(`${sessionID} ${targetKey(target)}`)
    if (!entry) return { error: `No monitor for ${targetKey(target)} in this session. Use action "status" to list active monitors.` }
    return [entry.watch]
  }

  const startWatch = async (sessionID: string, agent: string, pr: string): Promise<string> => {
    const target = parseTarget(pr)
    if ("error" in target) return target.error
    const key = `${sessionID} ${targetKey(target)}`
    const existing = watches.get(key)
    if (existing) return `Already monitoring ${targetKey(target)} in this session.\n${existing.watch.statusLine()}`

    const config = await loadConfig([directory, worktree], log)
    if (config.ignoreCommentTag !== undefined && selfLogin === undefined) {
      try {
        selfLogin = (await runGh(["api", "user", "--jq", ".login"])).trim()
      } catch (error) {
        return `Cannot start monitor: ignoreCommentTag is configured but resolving the authenticated gh user failed (${(error as Error).message}). Run \`gh auth status\` to check.`
      }
    }

    let initial: PrSnapshot
    try {
      initial = await fetchSnapshot(target, config)
    } catch (error) {
      return `Cannot start monitor for ${targetKey(target)}: ${(error as Error).message}`
    }
    if (initial.state !== "OPEN") return `Cannot start monitor: ${targetKey(target)} is already ${initial.state}.`

    const watch = new PrWatch({
      target,
      sessionID,
      config,
      initial,
      deps: {
        now: Date.now,
        fetchSnapshot: () => fetchSnapshot(target, config),
        deliver: deliver(sessionID, agent),
        log,
        onStopped: () => {
          const entry = watches.get(key)
          if (entry) clearInterval(entry.timer)
          watches.delete(key)
        },
      },
    })
    const timer = setInterval(() => void watch.tick(), config.pollIntervalSeconds * 1000)
    watches.set(key, { watch, timer })
    log(`started monitoring ${targetKey(target)} for session ${sessionID}`)
    return (
      `Started monitoring ${targetKey(target)} — "${initial.title}".\n` +
      `Polling every ${config.pollIntervalSeconds}s; reports arrive in this session as [PR Monitor] messages after ` +
      `${config.debounceMinutes} quiet minutes following detected activity. The monitor stops automatically when the PR ` +
      `is merged or closed, and does not survive an opencode restart.`
    )
  }

  return {
    tool: {
      pr_monitor: tool({
        description:
          "Monitor a GitHub PR in the background. Detects CI suite conclusions, new reviews, new inline/issue comments, " +
          "mergeability changes, and merge/close. Changes are aggregated (rolling debounce) and delivered to THIS session " +
          "as a '[PR Monitor]' message stating facts only. Actions: start (begin watching a PR), stop (end watching), " +
          "flush (on-demand: immediately return a full status report and reset the 'new since' baseline; a delivered " +
          "report already advances the baseline, so a flush after handling one is not needed), status (list this " +
          "session's monitors). The pr argument must be explicit 'owner/repo#123' or a full " +
          "PR URL; 'all' is allowed for stop/flush. Tuning lives in .opencode/pr-monitor.json. Monitors are per-session " +
          "and do not survive opencode restarts.",
        args: {
          action: tool.schema.enum(["start", "stop", "flush", "status"]).describe("What to do"),
          pr: tool.schema
            .string()
            .optional()
            .describe("PR identifier: 'owner/repo#123' or PR URL. Required for start/stop/flush; 'all' allowed for stop/flush."),
        },
        async execute(args, context) {
          const sessionID = context.sessionID
          switch (args.action) {
            case "start": {
              if (!args.pr || args.pr === "all") return "action 'start' requires a single explicit pr: 'owner/repo#123' or a PR URL."
              return await startWatch(sessionID, context.agent, args.pr)
            }
            case "stop": {
              if (!args.pr) return "action 'stop' requires pr: 'owner/repo#123', a PR URL, or 'all'."
              const selected = selectWatches(sessionID, args.pr)
              if ("error" in selected) return selected.error
              if (selected.length === 0) return "No active monitors in this session."
              for (const watch of selected) watch.stop()
              return `Stopped ${selected.length} monitor(s): ${selected.map((watch) => targetKey(watch.target)).join(", ")}.`
            }
            case "flush": {
              if (!args.pr) return "action 'flush' requires pr: 'owner/repo#123', a PR URL, or 'all'."
              const selected = selectWatches(sessionID, args.pr)
              if ("error" in selected) return selected.error
              if (selected.length === 0) return "No active monitors in this session."
              const reports = await Promise.all(selected.map((watch) => watch.manualFlush()))
              return reports.join("\n\n")
            }
            case "status": {
              const active = sessionWatches(sessionID)
              if (active.length === 0) return "No active monitors in this session."
              return active.map((watch) => watch.statusLine()).join("\n")
            }
          }
        },
      }),
    },

    "chat.message": async (input) => {
      if (input.model === undefined) return
      sessionModels.set(input.sessionID, input.model)
    },

    event: async ({ event }) => {
      if (event.type !== "session.deleted") return
      const sessionID = (event.properties as { info?: { id?: string } })?.info?.id
      if (!sessionID) return
      for (const entry of [...watches.values()]) {
        if (entry.watch.sessionID === sessionID) entry.watch.stop()
      }
    },

    dispose: async () => {
      for (const entry of [...watches.values()]) entry.watch.stop()
    },
  }
}
