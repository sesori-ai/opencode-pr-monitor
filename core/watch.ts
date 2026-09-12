// Per-PR watch state machine. Rolling debounce (no cap): any activity resets
// the quiet timer; when the quiet window elapses, a report is generated fresh
// from the latest snapshot and delivered to the owning session. A due report
// is held while the CI suite is running, bounded by maxCiWaitMinutes, then
// force-flushed naming unfinished checks. Actionable or terminal events — a
// new CI failure, readiness withdrawal, merge conflict, merge, or close — flush
// on the spot.

import { detectActivity, hasNewCiFailure, hasNewMergeConflict } from "./activity"
import type { WatchConfig } from "./config"
import { ciPhase, PollError, type PrSnapshot } from "./github"
import { autoMergeFailureText, type AutoMergePullRequest } from "./merge"
import {
  assessAutomaticReadiness,
  hasReadinessInvalidation,
  hasReadyLabel,
  withReadyLabel,
} from "./readiness"
import { buildReadinessLines, buildReport } from "./report"
import { targetKey, targetUrl, type Target } from "./target"

export type ReadinessDeps = {
  label: string
  replyPrefix: string
  change: (ready: boolean) => Promise<string>
  onChanged: (ready: boolean) => void
}

export type AutoMergeDeps = {
  squashMerge: (input: { pullRequest: AutoMergePullRequest }) => Promise<string>
}

export type WatchDeps = {
  now: () => number
  fetchSnapshot: () => Promise<PrSnapshot>
  deliver: (report: string) => Promise<void>
  /**
   * Best-effort persistence for a terminal notice when `deliver` itself is the
   * broken channel (consecutive delivery failures). Shells with a durable side
   * channel (Claude Code's spool, OpenCode's no-reply prompt) supply it so the
   * user eventually learns monitoring ended; without it the stop is log-only.
   */
  persist?: (report: string) => Promise<void>
  log: (message: string) => void
  onStopped: () => void
  readiness?: ReadinessDeps
  autoMerge?: AutoMergeDeps
  startupNotice?: string
}

const MAX_CONSECUTIVE_FAILURES = 10

export class PrWatch {
  readonly target: Target
  readonly config: WatchConfig
  private readonly deps: WatchDeps
  private readonly startedAt: number

  private snapshot: PrSnapshot | undefined
  // Last MERGEABLE/CONFLICTING value seen, carried across transient UNKNOWN
  // polls so a MERGEABLE -> UNKNOWN -> CONFLICTING settle is still detected.
  private lastDefiniteMergeable: "MERGEABLE" | "CONFLICTING" | undefined
  private dirty = false
  private lastActivityAt = 0
  private lastFlushAt: number
  private lastFlushedSnapshot: PrSnapshot
  // True until the configured startup report is successfully delivered or a
  // manual/automatic flush returns it. While true, reports use a zero baseline
  // so comments already present when the watch started cannot be hidden by a
  // failed initial delivery.
  private initialAnnouncementPending: boolean
  private holdStartedAt: number | undefined
  // Set for actionable or terminal changes that must skip both timers.
  private urgent = false
  // Head SHA whose CI failure already triggered an instant flush. Caps the
  // instant path at one report per commit.
  private ciFailureFlushedSha: string | undefined
  private consecutiveFailures = 0
  private deliveryFailures = 0
  private fetchStartedAt: number | undefined
  private snapshotAt: number | undefined
  private stopped = false
  private stopCleanup: Promise<void> | undefined
  // An already-started GitHub readiness mutation must drain before a successor
  // can own this PR. This includes an auto-merge already in flight; stopping
  // after label completion fences a follow-on merge that has not started yet.
  // Fetches and deliveries are fenced by `stopped` but do not block teardown.
  private readinessMutation: Promise<unknown> | undefined
  private readinessRetry: boolean | undefined
  private readinessRetryBaseline: PrSnapshot | undefined
  private readinessError: string | undefined
  private reportedReadinessError: string | undefined
  // One-shot result from an automatic readiness-triggered merge attempt. It is
  // retained across delivery failure, then cleared by delivery or a superseding
  // manual readiness action.
  private autoMergeNotice: string | undefined
  // A poll may observe new feedback and a prefixed response together. The
  // ready label is still withdrawn and reported first; only a later quiet
  // report can restore it, so the feedback never disappears behind one poll.
  private autoReadyAfterInvalidation = false
  // Serializes fetch/apply/mutate/flush/deliver and manual label actions.
  private opQueue: Promise<unknown> = Promise.resolve()
  private pendingOps = 0

