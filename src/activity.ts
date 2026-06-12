import { ciPhase, type CommentMeta, type PrSnapshot } from "./github"

function commentSig(comments: CommentMeta[]): string {
  const last = comments[comments.length - 1]
  return `${comments.length}:${last?.createdAt ?? ""}`
}

function reviewSig(snapshot: PrSnapshot): string {
  const states = snapshot.reviews.map((review) => `${review.login}=${review.state}@${review.submittedAt}`).sort()
  const pending = [...snapshot.pendingReviewers].sort()
  return `${states.join(",")}|${pending.join(",")}`
}

function ciConcludedSig(snapshot: PrSnapshot): string {
  const failed = snapshot.checks
    .filter((check) => check.outcome === "failure")
    .map((check) => check.name)
    .sort()
  return `${snapshot.headSha}:${failed.join(",")}`
}

/** True when something report-worthy changed between consecutive polls. */
export function detectActivity(prev: PrSnapshot, next: PrSnapshot): boolean {
  if (prev.state !== next.state) return true
  if (prev.mergeable !== next.mergeable) return true
  if (reviewSig(prev) !== reviewSig(next)) return true
  if (prev.unresolvedThreads !== next.unresolvedThreads) return true
  if (commentSig(prev.inlineComments) !== commentSig(next.inlineComments)) return true
  if (prev.issueCommentsTotal !== next.issueCommentsTotal || commentSig(prev.issueComments) !== commentSig(next.issueComments)) return true
  // CI: only suite conclusion counts. Transitions into "running" (new push)
  // and per-check progress are intentionally NOT activity.
  if (ciPhase(next) === "concluded" && (ciPhase(prev) !== "concluded" || ciConcludedSig(prev) !== ciConcludedSig(next))) return true
  return false
}
