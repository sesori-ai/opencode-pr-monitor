// Session-scoped application runtime shared by host adapters. It owns watch
// deduplication, GitHub identity, timers, common actions, and readiness mutations;
// adapters own transport, lifecycle policy, and truthful host wording.

import type { MonitorConfig } from "../core/config"
import { fetchPrSnapshot, type GhRunner, type PrSnapshot } from "../core/github"
import { markReadyForHumanReview, removeReadyForHumanReview } from "../core/label"
import { autoMergeFailureText, getAutoMergePullRequest, squashMergePullRequest } from "../core/merge"
import { hasReadyLabel, withReadyLabel } from "../core/readiness"
import { parseTarget, targetKey, targetRegistryKey, type Target } from "../core/target"
import { PrWatch } from "../core/watch"
import { MonitorAction } from "./tool"

export enum InitialAnnouncementMode {
  background = "background",
  awaitDelivery = "await_delivery",
}

export enum StopNoticeChannel {
  normal = "normal",
  persistent = "persistent",
}

export enum InitialAnnouncementState {
  disabled = "disabled",
  pending = "pending",
  delivered = "delivered",
  retrying = "retrying",
}

export enum WatchChangeType {
  started = "started",
  stopped = "stopped",
}

export type ReportChannel = {
  deliver: (input: { report: string }) => Promise<void>
  persist?: (input: { report: string }) => Promise<void>
}

export type WatchView<TConfig extends MonitorConfig> = {
  target: Target
  config: TConfig
  statusLine: string
}

export type StartDetails<TConfig extends MonitorConfig> = {
  target: Target
  config: TConfig
  announcement: InitialAnnouncementState
}

export type ReadyDetails = {
  target: Target
  ready: boolean
  watched: boolean
}

export type MonitorActionResult<TConfig extends MonitorConfig> = {
  text: string
  start?: StartDetails<TConfig>
  ready?: ReadyDetails
}

type WatchEntry<TConfig extends MonitorConfig> = {
  watch: PrWatch
  timer: unknown
  config: TConfig
  channel: ReportChannel
}

type MonitorSessionDeps<TConfig extends MonitorConfig> = {
  runGh: GhRunner
  loadConfig?: () => Promise<TConfig>
  log: (message: string) => void
  now?: () => number
  schedule?: (input: { callback: () => void; intervalMs: number }) => unknown
  cancel?: (input: { timer: unknown }) => void
  onWatchChanged?: (event: { type: WatchChangeType; target: Target; config: TConfig }) => void
  onTickSettled?: (event: { target: Target; config: TConfig }) => void
  onReadyChanged?: (event: { target: Target; ready: boolean; watched: boolean; config: TConfig }) => void
  statusSuffix?: (input: { target: Target; config: TConfig }) => string
}

type StartOptions<TConfig extends MonitorConfig> = {
  prepare?: () => Promise<string | undefined>
  createChannel: (input: { target: Target; config: TConfig }) => ReportChannel
  announcementMode: InitialAnnouncementMode
}

export class MonitorSession<TConfig extends MonitorConfig> {
  private readonly deps: Required<Pick<MonitorSessionDeps<TConfig>, "now" | "schedule" | "cancel">> &
    Omit<MonitorSessionDeps<TConfig>, "now" | "schedule" | "cancel">
  private readonly watches = new Map<string, WatchEntry<TConfig>>()
  private lifecycleGeneration = 0
  private selfLogin: string | undefined
  private selfLoginPromise: Promise<string> | undefined

  constructor(deps: MonitorSessionDeps<TConfig>) {
    this.deps = {
      ...deps,
      now: deps.now ?? Date.now,
      schedule: deps.schedule ?? (({ callback, intervalMs }) => setInterval(callback, intervalMs)),
      cancel:
        deps.cancel ??
        (({ timer }) => {
          clearInterval(timer as ReturnType<typeof setInterval>)
        }),
    }
  }

  list(): WatchView<TConfig>[] {
    return [...this.watches.values()].map(({ watch, config }) => ({
      target: watch.target,
      config,
      statusLine: watch.statusLine(),
    }))
  }

