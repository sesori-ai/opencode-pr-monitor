// Per-PR watch state machine. Rolling debounce (no cap): any activity resets
// the quiet timer; when the quiet window elapses, a report is generated fresh
// from the latest snapshot and delivered to the owning session. A due report
// is held while the CI suite is running, bounded by maxCiWaitMinutes, then
// force-flushed naming unfinished checks.

import { detectActivity } from "./activity"
import type { MonitorConfig } from "./config"
import { ciPhase, PollError, type PrSnapshot } from "./github"
import { buildReport } from "./report"
import { targetKey, targetUrl, type Target } from "./target"

export type WatchDeps = {
  now: () => number
  fetchSnapshot: () => Promise<PrSnapshot>
  deliver: (report: string) => Promise<void>
  log: (message: string) => void
  onStopped: () => void
}

const MAX_CONSECUTIVE_FAILURES = 10

export class PrWatch {
  readonly target: Target
  readonly sessionID: string
  readonly config: MonitorConfig
  private readonly deps: WatchDeps
  private readonly startedAt: number

  private snapshot: PrSnapshot | undefined
  private dirty = false
  private lastActivityAt = 0
  private lastFlushAt: number
  private holdStartedAt: number | undefined
  private consecutiveFailures = 0
  private deliveryFailures = 0
  private fetchStartedAt: number | undefined
  private snapshotAt: number | undefined
  private stopped = false
  private ticking = false

  constructor(input: { target: Target; sessionID: string; config: MonitorConfig; deps: WatchDeps; initial: PrSnapshot }) {
    this.target = input.target
    this.sessionID = input.sessionID
    this.config = input.config
    this.deps = input.deps
    this.startedAt = input.deps.now()
    this.lastFlushAt = this.startedAt
    this.snapshot = input.initial
  }

  get isStopped(): boolean {
    return this.stopped
  }

  statusLine(): string {
    const now = this.deps.now()
    const phase = this.holdStartedAt !== undefined ? "ci-hold" : "watching"
    const baselineAge = Math.round((now - this.lastFlushAt) / 60_000)
    const failures = this.consecutiveFailures > 0 ? `, ${this.consecutiveFailures} consecutive poll failures` : ""
    return `${targetKey(this.target)} — ${phase}, ${this.dirty ? "activity buffered" : "quiet"}, baseline ${baselineAge}m ago${failures}`
  }

  /** Periodic poll; never throws. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      let next: PrSnapshot
      try {
        this.fetchStartedAt = this.deps.now()
        next = await this.deps.fetchSnapshot()
      } catch (error) {
        this.handlePollFailure(error)
        return
      }
      this.consecutiveFailures = 0
      this.snapshotAt = this.fetchStartedAt
      if (this.snapshot !== undefined && detectActivity(this.snapshot, next)) {
        this.dirty = true
        this.lastActivityAt = this.deps.now()
        this.holdStartedAt = undefined
      }
      this.snapshot = next
      this.maybeAutoFlush()
    } catch (error) {
      this.deps.log(`unexpected tick error for ${targetKey(this.target)}: ${error}`)
    } finally {
      this.ticking = false
    }
  }

  /** Manual flush: always re-fetches and always returns a full report. */
  async manualFlush(): Promise<string> {
    try {
      this.fetchStartedAt = this.deps.now()
      this.snapshot = await this.deps.fetchSnapshot()
      this.consecutiveFailures = 0
      this.snapshotAt = this.fetchStartedAt
    } catch (error) {
      if (this.snapshot === undefined) return `${targetKey(this.target)}: flush failed — ${(error as Error).message}`
      // Refresh failed: report from the stale snapshot WITHOUT advancing the
      // baseline, so activity newer than that snapshot is not silently skipped.
      const report = buildReport(this.target, this.snapshot, { baselineMs: this.lastFlushAt })
      return `${report}\n(note: refresh failed — ${(error as Error).message}; data is from the previous poll; baseline NOT reset)`
    }
    const report = this.flush(undefined)
    this.stopIfTerminal()
    return report
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.deps.onStopped()
  }

  stopWithNotice(reason: string): void {
    if (this.stopped) return
    this.deliverOrLog(`[PR Monitor] [${targetKey(this.target)}](${targetUrl(this.target)}) — ${reason}`)
    this.stop()
  }

  private handlePollFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof PollError && error.notFound) {
      this.deliverOrLog(`[PR Monitor] [${targetKey(this.target)}](${targetUrl(this.target)}) — Monitor stopped: PR not found (deleted or inaccessible). Last error: ${message}`)
      this.stop()
      return
    }
    this.consecutiveFailures += 1
    this.deps.log(`poll failed for ${targetKey(this.target)} (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${message}`)
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.deliverOrLog(`[PR Monitor] [${targetKey(this.target)}](${targetUrl(this.target)}) — Monitor stopped: ${MAX_CONSECUTIVE_FAILURES} consecutive poll failures. Last error: ${message}`)
      this.stop()
    }
  }

  private maybeAutoFlush(): void {
    if (!this.dirty || this.snapshot === undefined) return
    const now = this.deps.now()
    if (now - this.lastActivityAt < this.config.debounceMinutes * 60_000) return

    let forcedHoldMinutes: number | undefined
    if (ciPhase(this.snapshot) === "running" && this.snapshot.state === "OPEN") {
      if (this.holdStartedAt === undefined) this.holdStartedAt = now
      const heldMs = now - this.holdStartedAt
      if (heldMs < this.config.maxCiWaitMinutes * 60_000) return
      forcedHoldMinutes = Math.round(heldMs / 60_000)
    }
    const previousFlushAt = this.lastFlushAt
    const previousHoldStartedAt = this.holdStartedAt
    const report = this.flush(forcedHoldMinutes)
    void this.deps.deliver(report).then(
      () => {
        this.deliveryFailures = 0
        this.stopIfTerminal()
      },
      (error: unknown) => {
        // Delivery failed: restore the baseline, dirty flag, and CI-hold
        // timer so the same activity is re-reported on a later tick without
        // restarting the maxCiWaitMinutes window.
        this.lastFlushAt = previousFlushAt
        this.dirty = true
        this.holdStartedAt = previousHoldStartedAt
        this.deliveryFailures += 1
        this.deps.log(`report delivery failed for ${targetKey(this.target)} (${this.deliveryFailures}/${MAX_CONSECUTIVE_FAILURES}), will retry: ${error}`)
        if (this.deliveryFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.deps.log(`monitor stopped for ${targetKey(this.target)}: ${MAX_CONSECUTIVE_FAILURES} consecutive delivery failures`)
          this.stop()
        }
      },
    )
  }

  private deliverOrLog(message: string): void {
    void this.deps.deliver(message).catch((error: unknown) => this.deps.log(`report delivery failed for ${targetKey(this.target)}: ${error}`))
  }

  private flush(forcedHoldMinutes: number | undefined): string {
    const snapshot = this.snapshot!
    const report = buildReport(this.target, snapshot, { baselineMs: this.lastFlushAt, forcedHoldMinutes })
    this.lastFlushAt = this.snapshotAt ?? this.deps.now()
    this.dirty = false
    this.holdStartedAt = undefined
    return report
  }

  private stopIfTerminal(): void {
    if (this.snapshot !== undefined && this.snapshot.state !== "OPEN") this.stop()
  }
}