  constructor(input: { target: Target; config: WatchConfig; deps: WatchDeps; initial: PrSnapshot }) {
    this.target = input.target
    this.config = input.config
    this.deps = input.deps
    this.startedAt = input.deps.now()
    this.lastFlushAt = this.startedAt
    this.snapshot = input.initial
    this.lastFlushedSnapshot = input.initial
    this.initialAnnouncementPending = input.config.announceOnStart
    this.rememberDefiniteMergeable(input.initial)
  }

  private rememberDefiniteMergeable(snapshot: PrSnapshot): void {
    if (snapshot.mergeable !== "UNKNOWN") this.lastDefiniteMergeable = snapshot.mergeable
  }

  get isStopped(): boolean {
    return this.stopped
  }

  statusLine(): string {
    const now = this.deps.now()
    const phase = this.holdStartedAt !== undefined ? "ci-hold" : "watching"
    const baselineAge = Math.round((now - this.lastFlushAt) / 60_000)
    const failures = this.consecutiveFailures > 0 ? `, ${this.consecutiveFailures} consecutive poll failures` : ""
    const readiness = this.deps.readiness
    const ready =
      readiness !== undefined && this.snapshot !== undefined
        ? `, ready for human review: ${hasReadyLabel(this.snapshot, readiness.label) ? "yes" : "no"}`
        : ""
    const autoMerge = this.deps.autoMerge === undefined ? "" : ", auto-merge: squash"
    return (
      `${targetKey(this.target)} — ${phase}, ${this.dirty ? "activity buffered" : "quiet"}, ` +
      `baseline ${baselineAge}m ago${failures}${ready}${autoMerge}`
    )
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.pendingOps += 1
    const run = this.opQueue.then(task)
    this.opQueue = run.then(
      () => {
        this.pendingOps -= 1
      },
      () => {
        this.pendingOps -= 1
      },
    )
    return run
  }

  private trackReadinessMutation<T>(task: () => Promise<T>): Promise<T> {
    const operation = task()
    let tracked!: Promise<T>
    tracked = operation.finally(() => {
      if (this.readinessMutation === tracked) this.readinessMutation = undefined
    })
    this.readinessMutation = tracked
    return tracked
  }

  /** Observe the existing label; the agent assesses the initial handoff. */
  async initializeReadiness(): Promise<void> {
    if (this.stopped) return
    await this.runExclusive(async () => {
      const snapshot = this.snapshot
      const readiness = this.deps.readiness
      if (this.stopped || snapshot === undefined || readiness === undefined) return
      this.notifyReadyChanged(hasReadyLabel(snapshot, readiness.label))
    })
  }

  /** Manual actions are serialized with polling and accept all current state. */
  async manualSetReady(ready: boolean): Promise<string> {
    if (this.stopped) throw new Error("the monitor stopped before the ready action could run")
    return await this.runExclusive(async () => {
      if (this.stopped) throw new Error("the monitor stopped before the ready action could run")
      const readiness = this.deps.readiness
      const snapshot = this.snapshot
      if (readiness === undefined || snapshot === undefined) {
        throw new Error("this watch does not have a readiness channel")
      }
      // A manual action returns its own merge result directly. Do not let an
      // undelivered automatic-attempt notice leak into a later report.
      this.autoMergeNotice = undefined
      return await this.trackReadinessMutation(async () => {
        let text = await readiness.change(ready)
        this.snapshot = withReadyLabel(snapshot, readiness.label, ready)
        if (!this.stopped) {
          this.clearReadinessFailure()
          this.autoReadyAfterInvalidation = false
          this.notifyReadyChanged(ready)
          if (ready) {
            const autoMerge = await this.attemptAutoMerge({ snapshot: this.snapshot, report: false })
            if (autoMerge !== undefined) text += `\n${autoMerge}`
          } else if (assessAutomaticReadiness(this.snapshot).eligible) {
            this.dirty = true
            this.lastActivityAt = this.deps.now()
            this.holdStartedAt = undefined
          }
        }
        return text
      })
    })
  }

