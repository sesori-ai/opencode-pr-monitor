import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import {
  createLaunchEnvironmentSnapshot,
  type LaunchEnvironmentSnapshot,
} from "@deepseek-ai/dsh-launch-environment"
import type { UserMessage } from "@deepseek-ai/dsh-llm"
import { BUNDLED_SKILL_RANK, type SkillProvider } from "@deepseek-ai/dsh-skill"
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools"
import { AUTO_MERGE_ENV, type MonitorConfig } from "../core/config"
import type { GhRunner, PrSnapshot } from "../core/github"
import { registerDeepSeekMonitor } from "../deepseek/extension"
import { MonitorAction } from "../runtime/tool"

type FakeTimer = { callback: () => void; cancelled: boolean }

type FakeAgent = {
  agent: Agent
  messages: Array<{ message: UserMessage; status: "idle" | "running" }>
  tool: () => ToolDefinition | undefined
  setStatus: (status: "idle" | "running") => void
  dispose: () => Promise<void>
}

type EffectCleanup = () => Promise<void>

type AgentCreatedHandler = (event: { agent: Agent }) => void

function effectHarness() {
  const cleanups: EffectCleanup[] = []
  return {
    effect(register: () => void | (() => void | Promise<void>)): EffectCleanup {
      const cleanup = register()
      let active = true
      const wrapped = async (): Promise<void> => {
        if (!active) return
        active = false
        if (cleanup !== undefined) await cleanup()
      }
      cleanups.push(wrapped)
      return wrapped
    },
    async dispose(): Promise<void> {
      for (const cleanup of [...cleanups].reverse()) await cleanup()
    },
  }
}

