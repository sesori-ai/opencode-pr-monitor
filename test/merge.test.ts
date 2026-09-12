import assert from "node:assert/strict"
import test from "node:test"

import type { GhRunner } from "../core/github"
import {
  AUTO_MERGED_LABEL,
  getAutoMergePullRequest,
  squashMergePullRequest,
} from "../core/merge"
import type { Target } from "../core/target"

const target: Target = { owner: "sesori", repo: "example", number: 42 }
const pullRequest = { title: "Feature title", headSha: "0123456789abcdef" }

test("auto-merge fences the accepted head and creates a title-only squash commit", async () => {
  const calls: string[][] = []
  const runGh: GhRunner = async (args) => {
    calls.push(args)
    if (args.some((arg) => arg.endsWith("/merge"))) {
      return JSON.stringify({ merged: true, message: "Pull Request successfully merged" })
    }
    return ""
  }

  const result = await squashMergePullRequest({ runGh, target, pullRequest })

  assert.match(result, /Auto-merge succeeded/)
  assert.match(result, new RegExp(AUTO_MERGED_LABEL))
  assert.deepEqual(calls[0], [
    "api",
    "--method",
    "PUT",
    "repos/sesori/example/pulls/42/merge",
    "-f",
    "merge_method=squash",
    "-f",
    "sha=0123456789abcdef",
    "-f",
    "commit_title=Feature title",
    "-f",
    "commit_message=",
  ])
  assert.equal(calls[1]?.includes(`name=${AUTO_MERGED_LABEL}`), true)
  assert.deepEqual(calls[2], [
    "api",
    "repos/sesori/example/issues/42/labels",
    "-f",
    `labels[]=${AUTO_MERGED_LABEL}`,
  ])
})

test("auto-merge failure leaves marker label untouched and surfaces GitHub's reason", async () => {
  const calls: string[][] = []
  const runGh: GhRunner = async (args) => {
    calls.push(args)
    return JSON.stringify({ merged: false, message: "Required review is missing" })
  }

  await assert.rejects(
    squashMergePullRequest({ runGh, target, pullRequest }),
    /Required review is missing/,
  )
  assert.equal(calls.length, 1)
})

test("successful merge remains success when the marker label cannot be applied", async () => {
  const runGh: GhRunner = async (args) => {
    if (args.some((arg) => arg.endsWith("/merge"))) return JSON.stringify({ merged: true })
    if (args.some((arg) => arg.includes("/issues/"))) throw new Error("label permission denied")
    throw new Error("label already exists")
  }

  const result = await squashMergePullRequest({ runGh, target, pullRequest })
  assert.match(result, /Auto-merge succeeded/)
  assert.match(result, /Warning: could not add label/)
  assert.match(result, /label permission denied/)
})

test("auto-merge fails closed before GitHub when title or head SHA is empty", async () => {
  let calls = 0
  const runGh: GhRunner = async () => {
    calls += 1
    return ""
  }

  await assert.rejects(
    squashMergePullRequest({ runGh, target, pullRequest: { title: "", headSha: "head" } }),
    /non-empty PR title and head SHA/,
  )
  await assert.rejects(
    squashMergePullRequest({ runGh, target, pullRequest: { title: "title", headSha: "" } }),
    /non-empty PR title and head SHA/,
  )
  assert.equal(calls, 0)
})

test("standalone auto-merge captures title and head SHA from the open PR", async () => {
  const runGh: GhRunner = async () => JSON.stringify({
    state: "open",
    merged: false,
    title: "Current PR title",
    head: { sha: "current-head" },
  })

  assert.deepEqual(await getAutoMergePullRequest({ runGh, target }), {
    title: "Current PR title",
    headSha: "current-head",
  })
})
