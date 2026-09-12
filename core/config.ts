// Monitor tuning, layered from one user-global file and the first readable
// project `pr-monitor.json` among host-supplied candidates. Common watch/action
// settings remain separate from Claude Code's passive-delivery settings.

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export type WatchConfig = {
  debounceMinutes: number
  maxCiWaitMinutes: number
  pollIntervalSeconds: number
  // A local-account GitHub comment is an agent acknowledgement only when it starts with this prefix.
  ignoreCommentTag: string | undefined
  announceOnStart: boolean
  // Deliver immediately when a check goes red, skipping debounce and CI hold.
  flushOnCiFailure: boolean
}

export type MonitorConfig = WatchConfig & {
  // Label the mark_ready action applies to a PR on GitHub.
  readyLabel: string
  // Irreversible auto-merge opt-in from trusted config or an explicit environment override.
  autoMerge: boolean
}

export const AUTO_MERGE_ENV = "SESORI_PR_MONITOR_AUTO_MERGE"

export type ClaudeMonitorConfig = MonitorConfig & {
  // Claude Code delivery is passive, so this optionally announces a spooled report out of band.
  desktopNotifications: boolean
  // Keep the session alive until a watched PR is handed off to a human.
  keepAlive: boolean
  // Rolling idle cap for keep-alive, refreshed whenever a report is delivered.
  keepAliveMaxMinutes: number
}

const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  debounceMinutes: 2,
  maxCiWaitMinutes: 30,
  pollIntervalSeconds: 60,
  ignoreCommentTag: "<!-- pr-monitor:reply -->",
  announceOnStart: true,
  flushOnCiFailure: true,
  readyLabel: "ready-for-human-review",
  autoMerge: false,
}

const DEFAULT_CLAUDE_CONFIG = {
  desktopNotifications: false,
  keepAlive: true,
  keepAliveMaxMinutes: 120,
}

const MIN_POLL_INTERVAL_SECONDS = 30
// Node coerces setInterval delays past 2^31-1 ms to 1 ms. A day is already
// longer than a useful active-PR interval and remains comfortably below it.
const MAX_POLL_INTERVAL_SECONDS = 86_400

type MonitorEnvironment = Readonly<Record<string, string | undefined>>

type LoadConfigInput<TConfig> = {
  paths: readonly string[]
  globalPaths?: readonly string[]
  log: (message: string) => void
  environment?: MonitorEnvironment
  resolve: (
    layers: readonly unknown[],
    environment: MonitorEnvironment,
    log: (message: string) => void,
  ) => TConfig
}

type LoadedConfig = {
  found: boolean
  raw?: unknown
}

export function globalMonitorConfigPath({
  environment = process.env,
  homeDirectory,
}: {
  environment?: MonitorEnvironment
  homeDirectory?: string
} = {}): string {
  const xdgConfigHome = environment["XDG_CONFIG_HOME"]?.trim()
  const environmentHome = environment["HOME"]?.trim() || environment["USERPROFILE"]?.trim()
  const home = homeDirectory ?? environmentHome ?? homedir()
  const configHome = xdgConfigHome !== undefined && isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : join(home, ".config")
  return join(configHome, "pr-monitor", "config.json")
}

function positiveNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function environmentAutoMergeOverride(
  environment: MonitorEnvironment,
  log: (message: string) => void,
): boolean | undefined {
  const raw = environment[AUTO_MERGE_ENV]
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === "true" || value === "1") return true
  if (value === "false" || value === "0" || value === "") return false
  log(`${AUTO_MERGE_ENV} must be true, false, 1, or 0; auto-merge is disabled.`)
  return false
}

function applyMonitorConfig(config: MonitorConfig, raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return
  const record = raw as Record<string, unknown>

  config.debounceMinutes = positiveNumber(record, "debounceMinutes") ?? config.debounceMinutes
  config.maxCiWaitMinutes = positiveNumber(record, "maxCiWaitMinutes") ?? config.maxCiWaitMinutes
  const poll = positiveNumber(record, "pollIntervalSeconds") ?? config.pollIntervalSeconds
  config.pollIntervalSeconds = Math.min(Math.max(poll, MIN_POLL_INTERVAL_SECONDS), MAX_POLL_INTERVAL_SECONDS)

  const tag = record["ignoreCommentTag"]
  config.ignoreCommentTag = typeof tag === "string" && tag.length > 0 ? tag : config.ignoreCommentTag
  const announce = record["announceOnStart"]
  if (typeof announce === "boolean") config.announceOnStart = announce
  const flushOnCiFailure = record["flushOnCiFailure"]
  if (typeof flushOnCiFailure === "boolean") config.flushOnCiFailure = flushOnCiFailure
  const label = record["readyLabel"]
  if (typeof label === "string" && label.length > 0) config.readyLabel = label
  const autoMerge = record["autoMerge"]
  if (typeof autoMerge === "boolean") config.autoMerge = autoMerge
}

function resolveMonitorConfig(
  layers: readonly unknown[],
  environment: MonitorEnvironment,
  log: (message: string) => void,
): MonitorConfig {
  const config = { ...DEFAULT_MONITOR_CONFIG }
  for (const raw of layers) applyMonitorConfig(config, raw)
  config.autoMerge = environmentAutoMergeOverride(environment, log) ?? config.autoMerge
  return config
}

function applyClaudeConfig(config: ClaudeMonitorConfig, raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return
  const record = raw as Record<string, unknown>

  const notify = record["desktopNotifications"]
  if (typeof notify === "boolean") config.desktopNotifications = notify
  const keepAlive = record["keepAlive"]
  if (typeof keepAlive === "boolean") config.keepAlive = keepAlive
  config.keepAliveMaxMinutes = positiveNumber(record, "keepAliveMaxMinutes") ?? config.keepAliveMaxMinutes
}

function resolveClaudeConfig(
  layers: readonly unknown[],
  environment: MonitorEnvironment,
  log: (message: string) => void,
): ClaudeMonitorConfig {
  const config: ClaudeMonitorConfig = { ...resolveMonitorConfig(layers, environment, log), ...DEFAULT_CLAUDE_CONFIG }
  for (const raw of layers) applyClaudeConfig(config, raw)
  return config
}

async function readFirstConfig({
  paths,
  log,
}: {
  paths: readonly string[]
  log: (message: string) => void
}): Promise<LoadedConfig> {
  for (const path of paths) {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      continue
    }
    try {
      return { found: true, raw: JSON.parse(text) }
    } catch (error) {
      log(`config file ${path} is not valid JSON, ignoring it: ${(error as Error).message}`)
    }
  }
  return { found: false }
}

async function loadResolvedConfig<TConfig>({
  paths,
  globalPaths,
  log,
  environment = process.env,
  resolve,
}: LoadConfigInput<TConfig>): Promise<TConfig> {
  const global = await readFirstConfig({
    paths: globalPaths ?? [globalMonitorConfigPath({ environment })],
    log,
  })
  const project = await readFirstConfig({ paths, log })
  const layers: unknown[] = []
  if (global.found) layers.push(global.raw)
  if (project.found) layers.push(project.raw)
  return resolve(layers, environment, log)
}

export function loadMonitorConfig(input: Omit<LoadConfigInput<MonitorConfig>, "resolve">): Promise<MonitorConfig> {
  return loadResolvedConfig({ ...input, resolve: resolveMonitorConfig })
}

export function loadClaudeConfig(
  input: Omit<LoadConfigInput<ClaudeMonitorConfig>, "resolve">,
): Promise<ClaudeMonitorConfig> {
  return loadResolvedConfig({ ...input, resolve: resolveClaudeConfig })
}
