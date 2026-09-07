import { mkdir, copyFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
const root = new URL("../hermes/", import.meta.url)
await mkdir(new URL("dist/", root), { recursive: true })
const output = fileURLToPath(new URL("dist/worker.mjs", root))
await build({ entryPoints: [fileURLToPath(new URL("src/worker.ts", root))], outfile: output,
  bundle: true, platform: "node", format: "esm", target: "node18", logLevel: "warning" })
await writeFile(new URL("dist/tool.json", root), execFileSync(process.execPath, [output, "--describe"]))
await mkdir(new URL("skills/monitor-pr/", root), { recursive: true })
await copyFile(new URL("../skills/monitor-pr/SKILL.md", import.meta.url), new URL("skills/monitor-pr/SKILL.md", root))
