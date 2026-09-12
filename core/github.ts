// GitHub data layer: one GraphQL query per poll via `gh api graphql`, plus
// additional pages only when bounded GitHub connections overflow (checks,
// latest reviews, review threads, or labels), normalized into a PrSnapshot. A
// comment from the authenticated gh user counts as an agent acknowledgement
// only when it starts with the configured reply prefix.

import type { Target } from "./target"

export type CommentMeta = {
  id: string
  author: string
  isBot: boolean
  createdAt: string
  isLocal: boolean
  isAgentReply: boolean
  reviewState?: string
}

export type ReviewThreadInfo = {
  id: string
  isResolved: boolean
  path?: string
  line?: number
  comments: CommentMeta[] // includes agent acknowledgements for last-reply readiness
}

export type CheckInfo = { id?: string; name: string; outcome: "pending" | "success" | "failure" }

export type ReviewInfo = { login: string; state: string; submittedAt: string }

export type PrSnapshot = {
  title: string
  url: string
  state: "OPEN" | "MERGED" | "CLOSED"
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  headSha: string
  checks: CheckInfo[] // empty = PR has no CI checks
  reviews: ReviewInfo[] // latest review per reviewer (submitted only)
  reviewSummaries: CommentMeta[] // non-empty summaries plus comment-less changes-requested reviews
  pendingReviewers: string[] // requested, not yet reviewed
  reviewThreads: ReviewThreadInfo[]
  issueCommentsTotal: number // totalCount minus agent acknowledgements among fetched window
  issueComments: CommentMeta[] // includes agent acknowledgements (last 100 fetched)
  labels: string[] // label names currently on the PR
}

export class PollError extends Error {
  readonly notFound: boolean
  readonly httpStatus: number | undefined
  readonly exitCode: number | string | undefined

  constructor(
    message: string,
    opts?: { notFound?: boolean; httpStatus?: number; exitCode?: number | string },
  ) {
    super(message)
    this.notFound = opts?.notFound ?? false
    this.httpStatus = opts?.httpStatus
    this.exitCode = opts?.exitCode
  }
}

export function ghHttpStatus({ message }: { message: string }): number | undefined {
  const match = /\bHTTP\s+(\d{3})\b/i.exec(message)
  if (match === null) return undefined
  const status = Number(match[1])
  return Number.isInteger(status) ? status : undefined
}

export type GhRunner = (args: string[]) => Promise<string>

const PR_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title url state mergeable headRefOid
      commits(last: 1) { nodes { commit { statusCheckRollup {
        contexts(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on CheckRun { id name status conclusion }
            ... on StatusContext { context state createdAt }
          }
        }
      } } } }
      reviewRequests(first: 50) { nodes { requestedReviewer {
        __typename
        ... on User { login }
        ... on Team { slug }
        ... on Bot { login }
      } } }
      latestReviews(first: 50) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id author { login __typename } state submittedAt body
          comments(first: 1) { totalCount }
        }
      }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved path line originalLine
          comments(last: 100) {
            nodes { id author { login __typename } body createdAt pullRequestReview { state } }
          }
        }
      }
      comments(last: 100) { totalCount nodes { id author { login __typename } body createdAt } }
      labels(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { name }
      }
    }
  }
}`

const REVIEW_THREADS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved path line originalLine
          comments(last: 100) {
            nodes { id author { login __typename } body createdAt pullRequestReview { state } }
          }
        }
      }
    }
  }
}`

const CHECKS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $head: GitObjectID!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    object(oid: $head) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun { id name status conclusion }
              ... on StatusContext { context state createdAt }
            }
          }
        }
      }
    }
  }
}`

const REVIEWS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      latestReviews(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id author { login __typename } state submittedAt body
          comments(first: 1) { totalCount }
        }
      }
    }
  }
}`

