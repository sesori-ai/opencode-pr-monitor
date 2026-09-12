import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  AUTO_MERGE_ENV,
  loadClaudeConfig,
  loadMonitorConfig,
  type MonitorConfig,
} from "../core/config"
import type { GhRunner, PrSnapshot } from "../core/github"
import { targetKey } from "../core/target"
import {
  InitialAnnouncementMode,
  MonitorSession,
  StopNoticeChannel,
  type ReportChannel,
} from "../runtime/monitor-session"
import { buildMonitorToolDescription, MonitorAction } from "../runtime/tool"

function config(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    debounceMinutes: 2,
    maxCiWaitMinutes: 30,
    pollIntervalSeconds: 60,
    ignoreCommentTag: undefined,
    announceOnStart: false,
    flushOnCiFailure: true,
    readyLabel: "ready-for-human-review",
    autoMerge: false,
    ...overrides,
  }
}

function payload({
  number = 42,
  state = "OPEN",
  mergeable = "MERGEABLE",
  labels = [],
}: {
  number?: number
  state?: PrSnapshot["state"]
  mergeable?: PrSnapshot["mergeable"]
  labels?: string[]
} = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          title: `test PR ${number}`,
          url: `https://github.com/sesori/example/pull/${number}`,
          state,
          mergeable,
          headRefOid: `head-${number}`,
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { nodes: [] },
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          labels: { nodes: labels.map((name) => ({ name })) },
        },
      },
    },
  })
}

type RunnerState = {
  calls: string[][]
  userCalls: number
  failLabelAdd: boolean
  labelAdded: boolean
}

function runnerHarness(
  options: { mergeable?: PrSnapshot["mergeable"] } = {},
): { runGh: GhRunner; state: RunnerState } {
  const state: RunnerState = { calls: [], userCalls: 0, failLabelAdd: false, labelAdded: false }
  const runGh: GhRunner = async (args) => {
    state.calls.push(args)
    if (args[0] === "api" && args[1] === "user") {
      state.userCalls += 1
      return "sesori-bot\n"
    }
    if (args[0] === "api" && args[1] === "graphql") {
      const rawNumber = args.find((arg) => arg.startsWith("number="))?.slice("number=".length)
      return payload({ number: Number(rawNumber ?? 42), mergeable: options.mergeable })
    }
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route.includes("/pulls/")) return JSON.stringify({ state: "open", merged: false })
    if (/\/labels$/.test(route) && !route.includes("/issues/")) throw new Error("label already exists")
    if (route.includes("/issues/") && args.includes("DELETE")) {
      state.labelAdded = false
      return ""
    }
    if (route.includes("/issues/")) {
      if (state.failLabelAdd) throw new Error("label add failed")
      state.labelAdded = true
      return ""
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }
  return { runGh, state }
}

type FakeTimer = { callback: () => void; cancelled: boolean }

function timerHarness(): {
  timers: FakeTimer[]
  schedule: (input: { callback: () => void; intervalMs: number }) => FakeTimer
  cancel: (input: { timer: unknown }) => void
} {
  const timers: FakeTimer[] = []
  return {
    timers,
    schedule: ({ callback }) => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return timer
    },
    cancel: ({ timer }) => {
      const fakeTimer = timer as FakeTimer
      fakeTimer.cancelled = true
    },
  }
}

function channelHarness(): { channel: ReportChannel; delivered: string[]; persisted: string[] } {
  const delivered: string[] = []
  const persisted: string[] = []
  return {
    delivered,
    persisted,
    channel: {
      deliver: async ({ report }) => {
        delivered.push(report)
      },
      persist: async ({ report }) => {
        persisted.push(report)
      },
    },
  }
}

function startOptions({ channel }: { channel: ReportChannel }) {
  return {
    announcementMode: InitialAnnouncementMode.awaitDelivery,
    createChannel: () => channel,
  }
}

