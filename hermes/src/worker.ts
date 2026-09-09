// One stdio worker per Hermes conversation. The Python host owns routing;
// MonitorSession owns all GitHub polling, readiness and retry behavior.
import { createInterface } from "node:readline"
import { isAbsolute, resolve } from "node:path"
import { loadMonitorConfig } from "../../core/config"
import { MonitorSession, InitialAnnouncementMode } from "../../runtime/monitor-session"
import { createNodeGhRunner } from "../../runtime/node-gh"
import { buildMonitorToolDescription, MONITOR_ACTION_VALUES, type MonitorAction } from "../../runtime/tool"

const description = buildMonitorToolDescription({
  delivery: "Background monitoring requires Hermes Desktop/TUI: reports start a turn in the owning conversation when idle and inject into its active turn when busy. Standalone mark_ready/unmark_ready actions need no background-delivery route and work on other Hermes hosts.",
  configPath: "repository .pr-monitor.json, then .hermes/pr-monitor.json, then .opencode/pr-monitor.json",
  lifecycle: "Watches stop on conversation finalization, plugin unload, or host exit; restart them after a restart.",
  waiting: "When nothing remains to handle, end the turn; never create a waiter.",
})
const schema = {
  name: "pr_monitor", description,
  parameters: { type: "object", properties: {
    action: { type: "string", enum: MONITOR_ACTION_VALUES },
    pr: { type: "string", description: "Explicit owner/repo#123 or GitHub PR URL; all only for stop/flush." },
  }, required: ["action"], additionalProperties: false },
}

if (process.argv.includes("--describe")) {
  console.log(JSON.stringify(schema, null, 2))
} else {
  const log = (message: string) => console.error(`[pr-monitor] ${message}`)
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n")
  let sequence = 0
  let closed = false
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  const deliver = ({ report }: { report: string }) => new Promise<void>((accept, reject) => {
    if (closed) { reject(new Error("Hermes bridge closed")); return }
    const id = ++sequence
    // The host replies only after the destination accepts the report. A failure
    // rejects into PrWatch, which restores its baseline and retries at poll cadence.
    pending.set(id, { resolve: accept, reject })
    send({ type: "report", id, report })
  })
  const loadConfig = (cwd: string) => loadMonitorConfig({ paths: [
    resolve(cwd, ".pr-monitor.json"), resolve(cwd, ".hermes/pr-monitor.json"), resolve(cwd, ".opencode/pr-monitor.json"),
  ], log })
  const session = new MonitorSession({ runGh: createNodeGhRunner(), log })
  const shutdown = async () => {
    if (closed) return
    closed = true
    for (const callback of pending.values()) callback.reject(new Error("Hermes bridge closed"))
    pending.clear()
    await session.stopAll({})
    process.exit(0)
  }
  const input = createInterface({ input: process.stdin })
  // Read delivery acknowledgements independently of commands: start/flush can
  // await a report while the acknowledgement is arriving on this same stream.
  input.on("line", (line) => {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) } catch { log("invalid bridge JSON"); return }
    if (message.type === "ack") {
      const callback = pending.get(message.id as number)
      if (!callback) return
      pending.delete(message.id as number)
      if (message.ok === true) callback.resolve()
      else callback.reject(new Error(typeof message.error === "string" ? message.error : "Hermes rejected report"))
      return
    }
    if (message.type !== "command" || closed) return
    const id = message.id
    if (!MONITOR_ACTION_VALUES.includes(message.action as MonitorAction) ||
        (message.pr !== undefined && typeof message.pr !== "string") ||
        typeof message.cwd !== "string" || !isAbsolute(message.cwd)) {
      send({ type: "result", id, error: "Invalid monitor action or PR" }); return
    }
    void session.execute({
      action: message.action as MonitorAction, pr: message.pr as string | undefined,
      loadConfig: () => loadConfig(message.cwd as string),
      start: { announcementMode: InitialAnnouncementMode.background, createChannel: () => ({ deliver }) },
    }).then(result => send({ type: "result", id, text: result.text + (result.start
        ? `\nAgent replies must begin with ${JSON.stringify(result.start.config.ignoreCommentTag)}. ` +
          "Assess current-head checks, automated reviews and feedback immediately; empty fresh results do not establish readiness."
        : "") }),
      error => send({ type: "result", id, error: String(error) }))
  })
  input.on("close", () => { void shutdown() })
  process.on("SIGTERM", () => { void shutdown() })
  process.on("SIGINT", () => { void shutdown() })
}