const LABELS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      labels(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { name }
      }
    }
  }
}`

function parseGhPayload(stdout: string): any {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new PollError("gh returned non-JSON output")
  }
}

function assertCompleteGraphQlPayload(payload: any): void {
  const errors = Array.isArray(payload?.errors) ? payload.errors : []
  if (errors.length === 0) return
  const detail = errors
    .map((error: any) => (typeof error?.message === "string" ? error.message : "unknown GraphQL error"))
    .join("; ")
  // GraphQL can return no data for transient service/rate-limit failures, and a
  // nested field can report NOT_FOUND while the PR remains live. Error-bearing
  // payloads therefore stay retryable; only a clean null PR is terminal below.
  throw new PollError(`GitHub returned an incomplete GraphQL response: ${detail}`)
}

type Connection = { pageInfo?: { hasNextPage?: boolean; endCursor?: unknown }; nodes?: any[] }

async function paginateConnection({
  input,
  connection,
  query,
  select,
  name,
  variables = [],
  includeNumber = true,
  missingMeansNotFound = true,
}: {
  input: { runGh: GhRunner; target: Target }
  connection: Connection | undefined
  query: string
  select: (payload: any) => Connection | undefined
  name: string
  variables?: string[]
  includeNumber?: boolean
  missingMeansNotFound?: boolean
}): Promise<void> {
  if (connection === undefined) return
  connection.nodes ??= []
  const seenCursors = new Set<string>()
  while (connection.pageInfo?.hasNextPage) {
    const cursor = connection.pageInfo.endCursor
    if (typeof cursor !== "string" || seenCursors.has(cursor)) {
      throw new PollError(`GitHub returned an invalid ${name} pagination cursor`)
    }
    seenCursors.add(cursor)
    const page = parseGhPayload(
      await input.runGh([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${input.target.owner}`,
        "-F",
        `repo=${input.target.repo}`,
        ...(includeNumber ? ["-F", `number=${input.target.number}`] : []),
        ...variables.flatMap((variable) => ["-F", variable]),
        "-f",
        `cursor=${cursor}`,
      ]),
    )
    assertCompleteGraphQlPayload(page)
    const next = select(page)
    if (next === undefined) {
      throw new PollError(`GitHub data changed while fetching ${name}`, {
        notFound: missingMeansNotFound,
      })
    }
    connection.nodes.push(...(next.nodes ?? []))
    connection.pageInfo = next.pageInfo
  }
}

export async function fetchPrSnapshot(input: {
  runGh: GhRunner
  target: Target
  ignoreTag: string | undefined
  selfLogin: string | undefined
}): Promise<PrSnapshot> {
  const payload = parseGhPayload(await input.runGh([
    "api", "graphql",
    "-f", `query=${PR_QUERY}`,
    "-F", `owner=${input.target.owner}`,
    "-F", `repo=${input.target.repo}`,
    "-F", `number=${input.target.number}`,
  ]))
  const pr = payload?.data?.repository?.pullRequest
  assertCompleteGraphQlPayload(payload)
  if (!pr) return normalizeSnapshot(payload, { ignoreTag: input.ignoreTag, selfLogin: input.selfLogin })

  const pageInput = { runGh: input.runGh, target: input.target }
  await paginateConnection({
    input: pageInput,
    connection: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts,
    query: CHECKS_PAGE_QUERY,
    select: (page) => page?.data?.repository?.object?.statusCheckRollup?.contexts,
    name: "check-context",
    variables: [`head=${pr.headRefOid}`],
    includeNumber: false,
    missingMeansNotFound: false,
  })
  await paginateConnection({
    input: pageInput,
    connection: pr.latestReviews,
    query: REVIEWS_PAGE_QUERY,
    select: (page) => page?.data?.repository?.pullRequest?.latestReviews,
    name: "latest-review",
  })
  await paginateConnection({
    input: pageInput,
    connection: pr.reviewThreads,
    query: REVIEW_THREADS_PAGE_QUERY,
    select: (page) => page?.data?.repository?.pullRequest?.reviewThreads,
    name: "review-thread",
  })
  await paginateConnection({
    input: pageInput,
    connection: pr.labels,
    query: LABELS_PAGE_QUERY,
    select: (page) => page?.data?.repository?.pullRequest?.labels,
    name: "label",
  })
  return normalizeSnapshot(payload, { ignoreTag: input.ignoreTag, selfLogin: input.selfLogin })
}

type RawComment = {
  id: string
  author: { login: string; __typename: string } | null
  body: string
  createdAt: string
  pullRequestReview?: { state?: string } | null
}

type CommentClassifier = { replyPrefix: string | undefined; selfLogin: string | undefined }