test("common and Claude config resolve separate settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-monitor-config-"))
  const path = join(directory, "pr-monitor.json")
  await writeFile(
    path,
    JSON.stringify({
      debounceMinutes: 5,
      readyLabel: "ready",
      desktopNotifications: true,
      keepAlive: false,
      keepAliveMaxMinutes: 9,
      autoMerge: true,
    }),
  )
  try {
    const common = await loadMonitorConfig({ paths: [path], environment: {}, log: () => {} })
    const claude = await loadClaudeConfig({ paths: [path], environment: {}, log: () => {} })
    assert.equal(common.debounceMinutes, 5)
    assert.equal(common.readyLabel, "ready")
    assert.equal(common.autoMerge, false)
    assert.equal("desktopNotifications" in common, false)
    assert.equal(claude.desktopNotifications, true)
    assert.equal(claude.keepAlive, false)
    assert.equal(claude.keepAliveMaxMinutes, 9)
    assert.equal(claude.autoMerge, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("auto-merge is enabled only by an explicit host environment flag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-monitor-auto-merge-config-"))
  const path = join(directory, "pr-monitor.json")
  await writeFile(path, JSON.stringify({ autoMerge: true }))
  const logs: string[] = []
  try {
    const repositoryOnly = await loadMonitorConfig({ paths: [path], environment: {}, log: () => {} })
    const enabled = await loadMonitorConfig({
      paths: [path],
      environment: { [AUTO_MERGE_ENV]: "TrUe" },
      log: () => {},
    })
    const invalid = await loadMonitorConfig({
      paths: [],
      environment: { [AUTO_MERGE_ENV]: "yes" },
      log: (message) => logs.push(message),
    })

    assert.equal(repositoryOnly.autoMerge, false)
    assert.equal(enabled.autoMerge, true)
    assert.equal(invalid.autoMerge, false)
    assert.match(logs[0]!, new RegExp(AUTO_MERGE_ENV))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("concurrent starts deduplicate after fetch and share authenticated identity", async () => {
  const runner = runnerHarness()
  const timers = timerHarness()
  const channel = channelHarness()
  const session = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: async () => config({ ignoreCommentTag: "[Sesori reply]" }),
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  const [first, second] = await Promise.all([
    session.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) }),
    session.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) }),
  ])

  assert.equal([first, second].filter((result) => result.start !== undefined).length, 1)
  assert.equal([first.text, second.text].filter((text) => text.startsWith("Already monitoring")).length, 1)
  assert.equal(runner.state.userCalls, 1)
  assert.equal(timers.timers.length, 1)
  assert.equal(session.list().length, 1)
  await session.stopAll({})
})

test("sessions isolate targets and stale timers cannot remove a successor watch", async () => {
  const runner = runnerHarness()
  const firstTimers = timerHarness()
  const secondTimers = timerHarness()
  const channel = channelHarness()
  const first = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: async () => config(),
    log: () => {},
    schedule: firstTimers.schedule,
    cancel: firstTimers.cancel,
  })
  const second = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: async () => config(),
    log: () => {},
    schedule: secondTimers.schedule,
    cancel: secondTimers.cancel,
  })

  await first.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) })
  await second.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) })
  const caseVariant = await first.execute({
    action: MonitorAction.start,
    pr: "SESORI/Example#42",
    start: startOptions(channel),
  })
  assert.match(caseVariant.text, /Already monitoring/)
  assert.equal(firstTimers.timers.length, 1)
  const staleTimer = firstTimers.timers[0]!
  await first.execute({ action: MonitorAction.stop, pr: "SESORI/Example#42" })
  await first.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) })

  staleTimer.callback()
  await Promise.resolve()
  assert.equal(first.list().length, 1)
  assert.equal(second.list().length, 1)
  assert.equal(staleTimer.cancelled, true)
  await Promise.all([first.stopAll({}), second.stopAll({})])
})

