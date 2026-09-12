// Explicit opt-in squash merge. Callers decide which readiness
// transitions are trusted triggers; this module performs one head-fenced
// merge attempt, reconciles indeterminate responses, and marks success.

import type { GhRunner } from "./github"
import { getOpenPullRequest } from "./label"
import { targetKey, type Target } from "./target"

export const AUTO_MERGED_LABEL = "automatically-merged"

const AUTO_MERGED_LABEL_COLOR = "1d76db"
const AUTO_MERGED_LABEL_DESCRIPTION = "Merged automatically by Sesori PR Monitor"

export type AutoMergePullRequest = {
  title: string
  headSha: string
}

export class AutoMergeHeadChangedError extends Error {
  readonly expectedHeadSha: string
  readonly actualHeadSha: string

  constructor({ expectedHeadSha, actualHeadSha }: { expectedHeadSha: string; actualHeadSha: string }) {
    super(`the PR head changed from ${expectedHeadSha} to ${actualHeadSha} before GitHub confirmed the merge`)
    this.name = "AutoMergeHeadChangedError"
    this.expectedHeadSha = expectedHeadSha
    this.actualHeadSha = actualHeadSha
  }
}

export class AutoMergeOutcomeUnknownError extends Error {
  constructor({ message }: { message: string }) {
    super(message)
    this.name = "AutoMergeOutcomeUnknownError"
  }
}

