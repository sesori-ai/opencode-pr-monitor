// Marking a PR as ready for human review: apply (or withdraw) a label via the
// GitHub REST API. The label is ensured to exist first so it gets a deliberate
// color and description — the add-labels endpoint auto-creates missing labels,
// but as default grey with no description.

import { PollError, type GhRunner } from "./github"
import { targetKey, type Target } from "./target"

const READY_LABEL_COLOR = "0e8a16" // GitHub's standard green
const READY_LABEL_DESCRIPTION = "This PR is ready for human review"

/**
 * Verify the target is an actual OPEN pull request. The labels endpoints
 * operate on the shared issue namespace, so without this check a plain issue
 * number — or a merged/closed PR — would be silently (un)labeled and reported
 * as success.
 */
export type OpenPullRequest = {
  title: string | undefined
  headSha: string | undefined
}

export async function getOpenPullRequest({
  runGh,
  target,
}: {
  runGh: GhRunner
  target: Target
}): Promise<OpenPullRequest> {
  const repo = `repos/${target.owner}/${target.repo}`
  let raw: string
  try {
    raw = await runGh(["api", `${repo}/pulls/${target.number}`])
  } catch (error) {
    if (error instanceof PollError && error.notFound) {
      // The caller prefixes the target key; do not repeat it here.
      throw new Error(`it is not a pull request, or it does not exist or is not accessible.`)
    }
    throw error
  }
  const pr = JSON.parse(raw) as { state?: string; merged?: boolean; title?: unknown; head?: { sha?: unknown } }
  if (pr.merged === true || pr.state !== "open") {
    throw new Error(`the PR is already ${pr.merged === true ? "MERGED" : "CLOSED"}.`)
  }
  return {
    title: typeof pr.title === "string" ? pr.title : undefined,
    headSha: typeof pr.head?.sha === "string" ? pr.head.sha : undefined,
  }
}

/**
 * Adds `label` to the PR, creating the label in the repo first (green, with a
 * description) if it does not exist yet. Idempotent: adding an already-present
 * label succeeds and keeps the repo's existing label definition. Returns a
 * factual result line; throws when the target is not an open PR or the add
 * fails.
 */
export async function markReadyForHumanReview(runGh: GhRunner, target: Target, label: string): Promise<string> {
  const repo = `repos/${target.owner}/${target.repo}`
  await getOpenPullRequest({ runGh, target })
  try {
    await runGh([
      "api",
      `${repo}/labels`,
      "-f",
      `name=${label}`,
      "-f",
      `color=${READY_LABEL_COLOR}`,
      "-f",
      `description=${READY_LABEL_DESCRIPTION}`,
    ])
  } catch {
    // Almost always 422 already_exists — keep the repo's version of the label.
    // Real problems (auth, missing repo) surface on the add call below.
  }
  await runGh(["api", `${repo}/issues/${target.number}/labels`, "-f", `labels[]=${label}`])
  return `Marked ${targetKey(target)} as ready for human review: label "${label}" added.`
}

/**
 * Removes `label` from the PR — the withdraw side of the handoff, used when a
 * human leaves new feedback on a PR that was already marked ready, so the PR
 * stops advertising itself as awaiting review while the agent works on it.
 * Idempotent: a PR that does not carry the label is reported as such rather
 * than failing (the endpoint 404s in that case, and so does a missing label).
 */
export async function removeReadyForHumanReview(runGh: GhRunner, target: Target, label: string): Promise<string> {
  const repo = `repos/${target.owner}/${target.repo}`
  await getOpenPullRequest({ runGh, target })
  try {
    await runGh(["api", "--method", "DELETE", `${repo}/issues/${target.number}/labels/${encodeURIComponent(label)}`])
  } catch (error) {
    // 404 here means the PR does not carry the label (or the label does not
    // exist in the repo at all) — the requested end state either way.
    if (error instanceof PollError && error.notFound) {
      return `${targetKey(target)} did not carry the "${label}" label; nothing to remove.`
    }
    throw error
  }
  return `Removed the "${label}" label from ${targetKey(target)}: it is no longer flagged for human review.`
}