test("lifecycle cleanup invalidates a start that is still loading", async () => {
  const runner = runnerHarness()
  const timers = timerHarness()
  const channel = channelHarness()
  let resolveConfig!: (value: MonitorConfig) => void
  const configPending = new Promise<MonitorConfig>((resolve) => {
    resolveConfig = resolve
  })
  const session = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: () => configPending,
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  const starting = session.execute({
    action: MonitorAction.start,
    pr: "sesori/example#42",
    start: startOptions(channel),
  })
  await Promise.resolve()
  await session.stopAll({})
  resolveConfig(config())

  const result = await starting
  assert.match(result.text, /session ended while .* was starting/)
  assert.equal(session.list().length, 0)
  assert.equal(timers.timers.length, 0)
})

test("session cleanup keeps a stopped watch registered until its label mutation drains", async () => {
  const runner = runnerHarness()
  const timers = timerHarness()
  const channel = channelHarness()
  let releaseMutation!: () => void
  let announceMutation!: () => void
  const mutationStarted = new Promise<void>((resolve) => {
    announceMutation = resolve
  })
  const mutationGate = new Promise<void>((resolve) => {
    releaseMutation = resolve
  })
  const runGh: GhRunner = async (args) => {
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route.includes("/issues/") && !args.includes("DELETE")) {
      announceMutation()
      await mutationGate
    }
    return await runner.runGh(args)
  }
  const session = new MonitorSession({
    runGh,
    loadConfig: async () => config(),
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
  })
  const backgroundStart = {
    announcementMode: InitialAnnouncementMode.background,
    createChannel: () => channel.channel,
  }

  await session.execute({
    action: MonitorAction.start,
    pr: "sesori/example#42",
    start: backgroundStart,
  })
  const marking = session.execute({ action: MonitorAction.markReady, pr: "sesori/example#42" })
  await mutationStarted
  const stopping = session.stopAll({})
  const raced = await session.execute({
    action: MonitorAction.start,
    pr: "sesori/example#42",
    start: backgroundStart,
  })

  assert.match(raced.text, /Already monitoring/)
  assert.equal(session.list().length, 1)
  releaseMutation()
  await marking
  await stopping
  assert.equal(session.list().length, 0)
})

test("persistent shutdown notices use the persistent channel and clear every timer", async () => {
  const runner = runnerHarness()
  const timers = timerHarness()
  const channels = new Map<number, ReturnType<typeof channelHarness>>()
  const session = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: async () => config(),
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  for (const number of [42, 43]) {
    const harness = channelHarness()
    channels.set(number, harness)
    await session.execute({
      action: MonitorAction.start,
      pr: `sesori/example#${number}`,
      start: startOptions(harness),
    })
  }
  await session.stopAll({ notice: "Monitor stopped for test.", channel: StopNoticeChannel.persistent })

  assert.equal(session.list().length, 0)
  assert.equal(timers.timers.every((timer) => timer.cancelled), true)
  for (const harness of channels.values()) {
    assert.equal(harness.delivered.length, 0)
    assert.equal(harness.persisted.length, 1)
    assert.match(harness.persisted[0]!, /Monitor stopped for test/)
    assert.match(harness.persisted[0]!, /Ready for human review: YES|Ready for human review: NO/)
  }
})

