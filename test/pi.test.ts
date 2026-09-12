import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { MonitorConfig } from "../core/config"
import type { GhRunner, PrSnapshot } from "../core/github"
import { registerPiMonitor, piMonitorConfigPaths } from "../pi/extension"
import { registerOmpMonitor } from "../pi/omp-adapter"
import { MonitorAction } from "../runtime/tool"

type RegisteredPiTool = {
  name: string
  description: string
  execute: (
    toolCallId: string,
    params: { action: MonitorAction; pr?: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>
}

type ExtensionHandler = (event: unknown, context: ExtensionContext) => unknown | Promise<unknown>
type SentMessage = {
  message: { customType: string; content: string; display: boolean }
  options: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean }
  idle: boolean
}

function fakePiHarness() {
  const handlers = new Map<string, ExtensionHandler[]>()
  const messages: SentMessage[] = []
  const messageWaiters: Array<{ count: number; resolve: () => void }> = []
  let tool: RegisteredPiTool | undefined
  let idle = true
  const implementation = {
    on(event: string, handler: ExtensionHandler) {
      const existing = handlers.get(event) ?? []
      existing.push(handler)
      handlers.set(event, existing)
    },
    registerTool(registered: RegisteredPiTool) {
      tool = registered
    },
    sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
      messages.push({ message, options, idle })
      for (const waiter of messageWaiters.splice(0)) {
        if (messages.length >= waiter.count) waiter.resolve()
        else messageWaiters.push(waiter)
      }
    },
  }
  return {
    pi: implementation as unknown as ExtensionAPI,
    handlers,
    messages,
    get tool(): RegisteredPiTool {
      assert.ok(tool)
      return tool
    },
    setIdle(value: boolean) {
      idle = value
    },
    waitForMessageCount(count: number): Promise<void> {
      if (messages.length >= count) return Promise.resolve()
      return new Promise((resolveWait) => messageWaiters.push({ count, resolve: resolveWait }))
    },
  }
}

type FakeTimer = { callback: () => void; cancelled: boolean }

function timerHarness() {
  const timers: FakeTimer[] = []
  return {
    timers,
    schedule: ({ callback }: { callback: () => void; intervalMs: number }): FakeTimer => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return timer
    },
    cancel: ({ timer }: { timer: unknown }): void => {
      ;(timer as FakeTimer).cancelled = true
    },
  }
}

function monitorConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    debounceMinutes: 2,
    maxCiWaitMinutes: 30,
    pollIntervalSeconds: 30,
    ignoreCommentTag: undefined,
    announceOnStart: true,
    flushOnCiFailure: true,
    readyLabel: "ready-for-human-review",
    autoMerge: false,
    ...overrides,
  }
}

function payload({ state = "OPEN" }: { state?: PrSnapshot["state"] } = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          title: "test PR",
          url: "https://github.com/sesori/example/pull/42",
          state,
          mergeable: "MERGEABLE",
          headRefOid: "head-1",
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { nodes: [] },
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          labels: { nodes: [] },
        },
      },
    },
  })
}

function runnerHarness({ states = ["OPEN"] }: { states?: PrSnapshot["state"][] } = {}) {
  let snapshotIndex = 0
  let labelAdded = false
  const runGh: GhRunner = async (args) => {
    if (args[0] === "api" && args[1] === "graphql") {
      const state = states[Math.min(snapshotIndex, states.length - 1)] ?? "OPEN"
      snapshotIndex += 1
      return payload({ state })
    }
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route.includes("/pulls/")) return JSON.stringify({ state: "open", merged: false })
    if (/\/labels$/.test(route) && !route.includes("/issues/")) throw new Error("label already exists")
    if (route.includes("/issues/") && args.includes("DELETE")) {
      labelAdded = false
      return ""
    }
    if (route.includes("/issues/")) {
      labelAdded = true
      return ""
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }
  return { runGh, get labelAdded() { return labelAdded } }
}

function extensionContext({
  trusted = true,
  cwd = process.cwd(),
}: {
  trusted?: boolean
  cwd?: string
} = {}): ExtensionContext {
  return {
    cwd,
    isProjectTrusted: () => trusted,
  } as unknown as ExtensionContext
}

async function executeTool({
  tool,
  action,
  pr,
  context = extensionContext(),
}: {
  tool: RegisteredPiTool
  action: MonitorAction
  pr?: string
  context?: ExtensionContext
}): Promise<string> {
  const result = await tool.execute("call-1", { action, pr }, undefined, undefined, context)
  return result.content[0]?.text ?? ""
}

