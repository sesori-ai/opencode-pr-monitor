// Monitor tuning, loaded from `.opencode/pr-monitor.json` in the project
// directory (then worktree), falling back to defaults.

import { readFile } from "node:fs/promises"
import { join } from "node:path"

export type MonitorConfig = {
  debounceMinutes: number
  maxCiWaitMinutes: number
  pollIntervalSeconds: number
  ignoreCommentTag: string | undefined
  announceOnStart: boolean
}

const CONFIG_FILE = "pr-monitor.json"

const DEFAULT_CONFIG: MonitorConfig = {
  debounceMinutes: 5,
  maxCiWaitMinutes: 30,
  pollIntervalSeconds: 60,
  ignoreCommentTag: undefined,
  announceOnStart: true,
}

const MIN_POLL_INTERVAL_SECONDS = 30

function resolveConfig(raw: unknown): MonitorConfig {
  const cfg = { ...DEFAULT_CONFIG }
  if (typeof raw !== "object" || raw === null) return cfg
  const record = raw as Record<string, unknown>
  const num = (key: string): number | undefined => {
    const value = record[key]
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
  }
  cfg.debounceMinutes = num("debounceMinutes") ?? cfg.debounceMinutes
  cfg.maxCiWaitMinutes = num("maxCiWaitMinutes") ?? cfg.maxCiWaitMinutes
  const poll = num("pollIntervalSeconds") ?? cfg.pollIntervalSeconds
  cfg.pollIntervalSeconds = Math.max(poll, MIN_POLL_INTERVAL_SECONDS)
  const tag = record["ignoreCommentTag"]
  cfg.ignoreCommentTag = typeof tag === "string" && tag.length > 0 ? tag : undefined
  const announce = record["announceOnStart"]
  if (typeof announce === "boolean") cfg.announceOnStart = announce
  return cfg
}

export async function loadConfig(dirs: string[], log: (message: string) => void): Promise<MonitorConfig> {
  for (const dir of dirs) {
    const path = join(dir, ".opencode", CONFIG_FILE)
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      continue // missing/unreadable file in this dir -> try next, else defaults
    }
    try {
      return resolveConfig(JSON.parse(text))
    } catch (error) {
      log(`config file ${path} is not valid JSON, ignoring it: ${(error as Error).message}`)
    }
  }
  return resolveConfig(undefined)
}