  /** Periodic poll; never throws. Skipped while a poll or flush is in flight. */
  async tick(): Promise<void> {
    if (this.stopped || this.pendingOps > 0) return
    try {
      await this.runExclusive(() => this.pollOnce())
    } catch (error) {
      this.deps.log(`unexpected tick error for ${targetKey(this.target)}: ${error}`)
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped) return
    let next: PrSnapshot
    try {
      this.fetchStartedAt = this.deps.now()
      next = await this.deps.fetchSnapshot()
    } catch (error) {
      if (!this.stopped) this.handlePollFailure(error)
      return
    }
    if (this.stopped) return
    this.consecutiveFailures = 0
    this.snapshotAt = this.fetchStartedAt
    next = await this.applySnapshot(next)
    this.snapshot = next
    if (this.stopped) return
    this.rememberDefiniteMergeable(next)
    await this.maybeAutoFlush()
  }

  private async applySnapshot(next: PrSnapshot): Promise<PrSnapshot> {
    const previous = this.snapshot
    if (previous === undefined) return next
    const becameTerminal = previous.state === "OPEN" && next.state !== "OPEN"
    const becameConflicting = hasNewMergeConflict(this.lastDefiniteMergeable, next)
    const now = this.deps.now()
    if (detectActivity(previous, next, this.lastDefiniteMergeable)) {
      this.dirty = true
      this.lastActivityAt = now
      this.holdStartedAt = undefined
    }
    if (
      this.config.flushOnCiFailure &&
      next.state === "OPEN" &&
      this.ciFailureFlushedSha !== next.headSha &&
      hasNewCiFailure(previous, next)
    ) {
      this.dirty = true
      this.urgent = true
      this.ciFailureFlushedSha = next.headSha
      this.holdStartedAt = undefined
    }
    if (becameConflicting || becameTerminal) {
      this.dirty = true
      this.urgent = true
      this.holdStartedAt = undefined
    }

    const readiness = this.deps.readiness
    if (readiness === undefined) return next
    const wasReady = hasReadyLabel(previous, readiness.label)
    const observedReady = hasReadyLabel(next, readiness.label)

    if (next.state !== "OPEN") {
      this.clearReadinessFailure()
      if (wasReady !== observedReady) this.notifyReadyChanged(observedReady)
      return next
    }

    if (this.readinessRetry !== undefined) {
      const desired = this.readinessRetry
      const retryInvalidated =
        desired &&
        this.readinessRetryBaseline !== undefined &&
        hasReadinessInvalidation(this.readinessRetryBaseline, next, this.lastDefiniteMergeable)
      if (retryInvalidated) {
        this.clearReadinessFailure()
        this.dirty = true
        this.lastActivityAt = now
        this.holdStartedAt = undefined
        if (observedReady) {
          this.urgent = true
          const changed = await this.changeSnapshotReadiness(next, false)
          if (!hasReadyLabel(changed, readiness.label)) this.autoReadyAfterInvalidation = true
          return changed
        }
      } else if (observedReady === desired) {
        this.clearReadinessFailure()
        this.notifyReadyChanged(desired)
        this.dirty = true
        this.urgent = true
        // A failed mutation never authorizes auto-merge. The matching label may
        // have been added externally after the error, so observation alone can
        // confirm readiness but cannot prove a monitor-triggered merge intent.
        if (!desired) this.autoReadyAfterInvalidation = true
        return next
      } else if (!desired || assessAutomaticReadiness(next).eligible) {
        const changed = await this.changeSnapshotReadiness(next, desired)
        if (hasReadyLabel(changed, readiness.label) === desired) {
          this.dirty = true
          this.urgent = true
          if (!desired) this.autoReadyAfterInvalidation = true
        }
        return changed
      } else {
        this.clearReadinessFailure()
      }
    }

    if (wasReady && hasReadinessInvalidation(previous, next, this.lastDefiniteMergeable)) {
      this.dirty = true
      this.urgent = true
      this.holdStartedAt = undefined
      if (!observedReady) {
        this.notifyReadyChanged(false)
        this.autoReadyAfterInvalidation = true
        return next
      }
      const changed = await this.changeSnapshotReadiness(next, false)
      if (!hasReadyLabel(changed, readiness.label)) this.autoReadyAfterInvalidation = true
      return changed
    }

    if (wasReady !== observedReady) {
      this.notifyReadyChanged(observedReady)
      if (!observedReady) {
        this.dirty = true
        this.lastActivityAt = now
        this.holdStartedAt = undefined
      }
    }

    const beforeEligible = assessAutomaticReadiness(previous).eligible
    const afterEligible = assessAutomaticReadiness(next).eligible
    if (!observedReady && afterEligible && !beforeEligible) {
      this.dirty = true
      this.lastActivityAt = now
      this.holdStartedAt = undefined
    }
    return next
  }

