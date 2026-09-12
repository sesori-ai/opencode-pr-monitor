// Report rendering: no comment bodies or advice about the substance of a
// review. "New" means absent from the last successfully flushed snapshot;
// standalone initial reports fall back to their timestamp baseline.

import { relevantComments } from "./activity"
import { ciPhase, type CommentMeta, type PrSnapshot, type ReviewThreadInfo } from "./github"
import { assessAutomaticReadiness, hasReadyLabel } from "./readiness"
import { targetKey, type Target } from "./target"

const DEFAULT_READY_LABEL = "ready-for-human-review"
const DEFAULT_REPLY_PREFIX = "<!-- pr-monitor:reply -->"

function authorBreakdown(comments: CommentMeta[]): string {
  const counts = new Map<string, number>()
  for (const comment of comments) {
    const account = comment.isBot ? `${comment.author}[bot]` : comment.author
    const qualifiers = [
      comment.isLocal ? "local account, unprefixed" : undefined,
      comment.reviewState === "PENDING" ? "pending review" : undefined,
    ].filter((qualifier): qualifier is string => qualifier !== undefined)
    const name = qualifiers.length > 0 ? `${account} [${qualifiers.join("; ")}]` : account
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count} ${name}`)
    .join(", ")
}

function newSince(comments: CommentMeta[], baselineMs: number, baselineComments?: CommentMeta[]): CommentMeta[] {
  const fresh = (() => {
    if (baselineComments !== undefined) {
      const seen = new Set(baselineComments.map((comment) => comment.id))
      return comments.filter((comment) => !seen.has(comment.id))
    }
    return comments.filter((comment) => Date.parse(comment.createdAt) > baselineMs)
  })()
  return relevantComments(fresh)
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`
}

function inlineCode(value: string): string {
  let fence = "`"
  while (value.includes(fence)) fence += "`"
  return `${fence}${value}${fence}`
}

function threadLocator(thread: ReviewThreadInfo): string {
  const threadId = `thread ${inlineCode(thread.id)}`
  if (thread.path !== undefined) {
    const location = inlineCode(`${thread.path}${thread.line === undefined ? "" : `:${thread.line}`}`)
    return `${location} [${threadId}]`
  }
  return threadId
}

function inlineLine(snapshot: PrSnapshot, baselineMs: number, baseline?: PrSnapshot): string {
  const unresolved = snapshot.reviewThreads.filter((thread) => !thread.isResolved).length
  const before = new Map(baseline?.reviewThreads.map((thread) => [thread.id, thread.comments]) ?? [])
  const changed = snapshot.reviewThreads
    .map((thread) => ({
      thread,
      comments: newSince(thread.comments, baselineMs, baseline ? before.get(thread.id) ?? [] : undefined),
    }))
    .filter((item) => item.comments.length > 0)
  if (changed.length === 0) {
    return (
      `- [comment:inline] ${countLabel(unresolved, "unresolved thread")}; ` +
      "0 threads received new relevant comments since last flush"
    )
  }

  const fresh = changed.flatMap((item) => item.comments)
  const previousUnresolved = baseline?.reviewThreads.filter((thread) => !thread.isResolved).length
  const unresolvedNotice =
    previousUnresolved === undefined
      ? `Inspect every changed thread regardless of the current unresolved-thread count (${unresolved}).`
      : previousUnresolved === unresolved
        ? `The unresolved-thread count is unchanged at ${unresolved}; inspect every changed thread anyway.`
        : `The unresolved-thread count changed from ${previousUnresolved} to ${unresolved}; inspect every changed thread.`
  const changedUnresolved = changed.filter((item) => !item.thread.isResolved).length
  const changedResolved = changed.length - changedUnresolved
  const states = [
    changedUnresolved > 0 ? `${changedUnresolved} currently unresolved` : undefined,
    changedResolved > 0 ? `${changedResolved} currently resolved` : undefined,
  ].filter((part): part is string => part !== undefined)
  const changedThreads = changed
    .map(
      ({ thread, comments }) =>
        `${threadLocator(thread)} (${thread.isResolved ? "resolved" : "unresolved"}; ${authorBreakdown(comments)})`,
    )
    .join("; ")
  const localNotice = fresh.some((comment) => comment.isLocal)
    ? ` A listed ${inlineCode("[local account, unprefixed]")} entry is a new human comment, not an earlier agent reply.`
    : ""
  const pendingNotice = fresh.some((comment) => comment.isLocal && comment.reviewState === "PENDING")
    ? " Pending-review comments may be absent from REST pull-comment results; inspect the listed thread through " +
      "GraphQL before marking ready."
    : ""
  return (
    `- [comment:inline] ACTION REQUIRED: ${countLabel(changed.length, "thread")} received ` +
    `${countLabel(fresh.length, "new relevant comment")} since last flush ` +
    `(${states.join(", ")}; ${authorBreakdown(fresh)}). ${unresolvedNotice} ` +
    `Changed threads: ${changedThreads}.${localNotice}${pendingNotice}`
  )
}

function ciLine(snapshot: PrSnapshot, forcedHoldMinutes: number | undefined): string {
  const phase = ciPhase(snapshot)
  if (phase === "none") return "- CI: none"
  const total = snapshot.checks.length
  const failed = snapshot.checks.filter((check) => check.outcome === "failure")
  const pending = snapshot.checks.filter((check) => check.outcome === "pending")
  if (phase === "concluded") {
    if (failed.length === 0) return `- CI: passing (${total}/${total})`
    return `- CI: failing (${failed.length}/${total} failed: ${failed.map((check) => check.name).join(", ")})`
  }
  if (forcedHoldMinutes !== undefined) {
    return `- CI: running for ${forcedHoldMinutes}m+ (in_progress: ${pending.map((check) => check.name).join(", ")})`
  }
  const done = total - pending.length
  const failedPart =
    failed.length > 0 ? `, ${failed.length} failed so far: ${failed.map((check) => check.name).join(", ")}` : ""
  return `- CI: running (${done}/${total} done${failedPart})`
}

