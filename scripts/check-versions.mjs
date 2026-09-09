import { readFile } from "node:fs/promises"

const manifests = [
  ["OpenCode", new URL("../opencode/package.json", import.meta.url)],
  ["Claude Code", new URL("../claude-codex/.claude-plugin/plugin.json", import.meta.url)],
  ["Codex", new URL("../claude-codex/.codex-plugin/plugin.json", import.meta.url)],
  ["Pi/OMP", new URL("../pi/package.json", import.meta.url)],
]

const versions = await Promise.all(
  manifests.map(async ([name, url]) => {
    const manifest = JSON.parse(await readFile(url, "utf8"))
    if (typeof manifest.version !== "string") throw new Error(`${name} manifest has no version`)
    return [name, manifest.version]
  }),
)
const expected = versions[0][1]
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"))
versions.push(["OpenCode lock", lock.packages?.opencode?.version])
versions.push(["Pi/OMP lock", lock.packages?.pi?.version])
const serverSource = await readFile(new URL("../claude-codex/src/mcp-server.ts", import.meta.url), "utf8")
const serverVersion = /new McpServer\(\{ name: "pr-monitor", version: "([^"]+)" \}\)/.exec(serverSource)?.[1]
versions.push(["Claude MCP", serverVersion])

const hermesManifest = await readFile(new URL("../hermes/plugin.yaml", import.meta.url), "utf8")
versions.push(["Hermes", /^version: (.+)$/m.exec(hermesManifest)?.[1]])

const drift = versions.filter(([, version]) => version !== expected)
if (drift.length > 0) {
  throw new Error(`release version drift: ${versions.map(([name, version]) => `${name}=${version}`).join(", ")}`)
}
console.log(`version check passed: ${versions.map(([name]) => name).join(", ")} = ${expected}`)
