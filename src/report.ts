// Report rendering: facts only — no advice, no comment bodies, just counts
// and authors. "New" = created after the watch's lastFlushAt baseline.

import { ciPhase, type CommentMeta, type PrSnapshot } from "./github"
import { targetKey, type Target } from "./target"

function authorBreakdown(comments: CommentMeta[]): string {
  const counts = new Map<string, number>()
  for (const comment of comments) {
    const name = comment.isBot ? `${comment.author}[bot]` : comment.author
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count} ${name}`)
    .join(", ")
}

function newSince(comments: CommentMeta[], baselineMs: number): CommentMeta[] {
  return comments.filter((comment) => Date.parse(comment.createdAt) > baselineMs)
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
  const failedPart = failed.length > 0 ? `, ${failed.length} failed so far: ${failed.map((check) => check.name).join(", ")}` : ""
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

export function buildReport(
  target: Target,
  snapshot: PrSnapshot,
  opts: { baselineMs: number; forcedHoldMinutes?: number },
): string {
  const stateSuffix = snapshot.state !== "OPEN" ? ` — ${snapshot.state}` : ""
  const title = snapshot.title.replace(/\s+/g, " ").trim()
  const newInline = newSince(snapshot.inlineComments, opts.baselineMs)
  const newIssue = newSince(snapshot.issueComments, opts.baselineMs)
  const newPart = (fresh: CommentMeta[]): string =>
    fresh.length > 0 ? `${fresh.length} new since last flush: ${authorBreakdown(fresh)}` : "0 new since last flush"
  return [
    `[PR Monitor] ${targetKey(target)} — "${title}"${stateSuffix} (${snapshot.url})`,
    ciLine(snapshot, opts.forcedHoldMinutes),
    `- Mergeable: ${snapshot.mergeable}`,
    reviewLine(snapshot),
    `- [comment:inline] ${snapshot.unresolvedThreads} unresolved threads (${newPart(newInline)})`,
    `- [comment:issue] ${snapshot.issueCommentsTotal} total (${newPart(newIssue)})`,
  ].join("\n")
}
