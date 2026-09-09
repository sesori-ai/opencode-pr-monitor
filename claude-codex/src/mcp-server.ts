// pr-monitor — Claude Code / Codex adapter. Codex MCP calls are scoped by threadId.
// Reports are pushed straight into that session over its messaging socket
// (see push.ts) so they arrive on their own — even while the session is idle —
// exactly like the OpenCode and Pi channels. A failed push rejects so the
// watch retries it at poll cadence; only hosts without the socket fall back to
// spooling for the hooks to inject, guarded by the keep-alive loop.
//
// Codex has no messaging socket, so it always runs the spool + hooks path. It
// launches this bundle from .codex-mcp.json with cwd = plugin root, passes the
// args verbatim, and exports no plugin or project env (verified on 0.153).

import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import process from "node:process"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { loadClaudeConfig, type ClaudeMonitorConfig } from "../../core/config"
import { targetKey, targetRegistryKey, type Target } from "../../core/target"
import {
  InitialAnnouncementMode,
  InitialAnnouncementState,
  MonitorSession,
  StopNoticeChannel,
  WatchChangeType,
  type MonitorActionResult,
} from "../../runtime/monitor-session"
import { createNodeGhRunner } from "../../runtime/node-gh"
import {
  buildMonitorToolDescription,
  MONITOR_ACTION_VALUES,
  MonitorAction,
} from "../../runtime/tool"
import { messagingChannel, pushMessage } from "./push"
import { writeSessionState } from "./session-state"
import { claimSpool, collectDeadSpools, notifyDesktop, probeSpool, spoolReport, SPOOL_ROOT, startToken } from "./spool"

const claudePid = process.ppid
const isCodex = process.argv.includes("--codex")
const pushChannel = isCodex ? undefined : messagingChannel()
const hostName = isCodex ? "Codex" : "Claude Code"
const log = (message: string): void => console.error(`[pr-monitor] ${message}`)
const runGh = createNodeGhRunner()

