import { execFileSync } from "node:child_process"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { copyPushSkill } from "./copy-push-skill.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const source = fileURLToPath(new URL("../deepseek/index.ts", import.meta.url))
const output = fileURLToPath(new URL("../deepseek/dist/index.js", import.meta.url))
const declaration = fileURLToPath(new URL("../deepseek/dist/index.d.ts", import.meta.url))
const declarationDirectory = await mkdtemp(join(tmpdir(), "pr-monitor-deepseek-types-"))
try {
  await rm(new URL("../deepseek/dist", import.meta.url), { recursive: true, force: true })
  await build({
    entryPoints: [source],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "esnext",
    external: ["@deepseek-ai/*"],
    logLevel: "warning",
  })
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
      "--project",
      fileURLToPath(new URL("../deepseek/tsconfig.build.json", import.meta.url)),
      "--outDir",
      declarationDirectory,
    ],
    { cwd: root, stdio: "pipe" },
  )
  await copyFile(join(declarationDirectory, "deepseek", "index.d.ts"), declaration)
  await copyPushSkill({ target: new URL("../deepseek/skills/monitor-pr/", import.meta.url) })
} finally {
  await rm(declarationDirectory, { recursive: true, force: true })
}