test("ready handoff follows label success and the watched target identity", async () => {
  const runner = runnerHarness({ mergeable: "UNKNOWN" })
  const timers = timerHarness()
  const channel = channelHarness()
  const handedOff = new Set<string>()
  const readyEvents: boolean[] = []
  const readyTargets: string[] = []
  const session = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: async () => config(),
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
    onReadyChanged: ({ target, ready, watched }) => {
      assert.equal(runner.state.labelAdded, ready)
      readyEvents.push(ready)
      readyTargets.push(targetKey(target))
      if (ready && watched) handedOff.add(targetKey(target))
      if (!ready) handedOff.delete(targetKey(target))
    },
    statusSuffix: ({ target }) =>
      handedOff.has(targetKey(target)) ? ", handed off for human review" : "",
  })
  await session.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) })

  runner.state.failLabelAdd = true
  const failed = await session.execute({ action: MonitorAction.markReady, pr: "sesori/example#42" })
  assert.match(failed.text, /Cannot mark/)
  assert.deepEqual(readyEvents, [false])
  assert.equal(handedOff.size, 0)

  runner.state.failLabelAdd = false
  const ready = await session.execute({ action: MonitorAction.markReady, pr: "SESORI/Example#42" })
  assert.match(ready.text, /label "ready-for-human-review" added/)
  assert.deepEqual(readyEvents, [false, true])
  assert.deepEqual(readyTargets, ["sesori/example#42", "sesori/example#42"])
  const status = await session.execute({ action: MonitorAction.status, pr: undefined })
  assert.match(status.text, /handed off for human review/)

  const unready = await session.execute({ action: MonitorAction.unmarkReady, pr: "SESORI/Example#42" })
  assert.match(unready.text, /no longer flagged for human review/)
  assert.deepEqual(readyEvents, [false, true, false])
  assert.deepEqual(readyTargets, ["sesori/example#42", "sesori/example#42", "sesori/example#42"])
  assert.equal(handedOff.size, 0)
  await session.stopAll({})
})

