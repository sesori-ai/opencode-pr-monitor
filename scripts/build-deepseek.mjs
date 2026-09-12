import { rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { copyPushSkill } from "./copy-push-skill.mjs"

await rm(new URL("../deepseek/dist", import.meta.url), { recursive: true, force: true })
await build({
  entryPoints: [fileURLToPath(new URL("../deepseek/index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../deepseek/dist/index.js", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "esnext",
  external: ["@deepseek-ai/*"],
  logLevel: "warning",
})
const declaration =
  'import type { Context } from "@deepseek-ai/cordis"\n\n' +
  'export declare const name = "pr-monitor"\n' +
  'export declare const inject: readonly ["agents", "skills", "tools"]\n' +
  "export declare function apply(ctx: Context): void\n"
await writeFile(new URL("../deepseek/dist/index.d.ts", import.meta.url), declaration)
await copyPushSkill({ target: new URL("../deepseek/skills/monitor-pr/", import.meta.url) })