function toMeta(raw: RawComment, classifier: CommentClassifier): CommentMeta {
  const author = raw.author?.login ?? "ghost"
  const isLocal =
    classifier.selfLogin !== undefined && author.toLowerCase() === classifier.selfLogin.toLowerCase()
  const reviewState = raw.pullRequestReview?.state
  return {
    id: raw.id,
    author,
    isBot: raw.author?.__typename === "Bot",
    createdAt: raw.createdAt,
    isLocal,
    isAgentReply:
      isLocal && classifier.replyPrefix !== undefined && raw.body.startsWith(classifier.replyPrefix),
    ...(typeof reviewState === "string" ? { reviewState } : {}),
  }
}

export function normalizeSnapshot(
  payload: unknown,
  opts: { ignoreTag: string | undefined; selfLogin: string | undefined },
): PrSnapshot {
  const rawPayload = payload as any
  const pr = rawPayload?.data?.repository?.pullRequest
  assertCompleteGraphQlPayload(rawPayload)
  if (!pr) throw new PollError("PR not found in GraphQL response", { notFound: true })

  const classifier: CommentClassifier = { replyPrefix: opts.ignoreTag, selfLogin: opts.selfLogin }

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
      checks.push({ id: ctx.id, name: ctx.name, outcome })
    } else if (ctx.__typename === "StatusContext") {
      const outcome =
        ctx.state === "SUCCESS"
          ? "success"
          : ["PENDING", "EXPECTED"].includes(ctx.state)
            ? "pending"
            : "failure"
      checks.push({
        id: `status:${ctx.context}:${ctx.createdAt ?? ""}`,
        name: ctx.context,
        outcome,
      })
    }
  }

  const rawReviews: any[] = (pr.latestReviews?.nodes ?? []).filter(
    (node: any) => node.author?.login && node.state !== "PENDING",
  )
  const reviews: ReviewInfo[] = rawReviews.map((node: any) => ({
    login: node.author.login,
    state: node.state,
    submittedAt: node.submittedAt ?? "",
  }))
  const reviewSummaries: CommentMeta[] = rawReviews
    .filter(
      (node: any) =>
        (typeof node.body === "string" && node.body.trim().length > 0) ||
        (node.state === "CHANGES_REQUESTED" && (node.comments?.totalCount ?? 0) === 0),
    )
    .map((node: any) =>
      toMeta(
        {
          id: node.id,
          author: node.author,
          body: typeof node.body === "string" ? node.body : "",
          createdAt: node.submittedAt ?? "",
        },
        classifier,
      ),
    )

  const pendingReviewers: string[] = (pr.reviewRequests?.nodes ?? [])
    .map((node: any) => node.requestedReviewer?.login ?? node.requestedReviewer?.slug)
    .filter((name: unknown): name is string => typeof name === "string")

  const threads = pr.reviewThreads?.nodes ?? []
  const reviewThreads: ReviewThreadInfo[] = threads.map((thread: any) => {
    const line = typeof thread.line === "number" ? thread.line : thread.originalLine
    return {
      id: thread.id,
      isResolved: thread.isResolved,
      ...(typeof thread.path === "string" ? { path: thread.path } : {}),
      ...(typeof line === "number" ? { line } : {}),
      comments: (thread.comments?.nodes ?? []).map((comment: RawComment) => toMeta(comment, classifier)),
    }
  })

  const issueNodes: RawComment[] = pr.comments?.nodes ?? []
  const issueComments = issueNodes.map((node) => toMeta(node, classifier))
  const acknowledgementCount = issueComments.filter((comment) => comment.isAgentReply).length

  return {
    title: pr.title,
    url: pr.url,
    state: pr.state,
    mergeable: pr.mergeable ?? "UNKNOWN",
    headSha: pr.headRefOid,
    checks,
    reviews,
    reviewSummaries,
    pendingReviewers,
    reviewThreads,
    issueCommentsTotal: Math.max(
      (pr.comments?.totalCount ?? issueNodes.length) - acknowledgementCount,
      0,
    ),
    issueComments,
    labels: (pr.labels?.nodes ?? [])
      .map((node: any) => node?.name)
      .filter((name: unknown): name is string => typeof name === "string"),
  }
}

export type CiPhase = "none" | "running" | "concluded"

export function ciPhase(snapshot: PrSnapshot): CiPhase {
  if (snapshot.checks.length === 0) return "none"
  return snapshot.checks.some((check) => check.outcome === "pending") ? "running" : "concluded"
}