  async execute({
    action,
    pr,
    start,
    loadConfig,
  }: {
    action: MonitorAction
    pr: string | undefined
    start?: StartOptions<TConfig>
    loadConfig?: () => Promise<TConfig>
  }): Promise<MonitorActionResult<TConfig>> {
    const actionLoadConfig =
      loadConfig ??
      this.deps.loadConfig ??
      (() => Promise.reject(new Error("this host did not provide a configuration loader")))
    switch (action) {
      case MonitorAction.start:
        if (!pr || pr === "all") {
          return { text: "action 'start' requires a single explicit pr: 'owner/repo#123' or a PR URL." }
        }
        if (start === undefined) return { text: "Cannot start monitor: this host did not provide a report channel." }
        return await this.start({ pr, options: start, loadConfig: actionLoadConfig })
      case MonitorAction.stop:
        if (!pr) return { text: "action 'stop' requires pr: 'owner/repo#123', a PR URL, or 'all'." }
        return await this.stop({ pr })
      case MonitorAction.flush:
        if (!pr) return { text: "action 'flush' requires pr: 'owner/repo#123', a PR URL, or 'all'." }
        return await this.flush({ pr })
      case MonitorAction.status:
        return { text: this.status() }
      case MonitorAction.markReady:
        if (!pr || pr === "all") {
          return { text: "action 'mark_ready' requires a single explicit pr: 'owner/repo#123' or a PR URL." }
        }
        return await this.changeReady({ pr, ready: true, loadConfig: actionLoadConfig })
      case MonitorAction.unmarkReady:
        if (!pr || pr === "all") {
          return { text: "action 'unmark_ready' requires a single explicit pr: 'owner/repo#123' or a PR URL." }
        }
        return await this.changeReady({ pr, ready: false, loadConfig: actionLoadConfig })
    }
  }

  async stopAll({
    notice,
    channel = StopNoticeChannel.normal,
  }: {
    notice?: string
    channel?: StopNoticeChannel
  }): Promise<void> {
    this.lifecycleGeneration += 1
    const entries = [...this.watches.values()]
    for (const entry of entries) entry.watch.stop()
    await Promise.all(entries.map((entry) => entry.watch.waitUntilStopped()))
    if (notice === undefined) return

    await Promise.all(
      entries.map(async (entry) => {
        const report = entry.watch.stopNotice(notice)
        const send =
          channel === StopNoticeChannel.persistent
            ? (entry.channel.persist ?? entry.channel.deliver)
            : entry.channel.deliver
        try {
          await send({ report })
        } catch (error) {
          this.deps.log(`stop notice delivery failed for ${targetKey(entry.watch.target)}: ${error}`)
        }
      }),
    )
  }