// The app-server can own multiple conversations. Each has its own runtime,
// configuration and queue; a parent PID identifies only the host lifetime.
const createAdapter = ({ sessionId, projectDir }: { sessionId: string | undefined; projectDir: string }) => {
  const configPaths = [
    join(projectDir, ".pr-monitor.json"),
    join(projectDir, isCodex ? ".codex" : ".claude", "pr-monitor.json"),
    join(projectDir, ".opencode", "pr-monitor.json"),
  ]

  const handedOff = new Set<string>()
  let keepAliveUntilMs = 0
  const STATE_LIVENESS_FLOOR_MS = 5 * 60_000

  let monitorSession: MonitorSession<ClaudeMonitorConfig>

  const refreshSessionState = (): void => {
    const watches = monitorSession.list()
    const active = watches.filter(({ target }) => !handedOff.has(targetRegistryKey(target)))
    const pollMs = Math.max(...watches.map(({ config }) => config.pollIntervalSeconds * 1000), 0)
    writeSessionState(claudePid, {
      version: 1,
      // With a push channel the session may go idle freely — the next report
      // wakes it by itself, so the Stop hook must not hold turn-end. A failed
      // push is retried by the watch at poll cadence (see deliver), never parked
      // behind hooks an idle session cannot fire.
      keepAlive: pushChannel === undefined && active.some(({ config }) => config.keepAlive),
      expiresAtMs: Date.now() + Math.max(pollMs * 3 + 60_000, STATE_LIVENESS_FLOOR_MS),
      keepAliveUntilMs,
      monitors: active.map(({ target }) => targetKey(target)),
    }, sessionId)
  }

  const extendKeepAlive = ({ config }: { config: ClaudeMonitorConfig }): void => {
    keepAliveUntilMs = Math.max(keepAliveUntilMs, Date.now() + config.keepAliveMaxMinutes * 60_000)
  }

  const deliver = async ({
    target,
    config,
    report,
  }: {
    target: Target
    config: ClaudeMonitorConfig
    report: string
  }): Promise<void> => {
    if (pushChannel !== undefined) {
      // Rejection is deliberate: the watch rolls back its baseline and retries
      // the push at poll cadence, which can wake an idle session the moment the
      // socket recovers. Spooling here instead would strand the report behind
      // hook events an idle session never fires; persistent push failure ends in
      // the watch's own stop-after-consecutive-failures notice.
      await pushMessage({ channel: pushChannel, text: report })
      extendKeepAlive({ config })
      refreshSessionState()
      if (config.desktopNotifications) {
        notifyDesktop(`PR Monitor — ${targetKey(target)}`, `New report delivered to your ${hostName} session`)
      }
      return
    }
    spoolReport(claudePid, report, sessionId)
    extendKeepAlive({ config })
    refreshSessionState()
    if (config.desktopNotifications) {
      notifyDesktop(`PR Monitor — ${targetKey(target)}`, `New report waiting in your ${hostName} session`)
    }
  }

  monitorSession = new MonitorSession<ClaudeMonitorConfig>({
    runGh,
    loadConfig: () => loadClaudeConfig({ paths: configPaths, log }),
    log,
    onWatchChanged: ({ type, target, config }) => {
      if (type === WatchChangeType.started) extendKeepAlive({ config })
      else handedOff.delete(targetRegistryKey(target))
      refreshSessionState()
    },
    onTickSettled: refreshSessionState,
    onReadyChanged: ({ target, ready, watched, config }) => {
      if (ready && watched) handedOff.add(targetRegistryKey(target))
      if (!ready) {
        handedOff.delete(targetRegistryKey(target))
        if (watched) extendKeepAlive({ config })
      }
      refreshSessionState()
    },
    statusSuffix: ({ target }) =>
      handedOff.has(targetRegistryKey(target)) ? ", handed off for human review" : "",
  })

  const prepareStart = async (): Promise<string | undefined> => {
    // With a push channel the spool only carries shutdown notices; an unwritable
    // spool must not block a start whose reports never touch it.
    if (pushChannel !== undefined) return undefined
    try {
      probeSpool(claudePid, sessionId)
      return undefined
    } catch (error) {
      return (
        `Cannot start monitor: the report spool is not writable (${(error as Error).message}). ` +
        "Reports could not be delivered. Check permissions on ~/.claude/pr-monitor."
      )
    }
  }

  const formatResult = ({ result }: { result: MonitorActionResult<ClaudeMonitorConfig> }): string => {
    if (result.start !== undefined) {
      const { config, announcement } = result.start
      const replyPrefix = config.ignoreCommentTag ?? "<!-- pr-monitor:reply -->"
      return (
        `${result.text}\n` +
        (config.announceOnStart
          ? announcement === InitialAnnouncementState.delivered
            ? pushChannel !== undefined
              ? "An initial [PR Monitor] report has been delivered into this session. "
              : "An initial [PR Monitor] report is spooled for the next hook event. "
            : "Initial delivery failed and will retry at the next poll without losing its baseline. "
          : "") +
        (pushChannel !== undefined
          ? `Polling every ${config.pollIntervalSeconds}s; settled activity arrives on its own as a ` +
            `'[PR Monitor]' message after ${config.debounceMinutes} quiet minutes — even while this session is idle. `
          : `Polling every ${config.pollIntervalSeconds}s; settled activity is injected automatically ` +
            `at the next tool call, user message, or turn end after ${config.debounceMinutes} quiet minutes. `) +
        (config.flushOnCiFailure
          ? "A failing check is reported at the next poll without waiting for the quiet window or the rest of CI. "
          : "") +
        "A new merge conflict or terminal state is also immediate. " +
        `Readiness is managed automatically; agent-authored GitHub replies must begin with \`${replyPrefix}\`. ` +
        "Use mark_ready when new feedback is non-actionable and no reply should be posted. " +
        "Never invent sleeps, delays, timeouts, scheduled checks, polling loops, repeated CI checks, or routine " +
        "status/flush calls — the monitor delivers on its own. " +
        `The monitor stops on merge/close and does not survive this ${hostName} session.` +
        (pushChannel !== undefined
          ? "\nEnd the turn when there is nothing left to handle; a new report starts its own turn."
          : config.keepAlive
            ? "\nKeep-alive follows the ready label. Run only the exact await-activity command supplied by a " +
              "[PR Monitor keep-alive] message; do not create another waiting mechanism."
            : "")
      )
    }
    if (result.ready?.ready && result.ready.watched) {
      return (
        `${result.text}\nStill monitoring it, but it no longer holds this session open; ` +
        "new activity re-opens the work loop."
      )
    }
    return result.text
  }

  const handle = async ({
    action,
    pr,
  }: {
    action: MonitorAction
    pr: string | undefined
  }): Promise<string> => {
    const result = await monitorSession.execute({
      action,
      pr,
      start:
        action === MonitorAction.start
          ? {
              prepare: prepareStart,
              announcementMode: InitialAnnouncementMode.awaitDelivery,
              createChannel: ({ target, config }) => ({
                deliver: ({ report }) => deliver({ target, config, report }),
                persist: ({ report }) => {
                  spoolReport(claudePid, report, sessionId)
                  return Promise.resolve()
                },
              }),
            }
          : undefined,
    })
    return formatResult({ result })
  }

  const shutdown = async (): Promise<void> => {
    await monitorSession.stopAll({
      notice: "Monitor stopped: the pr-monitor MCP server is shutting down " +
        `(${hostName} session ended or server restarted). Re-start monitoring if still needed.`,
      channel: StopNoticeChannel.persistent,
    })
    writeSessionState(claudePid, {
      version: 1, keepAlive: false, expiresAtMs: 0, keepAliveUntilMs: 0, monitors: [],
    }, sessionId)
  }
  return { handle, shutdown }
}

