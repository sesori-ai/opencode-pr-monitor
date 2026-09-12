// `make bump VERSION=X.Y.Z`: write one version into every place check-versions.mjs
// reads, and cut the CHANGELOG "Unreleased" section under that version. The
// lockfile is refreshed by the Makefile afterwards (npm install --package-lock-only).

import { readFile, writeFile } from "node:fs/promises"

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/bump-version.mjs X.Y.Z")
  process.exit(1)
}

const root = new URL("../", import.meta.url)
const manifests = [
  "opencode/package.json",
  "pi/package.json",
  "deepseek/package.json",
  "claude-codex/.claude-plugin/plugin.json",
  "claude-codex/.codex-plugin/plugin.json",
]
for (const path of manifests) {
  const url = new URL(path, root)
  const text = await readFile(url, "utf8")
  // Textual replace keeps each file's formatting untouched. Idempotent: an
  // already-matching version is fine (re-running bump only cuts the CHANGELOG).
  const field = /^(\s*"version":\s*)"[^"]+"/m
  if (!field.test(text)) throw new Error(`${path}: no version field found`)
  await writeFile(url, text.replace(field, `$1"${version}"`))
}

const hermesUrl = new URL("hermes/plugin.yaml", root)
const hermes = await readFile(hermesUrl, "utf8")
if (!/^version: .+$/m.test(hermes)) throw new Error("Hermes manifest version not found")
await writeFile(hermesUrl, hermes.replace(/^version: .+$/m, `version: ${version}`))

const serverUrl = new URL("claude-codex/src/mcp-server.ts", root)
const server = await readFile(serverUrl, "utf8")
const serverField = /new McpServer\(\{ name: "pr-monitor", version: "[^"]+" \}\)/
if (!serverField.test(server)) throw new Error("mcp-server.ts: McpServer version not found")
await writeFile(serverUrl, server.replace(serverField, `new McpServer({ name: "pr-monitor", version: "${version}" })`))

const changelogUrl = new URL("CHANGELOG.md", root)
const changelog = await readFile(changelogUrl, "utf8")
if (changelog.includes(`## [${version}]`)) {
  console.log(`CHANGELOG.md already has a [${version}] section; left as is`)
} else if (!/^## \[Unreleased\]\r?\n/m.test(changelog)) {
  throw new Error("CHANGELOG.md has no '## [Unreleased]' heading to cut from")
} else {
  await writeFile(changelogUrl, changelog.replace(/^## \[Unreleased\]\r?\n/m, `## [Unreleased]\n\n## [${version}]\n`))
}
console.log(`version ${version} written to ${manifests.length} JSON manifests, hermes/plugin.yaml, mcp-server.ts, and CHANGELOG.md`)
