// GitHub data layer: one GraphQL query per poll via `gh api graphql`,
// normalized into a PrSnapshot. Comments authored by the authenticated gh
// user containing the configured ignore tag are invisible to the plugin.

import type { PluginInput } from "@opencode-ai/plugin"
import type { Target } from "./target"

export type CommentMeta = { author: string; isBot: boolean; createdAt: string }

export type CheckInfo = { name: string; outcome: "pending" | "success" | "failure" }

export type ReviewInfo = { login: string; state: string; submittedAt: string }

export type PrSnapshot = {
  title: string
  url: string
  state: "OPEN" | "MERGED" | "CLOSED"
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  headSha: string
  checks: CheckInfo[] // empty = PR has no CI checks
  reviews: ReviewInfo[] // latest review per reviewer (submitted only)
  pendingReviewers: string[] // requested, not yet reviewed
  unresolvedThreads: number
  inlineComments: CommentMeta[] // ignore-filtered
  issueCommentsTotal: number // totalCount minus ignored among fetched window
  issueComments: CommentMeta[] // ignore-filtered (last 100 fetched)
}

export class PollError extends Error {
  readonly notFound: boolean
  constructor(message: string, opts?: { notFound?: boolean }) {
    super(message)
    this.notFound = opts?.notFound ?? false
  }
}

export type GhRunner = (args: string[]) => Promise<string>

export function createGhRunner($: PluginInput["$"]): GhRunner {
  return async (args) => {
    const result = await $`gh ${args}`.quiet().nothrow()
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim()
      const notFound = /could not resolve to|not found|404/i.test(stderr) && !/could not resolve host/i.test(stderr)
      throw new PollError(stderr || `gh exited with code ${result.exitCode}`, { notFound })
    }
    return result.stdout.toString()
  }
}

const PR_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title url state mergeable headRefOid
      commits(last: 1) { nodes { commit { statusCheckRollup {
        contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        } }
      } } } }
      reviewRequests(first: 50) { nodes { requestedReviewer {
        __typename
        ... on User { login }
        ... on Team { slug }
        ... on Bot { login }
      } } }
      latestReviews(first: 50) { nodes { author { login __typename } state submittedAt } }
      reviewThreads(first: 100) { nodes {
        isResolved
        comments(last: 100) { nodes { author { login __typename } body createdAt } }
      } }
      comments(last: 100) { totalCount nodes { author { login __typename } body createdAt } }
    }
  }
}`

export async function fetchPrSnapshot(input: {
  runGh: GhRunner
  target: Target
  ignoreTag: string | undefined
  selfLogin: string | undefined
}): Promise<PrSnapshot> {
  const stdout = await input.runGh([
    "api", "graphql",
    "-f", `query=${PR_QUERY}`,
    "-F", `owner=${input.target.owner}`,
    "-F", `repo=${input.target.repo}`,
    "-F", `number=${input.target.number}`,
  ])
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new PollError("gh returned non-JSON output")
  }
  return normalizeSnapshot(payload, { ignoreTag: input.ignoreTag, selfLogin: input.selfLogin })
}

type RawComment = { author: { login: string; __typename: string } | null; body: string; createdAt: string }

function toMeta(raw: RawComment): CommentMeta {
  return {
    author: raw.author?.login ?? "ghost",
    isBot: raw.author?.__typename === "Bot",
    createdAt: raw.createdAt,
  }
}

export function normalizeSnapshot(
  payload: unknown,
  opts: { ignoreTag: string | undefined; selfLogin: string | undefined },
): PrSnapshot {
  const pr = (payload as any)?.data?.repository?.pullRequest
  if (!pr) throw new PollError("PR not found in GraphQL response", { notFound: true })

  const ignored = (raw: RawComment): boolean =>
    opts.ignoreTag !== undefined &&
    opts.selfLogin !== undefined &&
    raw.author?.login === opts.selfLogin &&
    raw.body.includes(opts.ignoreTag)

  const checks: CheckInfo[] = []
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  for (const ctx of contexts) {
    if (ctx.__typename === "CheckRun") {
      const outcome =
        ctx.status !== "COMPLETED"
          ? "pending"
          : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(ctx.conclusion)
            ? "success"
            : "failure"
      checks.push({ name: ctx.name, outcome })
    } else if (ctx.__typename === "StatusContext") {
      const outcome = ctx.state === "SUCCESS" ? "success" : ["PENDING", "EXPECTED"].includes(ctx.state) ? "pending" : "failure"
      checks.push({ name: ctx.context, outcome })
    }
  }

  const reviews: ReviewInfo[] = (pr.latestReviews?.nodes ?? [])
    .filter((node: any) => node.author?.login && node.state !== "PENDING")
    .map((node: any) => ({ login: node.author.login, state: node.state, submittedAt: node.submittedAt ?? "" }))

  const pendingReviewers: string[] = (pr.reviewRequests?.nodes ?? [])
    .map((node: any) => node.requestedReviewer?.login ?? node.requestedReviewer?.slug)
    .filter((name: unknown): name is string => typeof name === "string")

  const threads = pr.reviewThreads?.nodes ?? []
  const inlineComments: CommentMeta[] = []
  for (const thread of threads) {
    for (const comment of thread.comments?.nodes ?? []) {
      if (!ignored(comment)) inlineComments.push(toMeta(comment))
    }
  }

  const issueNodes: RawComment[] = pr.comments?.nodes ?? []
  const issueVisible = issueNodes.filter((node) => !ignored(node))
  const ignoredCount = issueNodes.length - issueVisible.length

  return {
    title: pr.title,
    url: pr.url,
    state: pr.state,
    mergeable: pr.mergeable ?? "UNKNOWN",
    headSha: pr.headRefOid,
    checks,
    reviews,
    pendingReviewers,
    unresolvedThreads: threads.filter((thread: any) => !thread.isResolved).length,
    inlineComments,
    issueCommentsTotal: Math.max((pr.comments?.totalCount ?? issueNodes.length) - ignoredCount, 0),
    issueComments: issueVisible.map(toMeta),
  }
}

export type CiPhase = "none" | "running" | "concluded"

export function ciPhase(snapshot: PrSnapshot): CiPhase {
  if (snapshot.checks.length === 0) return "none"
  return snapshot.checks.some((check) => check.outcome === "pending") ? "running" : "concluded"
}