test("Pi registers every monitor action and uses native steering delivery", async () => {
  const pi = fakePiHarness()
  const timers = timerHarness()
  const runner = runnerHarness()
  registerPiMonitor({
    pi: pi.pi,
    dependencies: {
      runGh: runner.runGh,
      loadConfig: async () => monitorConfig(),
      schedule: timers.schedule,
      cancel: timers.cancel,
      log: () => {},
    },
  })

  assert.equal(pi.tool.name, "pr_monitor")
  assert.match(pi.tool.description, /notifications arrive automatically/)
  assert.match(pi.tool.description, /end the turn/i)
  const start = await executeTool({ tool: pi.tool, action: MonitorAction.start, pr: "sesori/example#42" })
  assert.match(start, /Started monitoring/)
  assert.match(start, /`<!-- pr-monitor:reply -->`/)
  await pi.waitForMessageCount(1)
  assert.equal(pi.messages.length, 1)
  assert.deepEqual(pi.messages[0]?.options, { deliverAs: "steer", triggerTurn: true })
  assert.equal(pi.messages[0]?.message.customType, "pr-monitor")
  assert.equal(pi.messages[0]?.message.display, true)

  assert.match(await executeTool({ tool: pi.tool, action: MonitorAction.status }), /sesori\/example#42/)
  assert.match(
    await executeTool({ tool: pi.tool, action: MonitorAction.flush, pr: "sesori/example#42" }),
    /^\[PR Monitor\]/,
  )
  assert.match(
    await executeTool({ tool: pi.tool, action: MonitorAction.markReady, pr: "sesori/example#42" }),
    /label "ready-for-human-review" added/,
  )
  assert.equal(runner.labelAdded, true)
  assert.match(
    await executeTool({ tool: pi.tool, action: MonitorAction.unmarkReady, pr: "sesori/example#42" }),
    /no longer flagged for human review/,
  )
  assert.equal(runner.labelAdded, false)
  assert.match(await executeTool({ tool: pi.tool, action: MonitorAction.stop, pr: "all" }), /Stopped 1 monitor/)
  assert.equal(timers.timers[0]?.cancelled, true)
})

test("Pi keeps a watched target on its start-time readiness configuration", async () => {
  const pi = fakePiHarness()
  const timers = timerHarness()
  const runner = runnerHarness()
  const loadedDirectories: string[] = []
  registerPiMonitor({
    pi: pi.pi,
    dependencies: {
      runGh: runner.runGh,
      loadConfig: async ({ context }) => {
        loadedDirectories.push(context.cwd)
        return monitorConfig({ announceOnStart: false })
      },
      schedule: timers.schedule,
      cancel: timers.cancel,
      log: () => {},
    },
  })

  await executeTool({
    tool: pi.tool,
    action: MonitorAction.status,
    context: extensionContext({ cwd: resolve("first-project") }),
  })
  await executeTool({
    tool: pi.tool,
    action: MonitorAction.start,
    pr: "sesori/example#42",
    context: extensionContext({ cwd: resolve("second-project") }),
  })
  await executeTool({
    tool: pi.tool,
    action: MonitorAction.markReady,
    pr: "sesori/example#42",
    context: extensionContext({ cwd: resolve("third-project") }),
  })

  assert.deepEqual(loadedDirectories, [resolve("second-project")])
  await pi.handlers.get("session_shutdown")?.[0]?.({}, extensionContext())
})

test("Pi reports through the same steering options while busy and idle", async () => {
  const pi = fakePiHarness()
  const timers = timerHarness()
  const runner = runnerHarness({ states: ["OPEN", "MERGED"] })
  registerPiMonitor({
    pi: pi.pi,
    dependencies: {
      runGh: runner.runGh,
      loadConfig: async () => monitorConfig(),
      schedule: timers.schedule,
      cancel: timers.cancel,
      log: () => {},
    },
  })

  pi.setIdle(false)
  await executeTool({ tool: pi.tool, action: MonitorAction.start, pr: "sesori/example#42" })
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
  const delivered = pi.waitForMessageCount(2)
  pi.setIdle(true)
  timers.timers[0]?.callback()
  await delivered
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))

  assert.deepEqual(
    pi.messages.map(({ idle, options }) => ({ idle, options })),
    [
      { idle: false, options: { deliverAs: "steer", triggerTurn: true } },
      { idle: true, options: { deliverAs: "steer", triggerTurn: true } },
    ],
  )
  assert.match(pi.messages[1]?.message.content ?? "", /— MERGED/)
  assert.equal(timers.timers[0]?.cancelled, true)
})

