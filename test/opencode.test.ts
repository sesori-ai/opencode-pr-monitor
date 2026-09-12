import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { PrMonitorPlugin } from "../opencode/index"

let originalXdgConfigHome: string | undefined
let originalAutoMerge: string | undefined

test.beforeEach(() => {
  originalXdgConfigHome = process.env["XDG_CONFIG_HOME"]
  originalAutoMerge = process.env["SESORI_PR_MONITOR_AUTO_MERGE"]
  process.env["XDG_CONFIG_HOME"] = join(tmpdir(), `pr-monitor-opencode-test-${process.pid}`)
  process.env["SESORI_PR_MONITOR_AUTO_MERGE"] = "false"
})

test.afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"]
  else process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome
  if (originalAutoMerge === undefined) delete process.env["SESORI_PR_MONITOR_AUTO_MERGE"]
  else process.env["SESORI_PR_MONITOR_AUTO_MERGE"] = originalAutoMerge
})

test("OpenCode shutdown persists notices synchronously without starting a model turn", async () => {
  const promptAsyncBodies: unknown[] = []
  const promptBodies: unknown[] = []
  const client = {
    app: {
      log: async () => ({ data: true, error: undefined }),
    },
    session: {
      promptAsync: async (input: { body: unknown }) => {
        promptAsyncBodies.push(input.body)
        return { data: undefined, error: undefined }
      },
      prompt: async (input: { body: unknown }) => {
        promptBodies.push(input.body)
        return { data: undefined, error: undefined }
      },
    },
  }
  const initialPayload = {
    data: {
      repository: {
        pullRequest: {
          title: "test PR",
          url: "https://github.com/sesori/example/pull/42",
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: "head-1",
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { nodes: [] },
          reviewThreads: { nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          labels: { nodes: [] },
        },
      },
    },
  }
  const shell = () => {
    const result = {
      quiet: () => result,
      nothrow: async () => ({
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(initialPayload)),
        stderr: Buffer.from(""),
      }),
    }
    return result
  }
  const hooks = await PrMonitorPlugin({
    client,
    directory: process.cwd(),
    worktree: process.cwd(),
    project: { id: "project-1", worktree: process.cwd(), time: { created: Date.now() } },
    serverUrl: new URL("http://localhost:4096"),
    experimental_workspace: { register: () => {} },
    $: shell,
  } as never)
  const monitor = hooks.tool!.pr_monitor
  assert.ok(monitor)

  const result = await monitor.execute(
    { action: "start", pr: "sesori/example#42" },
    {
      sessionID: "session-1",
      messageID: "message-1",
      agent: "build",
      directory: process.cwd(),
      worktree: process.cwd(),
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    },
  )
  assert.match(String(result), /Started monitoring/)
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
  assert.equal(promptAsyncBodies.length, 1, "initial status uses normal async delivery")

  await hooks.dispose!()

  assert.equal(promptBodies.length, 1)
  assert.equal(promptAsyncBodies.length, 1, "shutdown does not use the cancellable async endpoint")
  const body = promptBodies[0] as {
    agent: string
    model: unknown
    noReply: boolean
    parts: Array<{ type: string; text: string }>
  }
  assert.equal(body.agent, "build")
  assert.equal(body.model, undefined)
  assert.equal(body.noReply, true)
  assert.equal(body.parts[0]?.type, "text")
  assert.match(body.parts[0]?.text ?? "", /^\[PR Monitor\] \[sesori\/example#42\]/)
  assert.match(body.parts[0]?.text ?? "", /Monitor stopped: opencode is shutting down/)
})

test("OpenCode injects the packaged monitor skill path exactly once", async () => {
  const client = {
    app: { log: async () => ({ data: true, error: undefined }) },
    session: {
      promptAsync: async () => ({ data: undefined, error: undefined }),
      prompt: async () => ({ data: undefined, error: undefined }),
    },
  }
  const hooks = await PrMonitorPlugin({
    client,
    directory: process.cwd(),
    worktree: process.cwd(),
    project: { id: "project-1", worktree: process.cwd(), time: { created: Date.now() } },
    serverUrl: new URL("http://localhost:4096"),
    experimental_workspace: { register: () => {} },
    $: () => {
      throw new Error("gh should not run while injecting the skill path")
    },
  } as never)
  const config: { skills?: { paths?: string[] } } = { skills: { paths: ["existing-skills"] } }

  await hooks.config!(config as never)
  await hooks.config!(config as never)

  assert.deepEqual(config.skills?.paths, ["existing-skills", fileURLToPath(new URL("../skills", import.meta.url))])
  await hooks.dispose!()
})