  /**
   * Initial status delivered right after the watch starts. A delivery failure
   * is re-armed without advancing the baseline.
   */
  async announceInitial(): Promise<boolean> {
    if (this.stopped) return false
    return await this.runExclusive(() => this.announceInitialOnce())
  }

  private async announceInitialOnce(): Promise<boolean> {
    if (this.stopped || this.snapshot === undefined) return false
    const readiness = this.deps.readiness
    if (readiness !== undefined) {
      this.notifyReadyChanged(hasReadyLabel(this.snapshot, readiness.label))
    }
    const report = this.buildCurrentReport({ baselineMs: 0 })
    if (await this.deliverOrLog(report)) {
      this.deliveryFailures = 0
      this.lastFlushAt = this.snapshotAt ?? this.startedAt
      this.lastFlushedSnapshot = this.snapshot
      this.initialAnnouncementPending = false
      this.dirty = false
      this.holdStartedAt = undefined
      this.urgent = false
      this.afterReportDelivered()
      return true
    }
    this.deliveryFailures += 1
    this.dirty = true
    this.urgent = true
    if (this.deliveryFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.deps.log(
        `monitor stopped for ${targetKey(this.target)}: ${MAX_CONSECUTIVE_FAILURES} consecutive delivery failures`,
      )
      this.stop()
    }
    return false
  }

  /** Manual flush always re-fetches and returns a full report. */
  async manualFlush(): Promise<string> {
    if (this.stopped) return `${targetKey(this.target)}: flush skipped — monitor stopped.`
    return await this.runExclusive(() => this.flushOnce())
  }