type Adapter = ReturnType<typeof createAdapter>
const adapters = new Map<string, Adapter>()
if (!isCodex) {
  adapters.set("claude", createAdapter({
    sessionId: undefined,
    projectDir: process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd(),
  }))
}

const adapterFor = (meta: Record<string, unknown> | undefined): Adapter => {
  if (!isCodex) return adapters.get("claude")!
  // Codex 0.153+ sets _meta.threadId on MCP calls. Never guess from the
  // app-server PID, its cwd, or another conversation's most recent hook.
  const sessionId = meta?.["threadId"]
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error("Cannot route this monitor: Codex did not supply a valid MCP threadId. Update Codex and reconnect the plugin.")
  }
  const existing = adapters.get(sessionId)
  if (existing !== undefined) return existing
  let projectDir: unknown
  try {
    const context = JSON.parse(readFileSync(join(SPOOL_ROOT, "codex-contexts", `${sessionId}.json`), "utf8"))
    const token = startToken(claudePid)
    const registeredHere = Array.isArray(context.owners) && context.owners.some(
      (owner: { pid?: unknown; token?: unknown }) => owner?.pid === claudePid && owner.token === token,
    )
    if (registeredHere) projectDir = context.cwd
  } catch {
    // Give the caller a delivery error instead of silently using plugin/host cwd.
  }
  if (typeof projectDir !== "string" || !isAbsolute(projectDir)) {
    throw new Error("Cannot start monitoring: the PR Monitor delivery hook has not registered this Codex conversation in the current host. " +
      "Installing the plugin does not grant hook trust. Open Codex CLI on the host running this session " +
      "(same OS user and CODEX_HOME), run /hooks, and enable/trust PR Monitor's SessionStart, UserPromptSubmit, " +
      "PostToolUse, and Stop hooks. In Sesori or another client without /hooks, use a terminal on that host. " +
      "Then send a new prompt here and retry. Updated hooks may need review again. " +
      "Setup: https://github.com/sesori-ai/pr-monitor-plugin#trust-the-delivery-hooks-required\n" +
      "No monitor was started; reports cannot be delivered until hooks run.")
  }
  const adapter = createAdapter({ sessionId, projectDir })
  adapters.set(sessionId, adapter)
  return adapter
}

let shuttingDown = false
const shutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  void Promise.all([...adapters.values()].map((adapter) => adapter.shutdown())).finally(() => process.exit(0))
}
process.stdin.on("end", shutdown)
process.stdin.on("close", shutdown)
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

claimSpool(claudePid)
collectDeadSpools(claudePid)

const server = new McpServer({ name: "pr-monitor", version: "0.4.1" })

server.registerTool(
  "pr_monitor",
  {
    description: buildMonitorToolDescription({
      delivery:
        pushChannel !== undefined
          ? "reports are pushed into THIS session as visible '[PR Monitor]' messages, even while it is idle."
          : "reports are injected into THIS session as '[PR Monitor]' messages at hook events.",
      configPath: `.pr-monitor.json (falling back to ${isCodex ? ".codex" : ".claude"}/pr-monitor.json, then .opencode/pr-monitor.json)`,
      lifecycle: `Monitors are per-session and do not survive ${hostName} restarts.`,
      waiting:
        pushChannel !== undefined
          ? "The monitor delivers on its own; never set up delays, timeouts, or waiters for it. End the turn when " +
            "idle — a new report starts its own turn."
          : "End the turn when idle. If a [PR Monitor keep-alive] message supplies an await-activity command, run only " +
            "that exact event waiter; never invent another delay or polling mechanism.",
    }),
    inputSchema: {
      action: z.enum(MONITOR_ACTION_VALUES).describe("What to do"),
      pr: z
        .string()
        .optional()
        .describe(
          "PR identifier: 'owner/repo#123' or PR URL. Required for start/stop/flush/mark_ready/unmark_ready; " +
            "'all' allowed for stop/flush.",
        ),
    },
  },
  async ({ action, pr }, extra) => {
    try {
      const text = await adapterFor(extra._meta).handle({ action, pr })
      return { content: [{ type: "text" as const, text }] }
    } catch (error) {
      log(String(error))
      return { isError: true, content: [{ type: "text" as const, text: String(error) }] }
    }
  },
)

await server.connect(new StdioServerTransport())
log(`pr-monitor MCP server ready (${hostName} host pid ${claudePid})`)