function fakeDeepSeekHarness({
  launchEnvironment,
}: {
  launchEnvironment?: LaunchEnvironmentSnapshot
} = {}) {
  const rootEffects = effectHarness()
  const roots: Agent[] = []
  const agentsById = new Map<string, Agent>()
  const createdHandlers = new Set<AgentCreatedHandler>()
  let skillProvider: SkillProvider | undefined

  const rootContext = {
    get: (name: string) => name === "launchEnvironment" ? launchEnvironment : undefined,
    agents: {
      get: (id: string) => agentsById.get(id),
      roots: () => [...roots],
    },
    skills: {
      registerProvider: (create: (control: { signal: AbortSignal; invalidate: () => void }) => SkillProvider) => {
        const lifecycle = new AbortController()
        const provider = create({ signal: lifecycle.signal, invalidate: () => {} })
        skillProvider = provider
        return () => {
          lifecycle.abort()
          if (skillProvider === provider) skillProvider = undefined
        }
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect: rootEffects.effect,
    on: (event: string, handler: AgentCreatedHandler) => {
      assert.equal(event, "agent/created")
      createdHandlers.add(handler)
      return () => createdHandlers.delete(handler)
    },
  } as unknown as Context

  const createAgent = ({ id, root = true }: { id: string; root?: boolean }): FakeAgent => {
    const effects = effectHarness()
    const messages: Array<{ message: UserMessage; status: "idle" | "running" }> = []
    let status: "idle" | "running" = "idle"
    let registeredTool: ToolDefinition | undefined
    let agent: Agent
    const agentContext = {
      tools: {
        register: (tool: ToolDefinition) => {
          assert.equal(registeredTool, undefined)
          registeredTool = tool
          return () => {
            if (registeredTool === tool) registeredTool = undefined
          }
        },
      },
      effect: effects.effect,
    } as unknown as Context
    agent = {
      id,
      ctx: agentContext,
      get status() {
        return status
      },
      session: { id },
      steer: (message: UserMessage) => messages.push({ message, status }),
    } as unknown as Agent

    agentsById.set(id, agent)
    if (root) roots.push(agent)
    for (const handler of createdHandlers) handler({ agent })

    return {
      agent,
      messages,
      tool: () => registeredTool,
      setStatus: (next) => {
        status = next
      },
      dispose: async () => {
        await effects.dispose()
        const index = roots.indexOf(agent)
        if (index >= 0) roots.splice(index, 1)
        if (agentsById.get(id) === agent) agentsById.delete(id)
      },
    }
  }

  return {
    ctx: rootContext,
    createAgent,
    get skillProvider(): SkillProvider {
      assert.ok(skillProvider)
      return skillProvider
    },
    dispose: () => rootEffects.dispose(),
  }
}

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
    if (args[0] === "api" && args[1] === "user") return "sesori-bot"
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
  return {
    runGh,
    get labelAdded() {
      return labelAdded
    },
    get snapshotRequests() {
      return snapshotIndex
    },
  }
}

function toolExecution({ agent }: { agent: Agent }): ToolRunContext {
  return {
    callId: "call-1",
    rootCallId: "call-1",
    name: "pr_monitor",
    arguments: {},
    agent,
    signal: new AbortController().signal,
    token: Symbol("tool-execution"),
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

async function executeTool({
  tool,
  agent,
  action,
  pr,
}: {
  tool: ToolDefinition
  agent: Agent
  action: MonitorAction
  pr?: string
}): Promise<string> {
  const args = { action, ...(pr === undefined ? {} : { pr }) }
  return String(await tool.execute(args, toolExecution({ agent })))
}

async function waitFor({ condition }: { condition: () => boolean }): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
  }
  assert.fail("condition was not reached")
}

test("DeepSeek registers one root-scoped monitor tool and bundled skill", async () => {
  const harness = fakeDeepSeekHarness()
  const timers = timerHarness()
  const runner = runnerHarness()
  const controller = registerDeepSeekMonitor({
    ctx: harness.ctx,
    dependencies: {
      runGh: runner.runGh,
      loadConfig: async () => monitorConfig(),
      schedule: timers.schedule,
      cancel: timers.cancel,
      log: () => {},
    },
  })
  const child = harness.createAgent({ id: "child", root: false })
  assert.equal(child.tool(), undefined)
  const root = harness.createAgent({ id: "root" })
  const tool = root.tool()
  assert.ok(tool)
  assert.equal(tool.name, "pr_monitor")
  assert.match(tool.description, /notifications arrive automatically/)
  assert.match(tool.description, /no DeepSeek Harness project file overrides it/)
  assert.match(tool.description, /invoking-project \.env values are ignored/)

  const skillCandidates = await harness.skillProvider.list({})
  assert.ok(Array.isArray(skillCandidates))
  const skill = skillCandidates[0]
  assert.ok(skill)
  assert.equal(skill.name, "monitor-pr")
  assert.equal(skill.rank, BUNDLED_SKILL_RANK)
  assert.equal(skill.source, "bundled")
  assert.match(skill.description, /monitor owns polling and readiness labels/)
  const loadedSkill = await harness.skillProvider.get(skill, {})
  assert.match(loadedSkill?.content ?? "", /^\s*# monitor-pr/)
  assert.match(loadedSkill?.content ?? "", /return the explicit PR target .* to the parent\/root agent/s)
  assert.doesNotMatch(loadedSkill?.content ?? "", /^---/)

  const start = await executeTool({ tool, agent: root.agent, action: MonitorAction.start, pr: "sesori/example#42" })
  assert.match(start, /Started monitoring/)
  assert.match(start, /initial \[PR Monitor\] status report is being delivered now/)
  assert.match(start, /Only user-global config and provenance-safe launch environment values are loaded/)
  assert.match(start, /Invoking-project \.env values are ignored/)
  await waitFor({ condition: () => root.messages.length === 1 })
  const initial = root.messages[0]?.message
  assert.equal(initial?.role, "user")
  assert.deepEqual(initial?.source, { kind: "plugin", plugin: "pr-monitor" })
  assert.match(initial?.content[0]?.type === "text" ? initial.content[0].text : "", /^\[PR Monitor\]/)

  assert.match(await executeTool({ tool, agent: root.agent, action: MonitorAction.status }), /sesori\/example#42/)
  assert.match(
    await executeTool({ tool, agent: root.agent, action: MonitorAction.flush, pr: "sesori/example#42" }),
    /^\[PR Monitor\]/,
  )
  assert.match(
    await executeTool({ tool, agent: root.agent, action: MonitorAction.markReady, pr: "sesori/example#42" }),
    /label "ready-for-human-review" added/,
  )
  assert.equal(runner.labelAdded, true)
  assert.match(
    await executeTool({ tool, agent: root.agent, action: MonitorAction.unmarkReady, pr: "sesori/example#42" }),
    /no longer flagged for human review/,
  )
  assert.equal(runner.labelAdded, false)
  assert.match(
    await executeTool({ tool, agent: root.agent, action: MonitorAction.stop, pr: "all" }),
    /Stopped 1 monitor/,
  )
  assert.equal(timers.timers[0]?.cancelled, true)

  await controller.dispose()
  await root.dispose()
  await child.dispose()
})

test("DeepSeek steers busy and idle reports into the exact owning conversation", async () => {
  const harness = fakeDeepSeekHarness()
  const timers = timerHarness()
  const runner = runnerHarness({ states: ["OPEN", "OPEN", "MERGED"] })
  const controller = registerDeepSeekMonitor({
    ctx: harness.ctx,
    dependencies: {
      runGh: runner.runGh,
      loadConfig: async () => monitorConfig(),
      schedule: timers.schedule,
      cancel: timers.cancel,
      log: () => {},
    },
  })
  const first = harness.createAgent({ id: "first" })
  const second = harness.createAgent({ id: "second" })
  const firstTool = first.tool()
  const secondTool = second.tool()
  assert.ok(firstTool)
  assert.ok(secondTool)

  first.setStatus("running")
  await executeTool({ tool: firstTool, agent: first.agent, action: MonitorAction.start, pr: "sesori/example#42" })
  await waitFor({ condition: () => first.messages.length === 1 })
  assert.equal(first.messages[0]?.status, "running")
  assert.equal(second.messages.length, 0)

  second.setStatus("idle")
  await executeTool({ tool: secondTool, agent: second.agent, action: MonitorAction.start, pr: "sesori/example#42" })
  await waitFor({ condition: () => second.messages.length === 1 })
  assert.equal(second.messages[0]?.status, "idle")

  first.setStatus("idle")
  timers.timers[0]?.callback()
  await waitFor({ condition: () => first.messages.length === 2 })
  assert.equal(first.messages[1]?.status, "idle")
  assert.match(
    first.messages[1]?.message.content[0]?.type === "text" ? first.messages[1].message.content[0].text : "",
    /— MERGED/,
  )
  assert.equal(second.messages.length, 1)

  await controller.dispose()
  assert.equal(timers.timers[1]?.cancelled, true)
  assert.equal(first.tool(), undefined)
  assert.equal(second.tool(), undefined)
  await first.dispose()
  await second.dispose()
})

test("DeepSeek agent disposal fences old timers and same-id replacements", async () => {
  const harness = fakeDeepSeekHarness()
  const timers = timerHarness()
  const runner = runnerHarness({ states: ["OPEN", "MERGED"] })
  const controller = registerDeepSeekMonitor({
    ctx: harness.ctx,
    dependencies: {
      runGh: runner.runGh,
      loadConfig: async () => monitorConfig({ announceOnStart: false }),
      schedule: timers.schedule,
      cancel: timers.cancel,
      log: () => {},
    },
  })
  const original = harness.createAgent({ id: "reused-id" })
  const originalTool = original.tool()
  assert.ok(originalTool)
  await executeTool({
    tool: originalTool,
    agent: original.agent,
    action: MonitorAction.start,
    pr: "sesori/example#42",
  })
  const oldTimer = timers.timers[0]
  assert.equal(oldTimer?.cancelled, false)

  const replacement = harness.createAgent({ id: "reused-id" })
  const replacementTool = replacement.tool()
  assert.ok(replacementTool)
  assert.equal(original.tool(), undefined)
  assert.match(
    await executeTool({ tool: originalTool, agent: original.agent, action: MonitorAction.status }),
    /owning DeepSeek Harness root conversation is no longer live/,
  )

  assert.equal(oldTimer?.cancelled, true)
  oldTimer?.callback()
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
  assert.equal(runner.snapshotRequests, 1)
  assert.equal(original.messages.length, 0)
  assert.equal(replacement.messages.length, 0)

  await original.dispose()
  assert.equal(oldTimer?.cancelled, true)
  assert.match(
    await executeTool({ tool: replacementTool, agent: replacement.agent, action: MonitorAction.status }),
    /No active monitors/,
  )

  await controller.dispose()
  await replacement.dispose()
})

test("DeepSeek package declares one installable bundle and provenance-safe global configuration", async () => {
  const manifest = JSON.parse(await readFile("deepseek/package.json", "utf8")) as {
    name: string
    dsh: { bundle: { patch: string } }
    peerDependencies: Record<string, string>
  }
  assert.equal(manifest.name, "@sesori/pr-monitor-deepseek")
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml")
  assert.deepEqual(manifest.peerDependencies, {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-agent": "*",
    "@deepseek-ai/dsh-launch-environment": "*",
    "@deepseek-ai/dsh-llm": "*",
    "@deepseek-ai/dsh-skill": "*",
    "@deepseek-ai/dsh-tools": "*",
  })
  assert.match(await readFile("deepseek/cordis.patch.yml", "utf8"), /name: '@sesori\/pr-monitor-deepseek'/)

  const root = await mkdtemp(join(tmpdir(), "pr-monitor-deepseek-global-"))
  const globalDirectory = join(root, "pr-monitor")
  const workspace = join(root, "workspace")
  const redirectedConfigHome = join(workspace, "redirected-config")
  const previousCwd = process.cwd()
  const previousXdgConfigHome = process.env["XDG_CONFIG_HOME"]
  const previousAutoMerge = process.env[AUTO_MERGE_ENV]
  await mkdir(join(workspace, ".dsh"), { recursive: true })
  await mkdir(join(redirectedConfigHome, "pr-monitor"), { recursive: true })
  await mkdir(globalDirectory, { recursive: true })
  await writeFile(join(workspace, ".pr-monitor.json"), JSON.stringify({ ignoreCommentTag: "[project reply]" }))
  await writeFile(join(workspace, ".dsh", "pr-monitor.json"), JSON.stringify({ ignoreCommentTag: "[dsh reply]" }))
  await writeFile(join(redirectedConfigHome, "pr-monitor", "config.json"), JSON.stringify({
    announceOnStart: false,
    ignoreCommentTag: "[redirected reply]",
    autoMerge: true,
  }))
  await writeFile(join(globalDirectory, "config.json"), JSON.stringify({
    announceOnStart: false,
    ignoreCommentTag: "[global reply]",
    autoMerge: true,
  }))
  process.chdir(workspace)
  process.env["XDG_CONFIG_HOME"] = redirectedConfigHome
  process.env[AUTO_MERGE_ENV] = "true"

  const launchEnvironment = createLaunchEnvironmentSnapshot([
    { source: "process", values: {} },
    {
      source: "project-env",
      path: join(workspace, ".env"),
      values: { XDG_CONFIG_HOME: redirectedConfigHome, [AUTO_MERGE_ENV]: "true" },
    },
    {
      source: "user-env",
      path: join(root, ".env"),
      values: { XDG_CONFIG_HOME: root, [AUTO_MERGE_ENV]: "" },
    },
  ])
  const harness = fakeDeepSeekHarness({ launchEnvironment })
  const timers = timerHarness()
  const runner = runnerHarness()
  const controller = registerDeepSeekMonitor({
    ctx: harness.ctx,
    dependencies: {
      runGh: runner.runGh,
      schedule: timers.schedule,
      cancel: timers.cancel,
      log: () => {},
    },
  })
  try {
    const agent = harness.createAgent({ id: "global-config" })
    const tool = agent.tool()
    assert.ok(tool)
    const result = await executeTool({
      tool,
      agent: agent.agent,
      action: MonitorAction.start,
      pr: "sesori/example#42",
    })
    assert.match(result, /\[global reply\]/)
    assert.doesNotMatch(result, /\[(?:project|dsh|redirected) reply\]/)
    assert.doesNotMatch(
      await executeTool({ tool, agent: agent.agent, action: MonitorAction.status }),
      /auto-merge: squash/,
    )
    await agent.dispose()
  } finally {
    await controller.dispose()
    process.chdir(previousCwd)
    if (previousXdgConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"]
    else process.env["XDG_CONFIG_HOME"] = previousXdgConfigHome
    if (previousAutoMerge === undefined) delete process.env[AUTO_MERGE_ENV]
    else process.env[AUTO_MERGE_ENV] = previousAutoMerge
    await rm(root, { recursive: true, force: true })
  }
})
