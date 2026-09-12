import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const hook = resolve("claude-codex/hooks/drain-spool.mjs")
const waiter = resolve("claude-codex/hooks/await-activity.mjs")
const server = resolve("claude-codex/src/mcp-server.ts")

// Exercise the actual MCP adapter and dependency-free hooks. GitHub is the
// only fake boundary; each tool call carries Codex's real _meta.threadId shape.
test("Codex routes reports, config, actions and keep-alive by conversation", {
  skip: process.platform === "win32" ? "The plugin's executable gh fixture requires POSIX" : false,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-monitor-codex-session-"))
  const root = join(home, ".claude", "pr-monitor", "spool")
  const hostSpool = join(root, String(process.pid))
  const projectA = join(home, "worktree-a")
  const projectB = join(home, "worktree-b")
  const bin = join(home, "bin")
  const env = Object.fromEntries(Object.entries({ ...process.env,
    HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH}`,
    SESORI_PR_MONITOR_AUTO_MERGE: "false",
    // Codex must not use a Claude socket inherited from an outer host.
    CLAUDE_CODE_MESSAGING_SOCKET: join(home, "not-codex.sock"),
  }).filter((entry): entry is [string, string] => entry[1] !== undefined))
  let transport: StdioClientTransport | undefined
  const client = new Client({ name: "codex-test", version: "1" })
  const runHook = (input: Record<string, unknown>) => {
    const result = spawnSync(process.execPath, [hook, "--codex"], {
      env, input: JSON.stringify(input), encoding: "utf8", timeout: 10_000,
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  const call = (action: string, threadId: string | undefined, pr?: string) => client.callTool({
    name: "pr_monitor", arguments: { action, pr },
    ...(threadId === undefined ? {} : { _meta: { threadId } }),
  })
  const text = (result: Awaited<ReturnType<typeof call>>) => JSON.stringify(result.content)
  const state = async (thread: string) => JSON.parse(await readFile(join(hostSpool, thread, "session.json"), "utf8"))
  try {
    await Promise.all([mkdir(bin), mkdir(projectA), mkdir(join(projectB, ".codex"), { recursive: true })])
    await writeFile(join(projectA, ".pr-monitor.json"), JSON.stringify({
      pollIntervalSeconds: 37, desktopNotifications: false, readyLabel: "ready-a",
    }))
    await writeFile(join(projectB, ".codex", "pr-monitor.json"), JSON.stringify({
      pollIntervalSeconds: 43, desktopNotifications: false, readyLabel: "ready-b",
    }))
    const gh = join(bin, "gh")
    await writeFile(gh, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(home, "gh-calls.jsonl"))}, JSON.stringify(args) + '\\n');
if (args[1] === 'user') console.log('owner');
else if (args[1] === 'graphql') {
  const number = Number(args.find(a => a.startsWith('number=')).slice(7));
  console.log(JSON.stringify({ data: { repository: { pullRequest: {
    title: 'PR ' + number, url: 'https://github.com/sesori/example/pull/' + number,
    state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'head-' + number,
    commits: { nodes: [] }, reviewRequests: { nodes: [] }, latestReviews: { nodes: [] },
    reviewThreads: { nodes: [] }, labels: { nodes: [] }, comments: { totalCount: 1, nodes: [{
      id: 'quota', author: { login: 'review-bot', __typename: 'Bot' },
      createdAt: '2026-09-05T12:00:00Z', body: 'Review quota exhausted'
    }] }
  } } } }));
} else if (args.some(a => a.includes('/pulls/'))) console.log(JSON.stringify({ state: 'open', merged: false }));
else console.log('{}');
`)
    await chmod(gh, 0o755)
    transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", server, "--codex"], env, stderr: "pipe",
    })
    let errors = ""
    transport.stderr?.on("data", (chunk) => { errors += chunk.toString() })
    await client.connect(transport)
    const missingId = await call("start", undefined, "sesori/example#42")
    assert.equal(missingId.isError, true)
    assert.match(text(missingId), /valid MCP threadId/)
    const missingHooks = await call("start", "thread-a", "sesori/example#42")
    assert.equal(missingHooks.isError, true)
    assert.match(text(missingHooks), /No monitor was started/)
    assert.deepEqual(await readdir(hostSpool), ["owner"])
    const traversal = await call("status", "../thread-a")
    assert.equal(traversal.isError, true)

    // A resumed thread's old registration cannot authorize a new host.
    const contexts = join(root, "codex-contexts")
    await mkdir(contexts, { recursive: true })
    await writeFile(join(contexts, "thread-a.json"), JSON.stringify({
      cwd: projectA, owners: [{ pid: process.pid, token: "previous-host-lifetime" }],
    }))
    const staleHook = await call("start", "thread-a", "sesori/example#42")
    assert.equal(staleHook.isError, true)
    assert.match(text(staleHook), /current host/)
    assert.deepEqual(await readdir(hostSpool), ["owner"])

    // Hooks register exact conversation cwd before any report exists.
    assert.equal(runHook({ hook_event_name: "SessionStart", session_id: "thread-a", cwd: projectA }), "")
    assert.equal(runHook({ hook_event_name: "UserPromptSubmit", session_id: "thread-b", cwd: projectB }), "")
    const startedA = await call("start", "thread-a", "sesori/example#42")
    assert.equal(startedA.isError, undefined, errors)
    assert.match(text(startedA), /Polling every 37s/)
    const startedB = await call("start", "thread-b", "sesori/example#43")
    assert.match(text(startedB), /Polling every 43s/)
    assert.match(text(await call("status", "thread-a")), /example#42/)
    assert.doesNotMatch(text(await call("status", "thread-a")), /example#43/)
    assert.match(text(await call("status", "thread-b")), /example#43/)
    assert.equal((await state("thread-a")).keepAlive, true)
    assert.equal((await state("thread-b")).keepAlive, true)

    // A third conversation, old PID-only reports, and subagents cannot consume
    // either owning thread's reports, even under the same app-server PID.
    await writeFile(join(hostSpool, "legacy.md"), "old PID-only report")
    assert.equal(runHook({ hook_event_name: "PostToolUse", session_id: "thread-c", cwd: projectA }), "")
    assert.equal(runHook({ hook_event_name: "PostToolUse", session_id: "thread-a", agent_id: "child", cwd: projectA }), "")
    const reportA = JSON.parse(runHook({ hook_event_name: "PostToolUse", session_id: "thread-a", cwd: projectA }))
    assert.match(reportA.hookSpecificOutput.additionalContext, /example#42/)
    assert.doesNotMatch(reportA.hookSpecificOutput.additionalContext, /example#43|PID-only/)
    assert.equal(runHook({ hook_event_name: "PostToolUse", session_id: "thread-a", cwd: projectA }), "")
    assert.equal(await readFile(join(hostSpool, "legacy.md"), "utf8"), "old PID-only report")
    const keepAlive = JSON.parse(runHook({ hook_event_name: "Stop", session_id: "thread-a", cwd: projectA }))
    assert.equal(keepAlive.decision, "block")
    assert.match(keepAlive.reason, /--thread 'thread-a'/)
    assert.doesNotMatch(keepAlive.reason, /example#43/)

    // B still has a pending report. The waiter for A must not wake on it.
    const waited = spawnSync(process.execPath, [waiter, "--session", String(process.pid), "--thread", "thread-a", "--timeout", "0.01"], {
      env, encoding: "utf8", timeout: 10_000,
    })
    assert.equal(waited.status, 0, waited.stderr)
    assert.match(waited.stdout, /no PR activity/)
    assert.doesNotMatch(waited.stdout, /report is waiting/)
    const reportB = JSON.parse(runHook({ hook_event_name: "Stop", session_id: "thread-b", cwd: projectB }))
    assert.match(reportB.reason, /example#43/)
    assert.match(reportB.reason, /mark_ready/)
    assert.doesNotMatch(reportB.reason, /example#42/)

    // No-op feedback requires explicit judgment, then handoff only that thread.
    const ready = await call("mark_ready", "thread-a", "sesori/example#42")
    assert.equal(ready.isError, undefined)
    assert.match(text(ready), /ready-a/)
    assert.equal((await state("thread-a")).keepAlive, false)
    assert.equal((await state("thread-b")).keepAlive, true)
    assert.equal(runHook({ hook_event_name: "Stop", session_id: "thread-a", cwd: projectA }), "")
    await call("stop", "thread-a", "all")
    assert.match(text(await call("status", "thread-b")), /example#43/)
    await call("stop", "thread-b", "all")
  } finally {
    await client.close()
    await transport?.close()
    await rm(home, { recursive: true, force: true })
  }
})


test("the waiter handles malformed thread arguments once and completes without writing proof", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-monitor-invalid-waiter-"))
  try {
    const result = spawnSync(process.execPath, [waiter, "--session", String(process.pid), "--thread", "../other"], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 10_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Invalid --thread identifier/)
    assert.match(result.stdout, /pr-monitor-waiter: done/)
    assert.deepEqual(await readdir(home), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("both shipped hook manifests tolerate a missing Node executable", {
  skip: process.platform === "win32" ? "Plugin hook commands require a POSIX shell" : false,
}, async () => {
  for (const manifest of ["hooks.json", "codex-hooks.json"]) {
    const config = JSON.parse(await readFile(resolve("claude-codex/hooks", manifest), "utf8"))
    for (const entries of Object.values(config.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      for (const entry of entries) for (const hook of entry.hooks) {
        const result = spawnSync("/bin/sh", ["-c", hook.command], {
          env: { PATH: "/nonexistent", CLAUDE_PLUGIN_ROOT: resolve("claude-codex") },
          encoding: "utf8", timeout: 10_000,
        })
        assert.equal(result.status, 0, `${manifest}: ${result.stderr}`)
        if (manifest === "codex-hooks.json") assert.match(hook.command, / --codex \|\| true$/)
      }
    }
  }
})
