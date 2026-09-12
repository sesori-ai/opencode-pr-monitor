import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"

const deepSeekVersion = process.env["DEEPSEEK_VERSION"] ?? "0.1.5-rc.2"
const pnpmVersion = process.env["PNPM_VERSION"] ?? "10.18.3"
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pr-monitor-deepseek-host-"))
const hostDirectory = join(temporaryDirectory, "host")
const dshHome = join(temporaryDirectory, "home")
const tarballDirectory = join(temporaryDirectory, "tarball")

function redactOutput(output) {
  return output.replace(/([?&]token=)[^\s]+/g, "$1<redacted>").slice(-20_000)
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit))
  child.kill("SIGTERM")
  let timeout
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), 10_000)
    }),
  ])
  clearTimeout(timeout)
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await exited
  }
}

async function runAgentProbe({ cli, environment, runDsh, tarball }) {
  runDsh(["plugin", "--profile", "headless", "add", tarball])
  const fakeBin = join(environment.DSH_HOME, "fake-bin")
  const probeWorkspace = join(environment.DSH_HOME, "agent-project")
  await mkdir(fakeBin)
  await mkdir(join(probeWorkspace, ".dsh"), { recursive: true })
  await writeFile(join(probeWorkspace, ".env"), "SESORI_PR_MONITOR_AUTO_MERGE=true\n")
  await writeFile(
    join(probeWorkspace, ".pr-monitor.json"),
    `${JSON.stringify({ autoMerge: true, ignoreCommentTag: "[unsafe project reply]" })}\n`,
  )
  await writeFile(
    join(probeWorkspace, ".dsh", "pr-monitor.json"),
    `${JSON.stringify({ autoMerge: true, ignoreCommentTag: "[unsafe dsh reply]" })}\n`,
  )
  const ghSource = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("sesori-bot\\n")
} else if (args[0] === "api" && args[1] === "graphql") {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: {
    title: "DeepSeek probe",
    url: "https://github.com/sesori/example/pull/42",
    state: "OPEN",
    mergeable: "MERGEABLE",
    headRefOid: "head-1",
    commits: { nodes: [] },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    labels: { nodes: [] }
  } } } }))
} else {
  process.stderr.write("unexpected gh call: " + args.join(" ") + "\\n")
  process.exitCode = 1
}
`
  await writeFile(join(fakeBin, "gh"), ghSource)
  await chmod(join(fakeBin, "gh"), 0o755)
  const requests = []
  let fixtureFailure
  const fixture = createServer((request, response) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        requests.push({ path: request.url, body })
        const messages = JSON.stringify(body.messages)
        const hasMonitorTool = body.tools?.some((tool) => tool.function?.name === "pr_monitor") === true
        const toolCall = hasMonitorTool && !messages.includes("Started monitoring sesori/example#42")
          ? {
              id: "call_pr_monitor_start",
              arguments: '{"action":"start","pr":"sesori/example#42"}',
            }
          : hasMonitorTool && !messages.includes("call_pr_monitor_status")
            ? { id: "call_pr_monitor_status", arguments: '{"action":"status"}' }
            : hasMonitorTool && !messages.includes("Stopped 1 monitor")
              ? { id: "call_pr_monitor_stop", arguments: '{"action":"stop","pr":"all"}' }
              : undefined
        const finalContent = hasMonitorTool ? "DEEPSEEK_PR_MONITOR_OK" : "PR Monitor probe"
        const events = toolCall === undefined
          ? [
              JSON.stringify({
                choices: [{ delta: { role: "assistant", content: null, reasoning_content: "" } }],
              }),
              JSON.stringify({ choices: [{ delta: { content: finalContent } }] }),
              JSON.stringify({
                choices: [{ delta: { content: "" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 3 },
              }),
              "[DONE]",
            ]
          : [
              JSON.stringify({
                choices: [{ delta: { role: "assistant", content: null, reasoning_content: "" } }],
              }),
              JSON.stringify({
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: toolCall.id,
                      type: "function",
                      function: { name: "pr_monitor", arguments: toolCall.arguments },
                    }],
                  },
                }],
              }),
              JSON.stringify({
                choices: [{ delta: { content: "" }, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
              }),
              "[DONE]",
            ]
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(events.map((event) => `data: ${event}\n\n`).join(""))
      } catch (error) {
        fixtureFailure = error
        response.writeHead(500, { "content-type": "text/plain" })
        response.end(String(error))
      }
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    fixture.once("error", rejectListen)
    fixture.listen(0, "127.0.0.1", resolveListen)
  })
  const address = fixture.address()
  assert.ok(address !== null && typeof address !== "string")
  const probeEnvironment = {
    ...environment,
    PATH: `${fakeBin}${delimiter}${environment.PATH}`,
    DEEPSEEK_API_KEY: "pr-monitor-loopback-test",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
  }
  const child = spawn(
    process.execPath,
    [cli, "--profile", "headless", "Start pr_monitor for sesori/example#42, handle its report, then stop it."],
    { cwd: probeWorkspace, env: probeEnvironment, stdio: ["ignore", "pipe", "pipe"] },
  )
  let output = ""
  try {
    const result = await new Promise((resolveExit, rejectExit) => {
      const timeout = setTimeout(
        () => rejectExit(new Error(`DeepSeek Agent probe timed out:\n${redactOutput(output)}`)),
        90_000,
      )
      child.stdout.on("data", (chunk) => {
        output += chunk.toString()
      })
      child.stderr.on("data", (chunk) => {
        output += chunk.toString()
      })
      child.once("error", (error) => {
        clearTimeout(timeout)
        rejectExit(error)
      })
      child.once("exit", (code, signal) => {
        clearTimeout(timeout)
        resolveExit({ code, signal })
      })
    })
    assert.equal(
      result.code,
      0,
      `DeepSeek Agent probe exited with ${result.code ?? result.signal}:\n${redactOutput(output)}`,
    )
  } finally {
    await terminate(child)
    await new Promise((resolveClose) => fixture.close(resolveClose))
  }
  if (fixtureFailure !== undefined) throw fixtureFailure
  assert.ok(requests.length >= 4 && requests.length <= 8)
  assert.ok(requests.every((request) => request.path === "/chat/completions"))
  const toolRequestIndex = requests.findIndex((request) =>
    request.body?.tools?.some((tool) => tool.function?.name === "pr_monitor"),
  )
  assert.notEqual(toolRequestIndex, -1, "real root Agent did not expose pr_monitor")
  const laterMessages = requests.slice(toolRequestIndex + 1).map((request) => request.body?.messages)
  assert.ok(
    laterMessages.some((messages) => JSON.stringify(messages).includes("Started monitoring sesori/example#42")),
    "real Agent did not execute pr_monitor(start)",
  )
  assert.ok(
    laterMessages.some((messages) =>
      JSON.stringify(messages).includes("[PR Monitor] [sesori/example#42]"),
    ),
    "agent.steer did not deliver the initial report",
  )
  const serializedLaterMessages = JSON.stringify(laterMessages)
  assert.match(serializedLaterMessages, /call_pr_monitor_status/)
  assert.match(serializedLaterMessages, /baseline \d+m ago/)
  assert.doesNotMatch(serializedLaterMessages, /Auto-merge: ENABLED|auto-merge: squash/)
  assert.doesNotMatch(serializedLaterMessages, /\[unsafe (?:project|dsh) reply\]/)
  assert.ok(
    laterMessages.some((messages) => JSON.stringify(messages).includes("Stopped 1 monitor")),
    "real Agent did not execute pr_monitor(stop)",
  )
  assert.match(output, /DEEPSEEK_PR_MONITOR_OK/)
  assert.ok(
    JSON.stringify(requests[toolRequestIndex]?.body?.messages).includes("monitor-pr"),
    "real Agent did not advertise the canonical monitor-pr skill",
  )
}

function runNpm({ args, cwd, stdio = "inherit" }) {
  const npmCli = process.env["npm_execpath"]
  if (npmCli !== undefined) {
    return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8", stdio })
  }
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd,
    encoding: "utf8",
    stdio,
    shell: process.platform === "win32",
  })
}

try {
  await Promise.all([mkdir(hostDirectory), mkdir(tarballDirectory)])
  await writeFile(join(hostDirectory, "package.json"), `${JSON.stringify({ private: true })}\n`)
  runNpm({
    args: [
      "install",
      "--save-exact",
      "--no-audit",
      "--no-fund",
      `@deepseek-ai/dsh@${deepSeekVersion}`,
      `pnpm@${pnpmVersion}`,
    ],
    cwd: hostDirectory,
  })
  runNpm({
    args: [
      "pack",
      "--workspace",
      "@sesori/pr-monitor-deepseek",
      "--pack-destination",
      tarballDirectory,
      "--json",
    ],
    cwd: process.cwd(),
    stdio: "pipe",
  })
  const tarballs = (await readdir(tarballDirectory)).filter((entry) => entry.endsWith(".tgz"))
  assert.equal(tarballs.length, 1)
  const tarball = join(tarballDirectory, tarballs[0])
  const cli = join(hostDirectory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
  const environment = {
    DSH_HOME: dshHome,
    HOME: dshHome,
    USERPROFILE: dshHome,
    PATH: `${join(hostDirectory, "node_modules", ".bin")}${delimiter}${process.env["PATH"] ?? ""}`,
    CI: "1",
    NO_COLOR: "1",
    ...(process.env["SystemRoot"] === undefined ? {} : { SystemRoot: process.env["SystemRoot"] }),
    ...(process.env["ComSpec"] === undefined ? {} : { ComSpec: process.env["ComSpec"] }),
    ...(process.env["PATHEXT"] === undefined ? {} : { PATHEXT: process.env["PATHEXT"] }),
    ...(process.env["TMP"] === undefined ? {} : { TMP: process.env["TMP"] }),
    ...(process.env["TEMP"] === undefined ? {} : { TEMP: process.env["TEMP"] }),
    ...(process.env["TMPDIR"] === undefined ? {} : { TMPDIR: process.env["TMPDIR"] }),
    ...(process.env["LANG"] === undefined ? {} : { LANG: process.env["LANG"] }),
    ...(process.env["SHELL"] === undefined ? {} : { SHELL: process.env["SHELL"] }),
  }
  const runDsh = (args) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
      maxBuffer: 100 * 1024 * 1024,
    })

  runDsh(["plugin", "--profile", "web", "add", tarball])
  const config = runDsh(["--profile", "web", "--dump-config"])
  assert.equal((config.match(/name: '@sesori\/pr-monitor-deepseek'/g) ?? []).length, 1)

  const profileDirectory = join(dshHome, "profiles", "web")
  const profile = JSON.parse(await readFile(join(profileDirectory, "package.json"), "utf8"))
  assert.ok(profile.dependencies?.["@sesori/pr-monitor-deepseek"])
  assert.equal(
    profile.dsh?.profile?.bundles?.filter((bundle) => bundle === "@sesori/pr-monitor-deepseek").length,
    1,
  )

  const installedDirectory = join(
    profileDirectory,
    "node_modules",
    "@sesori",
    "pr-monitor-deepseek",
  )
  const installedManifest = JSON.parse(await readFile(join(installedDirectory, "package.json"), "utf8"))
  assert.equal(installedManifest.dsh?.bundle?.patch, "./cordis.patch.yml")
  assert.deepEqual(installedManifest.peerDependencies, {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-agent": "*",
    "@deepseek-ai/dsh-launch-environment": "*",
    "@deepseek-ai/dsh-llm": "*",
    "@deepseek-ai/dsh-skill": "*",
    "@deepseek-ai/dsh-tools": "*",
  })
  const installedSkill = await readFile(join(installedDirectory, "skills", "monitor-pr", "SKILL.md"), "utf8")
  const canonicalSkill = await readFile(resolve("skills/monitor-pr/SKILL.md"), "utf8")
  assert.equal(installedSkill, canonicalSkill)

  const version = runDsh(["--version"]).trim()
  const agentProbeRan = process.platform !== "win32"
  if (agentProbeRan) await runAgentProbe({ cli, environment, runDsh, tarball })
  const server = spawn(
    process.execPath,
    [cli, "--profile", "web", "--host", "127.0.0.1", "--port", "0", "--no-open"],
    { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] },
  )
  let bootOutput = ""
  try {
    await new Promise((resolveBoot, rejectBoot) => {
      const timeout = setTimeout(
        () => rejectBoot(new Error(`DeepSeek Harness did not finish Web boot:\n${redactOutput(bootOutput)}`)),
        90_000,
      )
      const inspect = (chunk) => {
        bootOutput += chunk.toString()
        if (!/https?:\/\/127\.0\.0\.1:\d+\//.test(bootOutput)) return
        clearTimeout(timeout)
        resolveBoot()
      }
      server.stdout.on("data", inspect)
      server.stderr.on("data", inspect)
      server.once("error", (error) => {
        clearTimeout(timeout)
        rejectBoot(error)
      })
      server.once("exit", (code, signal) => {
        clearTimeout(timeout)
        rejectBoot(
          new Error(
            `DeepSeek Harness exited before Web boot (${code ?? signal}):\n${redactOutput(bootOutput)}`,
          ),
        )
      })
    })
  } finally {
    await terminate(server)
  }

  const agentEvidence = agentProbeRan
    ? "real Agent start/report/stop and canonical skill advertisement"
    : "Windows package/profile smoke (model-driven Agent probe runs on macOS/Linux)"
  console.log(
    `DeepSeek Harness profile check passed on ${process.platform}: ${version}; ` +
      `one profile layer, successful Web loader boot, bundle manifest and skill contents, ${agentEvidence}`,
  )
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