function reviewLine(snapshot: PrSnapshot): string {
  const MARKS: Record<string, string> = {
    APPROVED: "✓ approved",
    CHANGES_REQUESTED: "✗ changes_requested",
    COMMENTED: "✦ commented",
    DISMISSED: "⊘ dismissed",
  }
  const parts = snapshot.reviews.map((review) => `${review.login} ${MARKS[review.state] ?? review.state.toLowerCase()}`)
  for (const login of snapshot.pendingReviewers) parts.push(`${login} ⏳ pending`)
  return `- Reviews: ${parts.length > 0 ? parts.join(" · ") : "none"}`
}

function reviewSummaryLine(snapshot: PrSnapshot, baselineMs: number, baseline?: PrSnapshot): string {
  const fresh = newSince(snapshot.reviewSummaries, baselineMs, baseline?.reviewSummaries)
  return fresh.length === 0
    ? "- [comment:review] 0 new relevant review summaries since last flush"
    : `- [comment:review] ACTION REQUIRED: ${countLabel(fresh.length, "new relevant review summary")} since ` +
        `last flush (${authorBreakdown(fresh)}).`
}

export function buildReadinessLines({
  target,
  snapshot,
  readyLabel,
  replyPrefix,
  readinessError,
  autoMergeEnabled = false,
  autoMergeNotice,
}: {
  target: Target
  snapshot: PrSnapshot
  readyLabel: string
  replyPrefix: string
  readinessError?: string
  autoMergeEnabled?: boolean
  autoMergeNotice?: string
}): string[] {
  const ready = hasReadyLabel(snapshot, readyLabel)
  const lines = [
    ready
      ? `- Ready for human review: YES — label "${readyLabel}" is present.`
      : `- Ready for human review: NO — label "${readyLabel}" is absent.`,
  ]
  if (autoMergeEnabled) {
    lines.push(
      "- Auto-merge: ENABLED — automatic readiness and mark_ready make one squash-merge attempt for the " +
        "accepted head; the squash commit uses only the PR title.",
    )
  }
  if (readinessError !== undefined) lines.push(`- Readiness automation failed: ${readinessError}`)
  if (autoMergeNotice !== undefined) lines.push(`- ${autoMergeNotice}`)
  if (!ready && snapshot.state === "OPEN") {
    const assessment = assessAutomaticReadiness(snapshot)
    if (assessment.blockers.length > 0) {
      lines.push(`- Automatic readiness blocked by: ${assessment.blockers.join("; ")}.`)
    }
    lines.push(
      "- Required next step: Do more work until the PR is ready for review, or use " +
        `${inlineCode(`pr_monitor(action: "mark_ready", pr: "${targetKey(target)}")`)} if you believe nothing else ` +
        `is required. Local agent replies count only when they begin with ${inlineCode(replyPrefix)}.`,
    )
  }
  return lines
}

export function buildReport(
  target: Target,
  snapshot: PrSnapshot,
  opts: {
    baselineMs: number
    baselineSnapshot?: PrSnapshot
    forcedHoldMinutes?: number
    readyLabel?: string
    replyPrefix?: string
    readinessError?: string
    autoMergeEnabled?: boolean
    autoMergeNotice?: string
  },
): string {
  const stateSuffix = snapshot.state !== "OPEN" ? ` — ${snapshot.state}` : ""
  const title = snapshot.title.replace(/\s+/g, " ").trim()
  const newIssue = newSince(snapshot.issueComments, opts.baselineMs, opts.baselineSnapshot?.issueComments)
  const newPart = (fresh: CommentMeta[]): string =>
    fresh.length > 0
      ? `${fresh.length} new relevant since last flush: ${authorBreakdown(fresh)}`
      : "0 new since last flush"
  const readyLabel = opts.readyLabel ?? DEFAULT_READY_LABEL
  const replyPrefix = opts.replyPrefix ?? DEFAULT_REPLY_PREFIX
  const lines = [
    `[PR Monitor] [${targetKey(target)}](${snapshot.url}) — "${title}"${stateSuffix}`,
    ciLine(snapshot, opts.forcedHoldMinutes),
    `- Mergeable: ${snapshot.mergeable}`,
    reviewLine(snapshot),
    reviewSummaryLine(snapshot, opts.baselineMs, opts.baselineSnapshot),
    inlineLine(snapshot, opts.baselineMs, opts.baselineSnapshot),
    `- [comment:issue] ${snapshot.issueCommentsTotal} total (${newPart(newIssue)})`,
    ...buildReadinessLines({
      target,
      snapshot,
      readyLabel,
      replyPrefix,
      readinessError: opts.readinessError,
      autoMergeEnabled: opts.autoMergeEnabled,
      autoMergeNotice: opts.autoMergeNotice,
    }),
  ]
  if (snapshot.labels.length > 0) lines.push(`- Labels: ${snapshot.labels.join(", ")}`)
  if (snapshot.state !== "OPEN") {
    lines.push(`- Monitor stopped: PR ${snapshot.state === "MERGED" ? "merged" : "closed"}`)
  }
  return lines.join("\n")
}
