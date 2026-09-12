import assert from "node:assert/strict"
import test from "node:test"

import type { GhRunner } from "../core/github"
import {
  AUTO_MERGED_LABEL,
  AutoMergeHeadChangedError,
  AutoMergeOutcomeUnknownError,
  autoMergeFailureText,
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

test("an indeterminate merge response reconciles a merged accepted head as success", async () => {
  const calls: string[][] = []
  const runGh: GhRunner = async (args) => {
    calls.push(args)
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route.endsWith("/pulls/42/merge")) throw new Error("connection closed before the response")
    if (route.endsWith("/pulls/42")) {
      return JSON.stringify({ state: "closed", merged: true, head: { sha: pullRequest.headSha } })
    }
    if (route === "repos/sesori/example/labels") throw new Error("label already exists")
    if (route.endsWith("/issues/42/labels")) return ""
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }

  const result = await squashMergePullRequest({ runGh, target, pullRequest })

  assert.match(result, /Auto-merge succeeded/)
  assert.match(result, new RegExp(AUTO_MERGED_LABEL))
  assert.equal(calls.some((args) => args.some((arg) => arg.endsWith("/pulls/42"))), true)
})

test("an indeterminate merge response reports unknown when the accepted merge cannot be proven", async () => {
  const calls: string[][] = []
  const runGh: GhRunner = async (args) => {
    calls.push(args)
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route.endsWith("/pulls/42/merge")) return "not-json"
    if (route.endsWith("/pulls/42")) {
      return JSON.stringify({ state: "open", merged: false, head: { sha: pullRequest.headSha } })
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }

  await assert.rejects(
    squashMergePullRequest({ runGh, target, pullRequest }),
    (error: unknown) => {
      assert.ok(error instanceof AutoMergeOutcomeUnknownError)
      assert.match(autoMergeFailureText({ error }), /outcome is unknown/)
      assert.match(autoMergeFailureText({ error }), /no automatic retry/)
      return true
    },
  )
  assert.equal(calls.filter((args) => args.some((arg) => arg.endsWith("/pulls/42/merge"))).length, 1)
})

test("failed merge reconciliation still reports an unknown outcome", async () => {
  const runGh: GhRunner = async (args) => {
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route.endsWith("/pulls/42/merge")) throw new Error("connection closed before the response")
    if (route.endsWith("/pulls/42")) throw new Error("follow-up query unavailable")
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }

  await assert.rejects(
    squashMergePullRequest({ runGh, target, pullRequest }),
    (error: unknown) => {
      assert.ok(error instanceof AutoMergeOutcomeUnknownError)
      assert.match(error.message, /follow-up PR query failed/)
      assert.match(error.message, /follow-up query unavailable/)
      return true
    },
  )
})

test("indeterminate merge reconciliation identifies a changed head", async () => {
  const runGh: GhRunner = async (args) => {
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route.endsWith("/pulls/42/merge")) throw new Error("request outcome unavailable")
    if (route.endsWith("/pulls/42")) {
      return JSON.stringify({ state: "open", merged: false, head: { sha: "replacement-head" } })
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }

  await assert.rejects(
    squashMergePullRequest({ runGh, target, pullRequest }),
    (error: unknown) => {
      assert.ok(error instanceof AutoMergeHeadChangedError)
      assert.equal(error.expectedHeadSha, pullRequest.headSha)
      assert.equal(error.actualHeadSha, "replacement-head")
      return true
    },
  )
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