type PullRequestMergeState = {
  state: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN"
  headSha: string | undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function autoMergeFailureText({ error }: { error: unknown }): string {
  if (error instanceof AutoMergeOutcomeUnknownError) {
    return (
      "Auto-merge outcome is unknown after the ready label was added; the ready label remains and no automatic " +
      `retry will occur: ${error.message}`
    )
  }
  if (error instanceof AutoMergeHeadChangedError) {
    return (
      "Auto-merge was canceled because the accepted head changed; the monitor will reassess readiness on its next " +
      `poll: ${error.message}`
    )
  }
  return (
    "Auto-merge failed after the ready label was added; the ready label remains and no automatic retry will occur: " +
    errorMessage(error)
  )
}

export async function getAutoMergePullRequest({
  runGh,
  target,
}: {
  runGh: GhRunner
  target: Target
}): Promise<AutoMergePullRequest> {
  const pullRequest = await getOpenPullRequest({ runGh, target })
  if (
    pullRequest.title === undefined ||
    pullRequest.title.length === 0 ||
    pullRequest.headSha === undefined ||
    pullRequest.headSha.length === 0
  ) {
    throw new Error("GitHub's pull-request response did not include the title and head SHA required for auto-merge.")
  }
  return { title: pullRequest.title, headSha: pullRequest.headSha }
}

async function getPullRequestMergeState({
  runGh,
  target,
}: {
  runGh: GhRunner
  target: Target
}): Promise<PullRequestMergeState> {
  const repo = `repos/${target.owner}/${target.repo}`
  const raw = await runGh(["api", `${repo}/pulls/${target.number}`])
  const pullRequest = JSON.parse(raw) as { state?: unknown; merged?: unknown; head?: { sha?: unknown } }
  const merged = pullRequest.merged === true
  const state = merged
    ? "MERGED"
    : pullRequest.state === "open"
      ? "OPEN"
      : pullRequest.state === "closed"
        ? "CLOSED"
        : "UNKNOWN"
  return {
    state,
    headSha: typeof pullRequest.head?.sha === "string" ? pullRequest.head.sha : undefined,
  }
}

async function addAutoMergedLabel({ runGh, target }: { runGh: GhRunner; target: Target }): Promise<void> {
  const repo = `repos/${target.owner}/${target.repo}`
  try {
    await runGh([
      "api",
      `${repo}/labels`,
      "-f",
      `name=${AUTO_MERGED_LABEL}`,
      "-f",
      `color=${AUTO_MERGED_LABEL_COLOR}`,
      "-f",
      `description=${AUTO_MERGED_LABEL_DESCRIPTION}`,
    ])
  } catch {
    // Usually 422 already_exists. The add call below distinguishes an existing
    // label from an actual permission or repository failure.
  }
  await runGh(["api", `${repo}/issues/${target.number}/labels`, "-f", `labels[]=${AUTO_MERGED_LABEL}`])
}

async function successfulMergeText({
  runGh,
  target,
  pullRequest,
}: {
  runGh: GhRunner
  target: Target
  pullRequest: AutoMergePullRequest
}): Promise<string> {
  const merged =
    `Auto-merge succeeded: squash-merged ${targetKey(target)} at ${pullRequest.headSha} ` +
    "using only the PR title."
  try {
    await addAutoMergedLabel({ runGh, target })
    return `${merged} Label "${AUTO_MERGED_LABEL}" added.`
  } catch (error) {
    return `${merged} Warning: could not add label "${AUTO_MERGED_LABEL}": ${errorMessage(error)}`
  }
}

async function reconcileIndeterminateMerge({
  runGh,
  target,
  pullRequest,
  cause,
}: {
  runGh: GhRunner
  target: Target
  pullRequest: AutoMergePullRequest
  cause: unknown
}): Promise<string> {
  let observed: PullRequestMergeState
  try {
    observed = await getPullRequestMergeState({ runGh, target })
  } catch (reconciliationError) {
    throw new AutoMergeOutcomeUnknownError({
      message:
        `the merge request did not return a usable result (${errorMessage(cause)}), and the follow-up PR query ` +
        `failed (${errorMessage(reconciliationError)})`,
    })
  }

  if (observed.state === "MERGED" && observed.headSha === pullRequest.headSha) {
    return await successfulMergeText({ runGh, target, pullRequest })
  }
  if (observed.state === "OPEN" && observed.headSha !== undefined && observed.headSha !== pullRequest.headSha) {
    throw new AutoMergeHeadChangedError({
      expectedHeadSha: pullRequest.headSha,
      actualHeadSha: observed.headSha,
    })
  }
  const observedHead = observed.headSha === undefined ? "unknown head" : `head ${observed.headSha}`
  throw new AutoMergeOutcomeUnknownError({
    message:
      `the merge request did not return a usable result (${errorMessage(cause)}); the follow-up PR query observed ` +
      `${observed.state} at ${observedHead}, so the accepted head could not be confirmed as merged`,
  })
}

export async function squashMergePullRequest({
  runGh,
  target,
  pullRequest,
}: {
  runGh: GhRunner
  target: Target
  pullRequest: AutoMergePullRequest
}): Promise<string> {
  if (pullRequest.title.length === 0 || pullRequest.headSha.length === 0) {
    throw new Error("Auto-merge requires a non-empty PR title and head SHA.")
  }
  const repo = `repos/${target.owner}/${target.repo}`
  let raw: string
  try {
    raw = await runGh([
      "api",
      "--method",
      "PUT",
      `${repo}/pulls/${target.number}/merge`,
      "-f",
      "merge_method=squash",
      "-f",
      `sha=${pullRequest.headSha}`,
      "-f",
      `commit_title=${pullRequest.title}`,
      "-f",
      "commit_message=",
    ])
  } catch (error) {
    return await reconcileIndeterminateMerge({ runGh, target, pullRequest, cause: error })
  }

  let result: { merged?: unknown; message?: unknown }
  try {
    result = JSON.parse(raw) as { merged?: unknown; message?: unknown }
  } catch (error) {
    return await reconcileIndeterminateMerge({ runGh, target, pullRequest, cause: error })
  }
  if (result.merged !== true) {
    const detail = typeof result.message === "string" && result.message.length > 0
      ? result.message
      : "GitHub did not confirm the merge."
    throw new Error(detail)
  }

  return await successfulMergeText({ runGh, target, pullRequest })
}
