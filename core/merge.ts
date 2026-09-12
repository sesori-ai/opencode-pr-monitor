// Explicit opt-in squash merge. Callers decide which readiness
// transitions are trusted triggers; this module only performs one head-fenced
// merge attempt and marks a successful result.

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function autoMergeFailureText({ error }: { error: unknown }): string {
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
  const raw = await runGh([
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

  let result: { merged?: unknown; message?: unknown }
  try {
    result = JSON.parse(raw) as { merged?: unknown; message?: unknown }
  } catch {
    throw new Error("GitHub returned an invalid response to the squash-merge request.")
  }
  if (result.merged !== true) {
    const detail = typeof result.message === "string" && result.message.length > 0
      ? result.message
      : "GitHub did not confirm the merge."
    throw new Error(detail)
  }

  const merged = `Auto-merge succeeded: squash-merged ${targetKey(target)} at ${pullRequest.headSha} using only the PR title.`
  try {
    await addAutoMergedLabel({ runGh, target })
    return `${merged} Label "${AUTO_MERGED_LABEL}" added.`
  } catch (error) {
    return `${merged} Warning: could not add label "${AUTO_MERGED_LABEL}": ${errorMessage(error)}`
  }
}