test("OMP discovers one skill path and clears watches only after a successful switch", async () => {
  const pi = fakePiHarness()
  const timers = timerHarness()
  const runner = runnerHarness()
  registerOmpMonitor({
    pi: pi.pi,
    moduleUrl: pathToFileURL(resolve("pi/omp.ts")).href,
    dependencies: {
      runGh: runner.runGh,
      loadConfig: async () => monitorConfig({ announceOnStart: false }),
      schedule: timers.schedule,
      cancel: timers.cancel,
      log: () => {},
    },
  })

  assert.equal(pi.handlers.has("session_before_switch"), false)
  assert.equal(pi.handlers.get("session_switch")?.length, 1)
  assert.equal(pi.handlers.get("resources_discover")?.length, 1)
  const resources = await pi.handlers.get("resources_discover")?.[0]?.({}, extensionContext())
  assert.deepEqual(resources, { skillPaths: [resolve("skills")] })

  for (const reason of ["new", "resume", "fork"] as const) {
    await executeTool({ tool: pi.tool, action: MonitorAction.start, pr: "sesori/example#42" })
    const timer = timers.timers.at(-1)
    assert.equal(timer?.cancelled, false, "a cancelable before-event never clears the watch")
    await pi.handlers.get("session_switch")?.[0]?.({ type: "session_switch", reason }, extensionContext())
    assert.equal(timer?.cancelled, true)
    timer?.callback()
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
    assert.equal(pi.messages.length, 0, "a replaced session receives no report from its old timer")
  }

  await executeTool({ tool: pi.tool, action: MonitorAction.start, pr: "sesori/example#42" })
  assert.equal(timers.timers.length, 4)
  await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, extensionContext())
  await pi.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, extensionContext())
  assert.equal(timers.timers[3]?.cancelled, true)
})

test("Pi shutdown cleanup covers every replacement, reload, and quit reason", async () => {
  for (const reason of ["new", "resume", "fork", "reload", "quit"] as const) {
    const pi = fakePiHarness()
    const timers = timerHarness()
    const runner = runnerHarness()
    registerPiMonitor({
      pi: pi.pi,
      dependencies: {
        runGh: runner.runGh,
        loadConfig: async () => monitorConfig({ announceOnStart: false }),
        schedule: timers.schedule,
        cancel: timers.cancel,
        log: () => {},
      },
    })
    await executeTool({ tool: pi.tool, action: MonitorAction.start, pr: "sesori/example#42" })
    const shutdown = pi.handlers.get("session_shutdown")?.[0]
    await shutdown?.({ type: "session_shutdown", reason }, extensionContext())
    await shutdown?.({ type: "session_shutdown", reason }, extensionContext())
    assert.equal(timers.timers[0]?.cancelled, true, `cleanup failed for ${reason}`)
  }
})

test("package manifests expose the push-host skill exactly once", async () => {
  const manifest = JSON.parse(await readFile("pi/package.json", "utf8")) as {
    pi: { extensions: string[]; skills: string[] }
    omp: { extensions: string[]; skills?: string[] }
  }
  assert.deepEqual(manifest.pi, { extensions: ["./dist/index.js"], skills: ["./skills"] })
  assert.deepEqual(manifest.omp, { extensions: ["./dist/omp.js"] })

  const pushSkill = await readFile("skills/monitor-pr/SKILL.md", "utf8")
  const claudeSkill = await readFile("claude-codex/skills/monitor-pr/SKILL.md", "utf8")
  for (const skill of [pushSkill, claudeSkill]) {
    assert.match(skill, /monitor owns polling/i)
    assert.match(skill, /never.*sleep/is)
    assert.match(skill, /mark_ready.*confirm/is)
    assert.match(skill, /must begin with.*prefix/is)
    assert.match(skill, /non-actionable/i)
    assert.match(skill, /do .*not.* reply/is)
  }
  assert.doesNotMatch(pushSkill, /await-activity\.mjs/)
  assert.match(claudeSkill, /await-activity\.mjs/)
})

test("Pi project configuration paths honor trust and CONFIG_DIR_NAME", () => {
  const cwd = resolve("fixture-repo")
  assert.deepEqual(
    piMonitorConfigPaths({ cwd, trusted: true, configDirectory: ".pi" }),
    [join(cwd, ".pr-monitor.json"), join(cwd, ".pi/pr-monitor.json"), join(cwd, ".opencode/pr-monitor.json")],
  )
  assert.deepEqual(piMonitorConfigPaths({ cwd, trusted: false, configDirectory: ".pi" }), [])
  assert.deepEqual(
    piMonitorConfigPaths({ cwd, trusted: true, configDirectory: ".omp" }),
    [join(cwd, ".pr-monitor.json"), join(cwd, ".omp/pr-monitor.json"), join(cwd, ".opencode/pr-monitor.json")],
  )
})
