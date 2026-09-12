import { rm } from "node:fs/promises"

const generated = [
  new URL("../opencode/dist", import.meta.url),
  new URL("../opencode/skills", import.meta.url),
  new URL("../pi/dist", import.meta.url),
  new URL("../pi/skills", import.meta.url),
  new URL("../deepseek/dist", import.meta.url),
  new URL("../deepseek/skills", import.meta.url),
]
await Promise.all(generated.map((path) => rm(path, { recursive: true, force: true })))