  private async flushOnce(): Promise<string> {
    if (this.stopped) return `${targetKey(this.target)}: flush skipped — monitor stopped.`
    try {
      this.fetchStartedAt = this.deps.now()
      const fetched = await this.deps.fetchSnapshot()
      if (this.stopped) return `${targetKey(this.target)}: flush skipped — monitor stopped.`
      this.consecutiveFailures = 0
      this.snapshotAt = this.fetchStartedAt
      this.snapshot = await this.applySnapshot(fetched)
      this.rememberDefiniteMergeable(this.snapshot)
    } catch (error) {
      if (this.stopped) return `${targetKey(this.target)}: flush skipped — monitor stopped.`
      if (this.snapshot === undefined) return `${targetKey(this.target)}: flush failed — ${(error as Error).message}`
      const report = this.buildCurrentReport({
        baselineMs: this.initialAnnouncementPending ? 0 : this.lastFlushAt,
        baselineSnapshot: this.initialAnnouncementPending ? undefined : this.lastFlushedSnapshot,
      })
      return (
        `${report}\n(note: refresh failed — ${(error as Error).message}; ` +
        "data is from the previous poll; baseline NOT reset)"
      )
    }
    if (this.stopped) return `${targetKey(this.target)}: flush skipped — monitor stopped.`
    if (this.dirty && !this.autoReadyAfterInvalidation) await this.prepareAutomaticReady()
    if (this.stopped) return `${targetKey(this.target)}: flush skipped — monitor stopped.`
    const report = this.flush(undefined)
    this.afterReportDelivered()
    this.stopIfTerminal()
    return report
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    const finish = (): void => {
      try {
        this.deps.onStopped()
      } catch (error) {
        this.deps.log(`stop observer failed for ${targetKey(this.target)}: ${error}`)
      }
    }
    const mutation = this.readinessMutation
    if (mutation === undefined) {
      finish()
      this.stopCleanup = Promise.resolve()
      return
    }
    this.stopCleanup = mutation.then(finish, finish)
  }

  async waitUntilStopped(): Promise<void> {
    await this.stopCleanup
  }

  stopNotice(reason: string): string {
    const base = `[PR Monitor] [${targetKey(this.target)}](${targetUrl(this.target)}) — ${reason}`
    const snapshot = this.snapshot
    const readiness = this.deps.readiness
    if (snapshot === undefined || readiness === undefined) return base
    return [
      base,
      ...buildReadinessLines({
        target: this.target,
        snapshot,
        readyLabel: readiness.label,
        replyPrefix: readiness.replyPrefix,
        readinessError: this.readinessError,
        autoMergeEnabled: this.deps.autoMerge !== undefined,
        autoMergeNotice: this.autoMergeNotice,
      }),
    ].join("\n")
  }