  private async start({
    pr,
    options,
    loadConfig,
  }: {
    pr: string
    options: StartOptions<TConfig>
    loadConfig: () => Promise<TConfig>
  }): Promise<MonitorActionResult<TConfig>> {
    const target = parseTarget(pr)
    if ("error" in target) return { text: target.error }
    const key = targetRegistryKey(target)
    const displayKey = targetKey(target)
    const existing = this.watches.get(key)
    if (existing) return { text: `Already monitoring ${displayKey} in this session.\n${existing.watch.statusLine()}` }
    const lifecycleGeneration = this.lifecycleGeneration

    const preparationError = await options.prepare?.()
    if (preparationError !== undefined) return { text: preparationError }

    let config: TConfig
    try {
      config = await loadConfig()
    } catch (error) {
      return {
        text: `Cannot start monitor for ${displayKey}: loading configuration failed (${(error as Error).message}).`,
      }
    }
    if (config.ignoreCommentTag !== undefined && this.selfLogin === undefined) {
      try {
        this.selfLoginPromise ??= this.deps.runGh(["api", "user", "--jq", ".login"]).then((login) => login.trim())
        this.selfLogin = await this.selfLoginPromise
      } catch (error) {
        this.selfLoginPromise = undefined
        return {
          text:
            "Cannot start monitor: resolving the authenticated gh user for the reply prefix failed " +
            `(${(error as Error).message}). Run \`gh auth status\` to check.`,
        }
      }
    }

    let initial: PrSnapshot
    try {
      initial = await this.fetchSnapshot({ target, config })
    } catch (error) {
      return { text: `Cannot start monitor for ${displayKey}: ${(error as Error).message}` }
    }
    if (this.lifecycleGeneration !== lifecycleGeneration) {
      return { text: `Monitor session ended while ${displayKey} was starting; no active monitor remains.` }
    }
    if (initial.state !== "OPEN") {
      return { text: `Cannot start monitor: ${displayKey} is already ${initial.state}.` }
    }

    const raced = this.watches.get(key)
    if (raced) return { text: `Already monitoring ${displayKey} in this session.\n${raced.watch.statusLine()}` }

    let startupNotice: string | undefined
    if (config.autoMerge && hasReadyLabel(initial, config.readyLabel)) {
      try {
        await removeReadyForHumanReview(this.deps.runGh, target, config.readyLabel)
      } catch (error) {
        return {
          text:
            `Cannot start monitor for ${displayKey}: auto-merge is enabled but the pre-existing ready label ` +
            `"${config.readyLabel}" could not be removed (${(error as Error).message}).`,
        }
      }
      initial = withReadyLabel(initial, config.readyLabel, false)
      startupNotice =
        `pre-existing ready label "${config.readyLabel}" was removed because auto-merge is enabled. ` +
        "Reassess the current head and call mark_ready if it is ready; that action will try to squash-merge it."
      if (this.lifecycleGeneration !== lifecycleGeneration) {
        return {
          text:
            `Monitor session ended while ${displayKey} was starting. ${startupNotice} ` +
            "No active monitor remains.",
        }
      }
      const resetRace = this.watches.get(key)
      if (resetRace) {
        return { text: `Already monitoring ${displayKey} in this session.\n${resetRace.watch.statusLine()}` }
      }
    }

    const reportChannel = options.createChannel({ target, config })
    let timer: unknown
    const watch = new PrWatch({
      target,
      config,
      initial,
      deps: {
        now: this.deps.now,
        fetchSnapshot: () => this.fetchSnapshot({ target, config }),
        deliver: (report) => reportChannel.deliver({ report }),
        persist:
          reportChannel.persist === undefined
            ? undefined
            : (report) => reportChannel.persist?.({ report }) ?? Promise.resolve(),
        log: this.deps.log,
        onStopped: () => {
          this.deps.cancel({ timer })
          const entry = this.watches.get(key)
          if (entry?.watch === watch) {
            this.watches.delete(key)
            this.notifyWatchChanged({ type: WatchChangeType.stopped, target, config })
          }
        },
        readiness: {
          label: config.readyLabel,
          replyPrefix: config.ignoreCommentTag ?? "<!-- pr-monitor:reply -->",
          change: (ready) =>
            ready
              ? markReadyForHumanReview(this.deps.runGh, target, config.readyLabel)
              : removeReadyForHumanReview(this.deps.runGh, target, config.readyLabel),
          onChanged: (ready) => this.notifyReadyChanged({ target, ready, watched: true, config }),
        },
        autoMerge: config.autoMerge
          ? {
              squashMerge: ({ pullRequest }) => squashMergePullRequest({
                runGh: this.deps.runGh,
                target,
                pullRequest,
              }),
            }
          : undefined,
        startupNotice,
      },
    })
    timer = this.deps.schedule({
      intervalMs: config.pollIntervalSeconds * 1000,
      callback: () => {
        void watch.tick().finally(() => this.notifyTickSettled({ target, config }))
      },
    })
    this.watches.set(key, { watch, timer, config, channel: reportChannel })
    this.notifyWatchChanged({ type: WatchChangeType.started, target, config })

    let announcement = InitialAnnouncementState.disabled
    if (options.announcementMode === InitialAnnouncementMode.awaitDelivery) {
      if (config.announceOnStart) {
        announcement = (await watch.announceInitial())
          ? InitialAnnouncementState.delivered
          : InitialAnnouncementState.retrying
      } else {
        await watch.initializeReadiness()
      }
      if (watch.isStopped) {
        return { text: `Monitor for ${displayKey} stopped before startup completed; no active monitor remains.` }
      }
    } else if (config.announceOnStart) {
      announcement = InitialAnnouncementState.pending
      void watch.announceInitial()
    } else {
      void watch.initializeReadiness()
    }

    this.deps.log(`started monitoring ${displayKey}`)
    const autoMergeNotice = config.autoMerge
      ? " Auto-merge enabled: automatic readiness and mark_ready make one squash-merge attempt for the " +
        "accepted head using only the PR title."
      : ""
    const resetNotice = startupNotice === undefined ? "" : ` Startup safety reset: ${startupNotice}`
    return {
      text: `Started monitoring ${displayKey} — "${initial.title}".${autoMergeNotice}${resetNotice}`,
      start: { target, config, announcement },
    }
  }

  private select({ pr }: { pr: string }): WatchEntry<TConfig>[] | { error: string } {
    if (pr === "all") return [...this.watches.values()]
    const target = parseTarget(pr)
    if ("error" in target) return target
    const entry = this.watches.get(targetRegistryKey(target))
    if (!entry) {
      return {
        error: `No monitor for ${targetKey(target)} in this session. Use action "status" to list active monitors.`,
      }
    }
    return [entry]
  }