test("auto-merge startup clears a pre-existing ready label before requiring a fresh mark", async () => {
  const calls: string[][] = []
  const timers = timerHarness()
  const channel = channelHarness()
  const runGh: GhRunner = async (args) => {
    calls.push(args)
    if (args[0] === "api" && args[1] === "graphql") {
      return payload({ labels: ["ready-for-human-review"] })
    }
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route === "repos/sesori/example/pulls/42") {
      return JSON.stringify({ state: "open", merged: false, title: "test PR 42", head: { sha: "head-42" } })
    }
    if (route.endsWith("/pulls/42/merge")) return JSON.stringify({ merged: true })
    if (args.includes("DELETE")) return ""
    if (route === "repos/sesori/example/labels") throw new Error("label already exists")
    if (route.includes("/issues/42/labels")) return ""
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }
  const session = new MonitorSession({
    runGh,
    loadConfig: async () => config({ autoMerge: true, announceOnStart: true }),
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  const started = await session.execute({
    action: MonitorAction.start,
    pr: "sesori/example#42",
    start: startOptions(channel),
  })

  assert.match(started.text, /pre-existing ready label .* was removed/)
  assert.match(started.text, /call mark_ready/)
  assert.match(channel.delivered[0]!, /Startup safety reset: pre-existing ready label/)
  assert.match(channel.delivered[0]!, /Auto-merge: ENABLED/)
  assert.equal(calls.some((args) => args.some((arg) => arg.endsWith("/merge"))), false)
  assert.equal(calls.some((args) => args.includes("DELETE")), true)
  assert.match((await session.execute({ action: MonitorAction.status, pr: undefined })).text, /auto-merge: squash/)

  const marked = await session.execute({ action: MonitorAction.markReady, pr: "sesori/example#42" })
  assert.match(marked.text, /Auto-merge succeeded/)
  const mergeCall = calls.find((args) => args.some((arg) => arg.endsWith("/merge")))
  assert.equal(mergeCall?.includes("merge_method=squash"), true)
  assert.equal(mergeCall?.includes("sha=head-42"), true)
  assert.equal(mergeCall?.includes("commit_title=test PR 42"), true)
  assert.equal(mergeCall?.includes("commit_message="), true)
  assert.equal(calls.some((args) => args.includes("labels[]=automatically-merged")), true)
  await session.stopAll({})
})

test("auto-merge startup fails closed when a pre-existing ready label cannot be removed", async () => {
  const timers = timerHarness()
  const channel = channelHarness()
  const runGh: GhRunner = async (args) => {
    if (args[0] === "api" && args[1] === "graphql") {
      return payload({ labels: ["ready-for-human-review"] })
    }
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route === "repos/sesori/example/pulls/42") {
      return JSON.stringify({ state: "open", merged: false })
    }
    if (args.includes("DELETE")) throw new Error("label removal denied")
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }
  const session = new MonitorSession({
    runGh,
    loadConfig: async () => config({ autoMerge: true }),
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  const result = await session.execute({
    action: MonitorAction.start,
    pr: "sesori/example#42",
    start: startOptions(channel),
  })

  assert.match(result.text, /auto-merge is enabled but the pre-existing ready label/)
  assert.match(result.text, /label removal denied/)
  assert.equal(session.list().length, 0)
  assert.equal(timers.timers.length, 0)
})

test("standalone mark_ready auto-merges the captured head", async () => {
  const calls: string[][] = []
  const runGh: GhRunner = async (args) => {
    calls.push(args)
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route === "repos/sesori/example/pulls/42") {
      return JSON.stringify({
        state: "open",
        merged: false,
        title: "Standalone title",
        head: { sha: "standalone-head" },
      })
    }
    if (route.endsWith("/pulls/42/merge")) return JSON.stringify({ merged: true })
    if (route === "repos/sesori/example/labels") throw new Error("label already exists")
    if (route.includes("/issues/42/labels")) return ""
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }
  const session = new MonitorSession({ runGh, loadConfig: async () => config({ autoMerge: true }), log: () => {} })

  const marked = await session.execute({ action: MonitorAction.markReady, pr: "sesori/example#42" })

  assert.match(marked.text, /label "ready-for-human-review" added/)
  assert.match(marked.text, /Auto-merge succeeded/)
  const mergeCall = calls.find((args) => args.some((arg) => arg.endsWith("/merge")))
  assert.equal(mergeCall?.includes("sha=standalone-head"), true)
  assert.equal(mergeCall?.includes("commit_title=Standalone title"), true)
  assert.equal(mergeCall?.includes("commit_message="), true)
})

test("standalone merge rejection keeps the ready result and does not add the marker", async () => {
  const calls: string[][] = []
  const runGh: GhRunner = async (args) => {
    calls.push(args)
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route === "repos/sesori/example/pulls/42") {
      return JSON.stringify({
        state: "open",
        merged: false,
        title: "Standalone title",
        head: { sha: "standalone-head" },
      })
    }
    if (route.endsWith("/pulls/42/merge")) {
      return JSON.stringify({ merged: false, message: "Required review is missing" })
    }
    if (route === "repos/sesori/example/labels") throw new Error("label already exists")
    if (route.includes("/issues/42/labels")) return ""
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }
  const session = new MonitorSession({ runGh, loadConfig: async () => config({ autoMerge: true }), log: () => {} })

  const marked = await session.execute({ action: MonitorAction.markReady, pr: "sesori/example#42" })

  assert.match(marked.text, /label "ready-for-human-review" added/)
  assert.match(marked.text, /Required review is missing/)
  assert.match(marked.text, /ready label remains and no automatic retry will occur/)
  assert.equal(marked.ready?.ready, true)
  assert.equal(calls.some((args) => args.includes("labels[]=automatically-merged")), false)
})

test("tool wording makes autonomous delivery and the no-delay rule explicit", () => {
  const description = buildMonitorToolDescription({
    delivery: "reports arrive here.",
    configPath: ".pr-monitor.json",
    lifecycle: "Session scoped.",
    waiting: "End the turn while idle.",
  })
  assert.match(description, /notifications arrive automatically/)
  assert.match(description, /NEVER create sleeps/)
  assert.match(description, /routine status\/flush/)
  assert.match(description, /when flushOnCiFailure is enabled/)
  assert.match(description, /configured ready label/)
  assert.match(description, /automatically adds readiness/)
  assert.match(description, /unconditionally accept current state/)
  assert.match(description, /SESORI_PR_MONITOR_AUTO_MERGE=true/)
  assert.match(description, /squash-merge attempt for the accepted head using only the PR title/)
})