  private handlePollFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof PollError && error.notFound) {
      void this.deliverStopNotice(
        this.stopNotice(
          `Monitor stopped: PR not found (deleted or inaccessible). Last error: ${message}`,
        ),
      )
      this.stop()
      return
    }
    this.consecutiveFailures += 1
    this.deps.log(
      `poll failed for ${targetKey(this.target)} (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${message}`,
    )
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      void this.deliverStopNotice(
        this.stopNotice(
          `Monitor stopped: ${MAX_CONSECUTIVE_FAILURES} consecutive poll failures. Last error: ${message}`,
        ),
      )
      this.stop()
    }
  }

  private async maybeAutoFlush(): Promise<void> {
    if (!this.dirty || this.snapshot === undefined) return
    const now = this.deps.now()
    let forcedHoldMinutes: number | undefined
    if (!this.urgent) {
      if (now - this.lastActivityAt < this.config.debounceMinutes * 60_000) return
      if (ciPhase(this.snapshot) === "running" && this.snapshot.state === "OPEN") {
        if (this.holdStartedAt === undefined) this.holdStartedAt = now
        const heldMs = now - this.holdStartedAt
        if (heldMs < this.config.maxCiWaitMinutes * 60_000) return
        forcedHoldMinutes = Math.round(heldMs / 60_000)
      }
    }
    if (this.stopped) return
    if (!this.autoReadyAfterInvalidation) await this.prepareAutomaticReady()
    if (this.stopped) return
    const previousFlushAt = this.lastFlushAt
    const previousFlushedSnapshot = this.lastFlushedSnapshot
    const previousInitialAnnouncementPending = this.initialAnnouncementPending
    const previousHoldStartedAt = this.holdStartedAt
    const previousUrgent = this.urgent
    const report = this.flush(forcedHoldMinutes)
    try {
      await this.deps.deliver(report)
      this.deliveryFailures = 0
      this.afterReportDelivered()
      this.stopIfTerminal()
    } catch (error) {
      this.lastFlushAt = previousFlushAt
      this.lastFlushedSnapshot = previousFlushedSnapshot
      this.initialAnnouncementPending = previousInitialAnnouncementPending
      this.dirty = true
      this.holdStartedAt = previousHoldStartedAt
      this.urgent = previousUrgent
      this.deliveryFailures += 1
      this.deps.log(
        `report delivery failed for ${targetKey(this.target)} ` +
          `(${this.deliveryFailures}/${MAX_CONSECUTIVE_FAILURES}), will retry: ${error}`,
      )
      if (this.deliveryFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.deps.log(
          `monitor stopped for ${targetKey(this.target)}: ${MAX_CONSECUTIVE_FAILURES} consecutive delivery failures`,
        )
        // The delivery channel is the thing that is broken, so the notice goes
        // through the shell's persistent side channel when one exists. A watch
        // stopped manually while this attempt was in flight owes no notice.
        if (!this.stopped && this.deps.persist !== undefined) {
          try {
            await this.deps.persist(
              this.stopNotice(
                `Monitor stopped: ${MAX_CONSECUTIVE_FAILURES} consecutive delivery failures. Last error: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
              ),
            )
          } catch (persistError) {
            this.deps.log(`terminal stop notice could not be persisted for ${targetKey(this.target)}: ${persistError}`)
          }
        }
        this.stop()
      }
    }
  }

  private async prepareAutomaticReady(): Promise<void> {
    const snapshot = this.snapshot
    const readiness = this.deps.readiness
    if (
      snapshot === undefined ||
      readiness === undefined ||
      // Failed delivery alone is not new activity. Keep unchanged startup
      // retries for agent assessment, but allow activity since that snapshot.
      (this.initialAnnouncementPending &&
        assessAutomaticReadiness(this.lastFlushedSnapshot).eligible &&
        !detectActivity(this.lastFlushedSnapshot, snapshot, this.lastFlushedSnapshot.mergeable)) ||
      snapshot.state !== "OPEN" ||
      hasReadyLabel(snapshot, readiness.label) ||
      !assessAutomaticReadiness(snapshot).eligible
    ) {
      return
    }
    this.snapshot = await this.changeSnapshotReadiness(snapshot, true)
  }

  private async changeSnapshotReadiness(snapshot: PrSnapshot, ready: boolean): Promise<PrSnapshot> {
    const readiness = this.deps.readiness
    if (readiness === undefined) return snapshot
    return await this.trackReadinessMutation(async () => {
      try {
        await readiness.change(ready)
        const changed = withReadyLabel(snapshot, readiness.label, ready)
        this.snapshot = changed
        if (this.stopped) return changed
        this.clearReadinessFailure()
        this.notifyReadyChanged(ready)
        if (ready) await this.attemptAutoMerge({ snapshot: changed, report: true })
        return changed
      } catch (error) {
        this.snapshot = snapshot
        const action = ready ? "add" : "remove"
        const message =
          `could not ${action} label "${readiness.label}": ` +
          `${error instanceof Error ? error.message : String(error)}`
        if (this.readinessRetry !== ready || this.readinessRetryBaseline === undefined) {
          this.readinessRetryBaseline = snapshot
        }
        this.readinessRetry = ready
        this.readinessError = message
        if (message !== this.reportedReadinessError) {
          this.dirty = true
          this.urgent = true
        }
        this.deps.log(`readiness automation failed for ${targetKey(this.target)}: ${message}`)
        return snapshot
      }
    })
  }

  private async attemptAutoMerge({
    snapshot,
    report,
  }: {
    snapshot: PrSnapshot
    report: boolean
  }): Promise<string | undefined> {
    const autoMerge = this.deps.autoMerge
    if (autoMerge === undefined) return undefined
    let notice: string
    try {
      notice = await autoMerge.squashMerge({
        pullRequest: { title: snapshot.title, headSha: snapshot.headSha },
      })
    } catch (error) {
      notice = autoMergeFailureText({ error })
      this.deps.log(`auto-merge failed for ${targetKey(this.target)}: ${error}`)
    }
    if (report) this.autoMergeNotice = notice
    return notice
  }

  private clearReadinessFailure(): void {
    this.readinessRetry = undefined
    this.readinessRetryBaseline = undefined
    this.readinessError = undefined
    this.reportedReadinessError = undefined
  }

  private notifyReadyChanged(ready: boolean): void {
    try {
      this.deps.readiness?.onChanged(ready)
    } catch (error) {
      this.deps.log(`ready-state observer failed for ${targetKey(this.target)}: ${error}`)
    }
  }

  private afterReportDelivered(): void {
    this.reportedReadinessError = this.readinessError
    this.autoMergeNotice = undefined
    if (!this.autoReadyAfterInvalidation) return
    this.autoReadyAfterInvalidation = false
    const snapshot = this.snapshot
    const readiness = this.deps.readiness
    if (
      snapshot !== undefined &&
      readiness !== undefined &&
      snapshot.state === "OPEN" &&
      !hasReadyLabel(snapshot, readiness.label) &&
      assessAutomaticReadiness(snapshot).eligible
    ) {
      this.dirty = true
      this.lastActivityAt = this.deps.now()
      this.holdStartedAt = undefined
      this.urgent = false
    }
  }

  /**
   * Deliver a terminal stop notice, falling back to the persistent channel
   * when the delivery channel itself fails — a watch that stops must not do so
   * silently when any channel can still carry the fact.
   */
  private async deliverStopNotice(message: string): Promise<void> {
    if (await this.deliverOrLog(message)) return
    if (this.deps.persist === undefined) return
    try {
      await this.deps.persist(message)
    } catch (error) {
      this.deps.log(`terminal stop notice could not be persisted for ${targetKey(this.target)}: ${error}`)
    }
  }

  private async deliverOrLog(message: string): Promise<boolean> {
    try {
      await this.deps.deliver(message)
      return true
    } catch (error) {
      this.deps.log(`report delivery failed for ${targetKey(this.target)}: ${error}`)
      return false
    }
  }

  private buildCurrentReport({
    baselineMs,
    baselineSnapshot,
    forcedHoldMinutes,
  }: {
    baselineMs: number
    baselineSnapshot?: PrSnapshot
    forcedHoldMinutes?: number
  }): string {
    const readiness = this.deps.readiness
    const report = buildReport(this.target, this.snapshot!, {
      baselineMs,
      baselineSnapshot,
      forcedHoldMinutes,
      readyLabel: readiness?.label,
      replyPrefix: readiness?.replyPrefix,
      readinessError: this.readinessError,
      autoMergeEnabled: this.deps.autoMerge !== undefined,
      autoMergeNotice: this.autoMergeNotice,
    })
    if (!this.initialAnnouncementPending || this.snapshot?.state !== "OPEN") return report
    const startupNotice = this.deps.startupNotice === undefined
      ? ""
      : `\n- Startup safety reset: ${this.deps.startupNotice}`
    return report + startupNotice +
      "\n- Startup/restart assessment: inspect the current head's checks, expected automated reviews, " +
      "and existing feedback now. If already settled with nothing left to do, call mark_ready without waiting " +
      "for a new event. Empty results after creation or a fresh push do not prove readiness; PR age alone is insufficient."
  }

  private flush(forcedHoldMinutes: number | undefined): string {
    const snapshot = this.snapshot!
    const report = this.buildCurrentReport({
      baselineMs: this.initialAnnouncementPending ? 0 : this.lastFlushAt,
      baselineSnapshot: this.initialAnnouncementPending ? undefined : this.lastFlushedSnapshot,
      forcedHoldMinutes,
    })
    this.lastFlushAt = this.snapshotAt ?? this.deps.now()
    this.lastFlushedSnapshot = snapshot
    this.initialAnnouncementPending = false
    this.dirty = false
    this.holdStartedAt = undefined
    this.urgent = false
    return report
  }

  private stopIfTerminal(): void {
    if (this.snapshot !== undefined && this.snapshot.state !== "OPEN") this.stop()
  }
}