  private async stop({ pr }: { pr: string }): Promise<MonitorActionResult<TConfig>> {
    const selected = this.select({ pr })
    if ("error" in selected) return { text: selected.error }
    if (selected.length === 0) return { text: "No active monitors in this session." }
    for (const entry of selected) entry.watch.stop()
    await Promise.all(selected.map((entry) => entry.watch.waitUntilStopped()))
    return {
      text:
        `Stopped ${selected.length} monitor(s): ` +
        `${selected.map((entry) => targetKey(entry.watch.target)).join(", ")}.`,
    }
  }

  private async flush({ pr }: { pr: string }): Promise<MonitorActionResult<TConfig>> {
    const selected = this.select({ pr })
    if ("error" in selected) return { text: selected.error }
    if (selected.length === 0) return { text: "No active monitors in this session." }
    const reports = await Promise.all(selected.map((entry) => entry.watch.manualFlush()))
    return { text: reports.join("\n\n") }
  }

  private status(): string {
    if (this.watches.size === 0) return "No active monitors in this session."
    return [...this.watches.values()]
      .map(({ watch, config }) => {
        let suffix = ""
        try {
          suffix = this.deps.statusSuffix?.({ target: watch.target, config }) ?? ""
        } catch (error) {
          this.deps.log(`status decoration failed for ${targetKey(watch.target)}: ${error}`)
        }
        return `${watch.statusLine()}${suffix}`
      })
      .join("\n")
  }

  private async changeReady({
    pr,
    ready,
    loadConfig,
  }: {
    pr: string
    ready: boolean
    loadConfig: () => Promise<TConfig>
  }): Promise<MonitorActionResult<TConfig>> {
    const target = parseTarget(pr)
    if ("error" in target) return { text: target.error }
    const key = targetRegistryKey(target)
    const displayKey = targetKey(target)
    try {
      const watchedEntry = this.watches.get(key)
      if (watchedEntry !== undefined) {
        const text = await watchedEntry.watch.manualSetReady(ready)
        return {
          text,
          ready: { target: watchedEntry.watch.target, ready, watched: true },
        }
      }
      const config = await loadConfig()
      const pullRequest = ready && config.autoMerge
        ? await getAutoMergePullRequest({ runGh: this.deps.runGh, target })
        : undefined
      let text = ready
        ? await markReadyForHumanReview(this.deps.runGh, target, config.readyLabel)
        : await removeReadyForHumanReview(this.deps.runGh, target, config.readyLabel)
      if (pullRequest !== undefined) {
        try {
          text += `\n${await squashMergePullRequest({ runGh: this.deps.runGh, target, pullRequest })}`
        } catch (error) {
          const failure = autoMergeFailureText({ error })
          this.deps.log(`auto-merge failed for ${displayKey}: ${error}`)
          text += `\n${failure}`
        }
      }
      this.notifyReadyChanged({ target, ready, watched: false, config })
      return { text, ready: { target, ready, watched: false } }
    } catch (error) {
      const action = ready
        ? `mark ${displayKey} as ready for human review`
        : `withdraw the ready-for-human-review label from ${displayKey}`
      return { text: `Cannot ${action}: ${(error as Error).message}` }
    }
  }

  private fetchSnapshot({ target, config }: { target: Target; config: TConfig }): Promise<PrSnapshot> {
    return fetchPrSnapshot({
      runGh: this.deps.runGh,
      target,
      ignoreTag: config.ignoreCommentTag,
      selfLogin: this.selfLogin,
    })
  }

  private notifyWatchChanged(event: { type: WatchChangeType; target: Target; config: TConfig }): void {
    try {
      this.deps.onWatchChanged?.(event)
    } catch (error) {
      this.deps.log(`watch ${event.type} observer failed for ${targetKey(event.target)}: ${error}`)
    }
  }

  private notifyTickSettled(event: { target: Target; config: TConfig }): void {
    try {
      this.deps.onTickSettled?.(event)
    } catch (error) {
      this.deps.log(`tick observer failed for ${targetKey(event.target)}: ${error}`)
    }
  }

  private notifyReadyChanged(event: { target: Target; ready: boolean; watched: boolean; config: TConfig }): void {
    try {
      this.deps.onReadyChanged?.(event)
    } catch (error) {
      this.deps.log(`ready-state observer failed for ${targetKey(event.target)}: ${error}`)
    }
  }
}
