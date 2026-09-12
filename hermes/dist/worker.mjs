// hermes/src/worker.ts
import { createInterface } from "node:readline";
import { isAbsolute as isAbsolute2, resolve } from "node:path";

// core/config.ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
var AUTO_MERGE_ENV = "SESORI_PR_MONITOR_AUTO_MERGE";
var DEFAULT_MONITOR_CONFIG = {
  debounceMinutes: 2,
  maxCiWaitMinutes: 30,
  pollIntervalSeconds: 60,
  ignoreCommentTag: "<!-- pr-monitor:reply -->",
  announceOnStart: true,
  flushOnCiFailure: true,
  readyLabel: "ready-for-human-review",
  autoMerge: false
};
var MIN_POLL_INTERVAL_SECONDS = 30;
var MAX_POLL_INTERVAL_SECONDS = 86400;
function globalMonitorConfigPath({
  environment = process.env,
  homeDirectory
} = {}) {
  const xdgConfigHome = environment["XDG_CONFIG_HOME"]?.trim();
  const environmentHome = environment["HOME"]?.trim() || environment["USERPROFILE"]?.trim();
  const home = homeDirectory ?? environmentHome ?? homedir();
  const configHome = xdgConfigHome !== void 0 && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(home, ".config");
  return join(configHome, "pr-monitor", "config.json");
}
function positiveNumber(record, key) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function environmentAutoMergeOverride(environment, log) {
  const raw = environment[AUTO_MERGE_ENV];
  if (raw === void 0) return void 0;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0" || value === "") return false;
  log(`${AUTO_MERGE_ENV} must be true, false, 1, or 0; auto-merge is disabled.`);
  return false;
}
function applyMonitorConfig(config, raw) {
  if (typeof raw !== "object" || raw === null) return;
  const record = raw;
  config.debounceMinutes = positiveNumber(record, "debounceMinutes") ?? config.debounceMinutes;
  config.maxCiWaitMinutes = positiveNumber(record, "maxCiWaitMinutes") ?? config.maxCiWaitMinutes;
  const poll = positiveNumber(record, "pollIntervalSeconds") ?? config.pollIntervalSeconds;
  config.pollIntervalSeconds = Math.min(Math.max(poll, MIN_POLL_INTERVAL_SECONDS), MAX_POLL_INTERVAL_SECONDS);
  const tag = record["ignoreCommentTag"];
  config.ignoreCommentTag = typeof tag === "string" && tag.length > 0 ? tag : config.ignoreCommentTag;
  const announce = record["announceOnStart"];
  if (typeof announce === "boolean") config.announceOnStart = announce;
  const flushOnCiFailure = record["flushOnCiFailure"];
  if (typeof flushOnCiFailure === "boolean") config.flushOnCiFailure = flushOnCiFailure;
  const label = record["readyLabel"];
  if (typeof label === "string" && label.length > 0) config.readyLabel = label;
  const autoMerge = record["autoMerge"];
  if (typeof autoMerge === "boolean") config.autoMerge = autoMerge;
}
function resolveMonitorConfig(layers, environment, log) {
  const config = { ...DEFAULT_MONITOR_CONFIG };
  for (const raw of layers) applyMonitorConfig(config, raw);
  config.autoMerge = environmentAutoMergeOverride(environment, log) ?? config.autoMerge;
  return config;
}
async function readFirstConfig({
  paths,
  log
}) {
  for (const path of paths) {
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    try {
      return { found: true, raw: JSON.parse(text) };
    } catch (error) {
      log(`config file ${path} is not valid JSON, ignoring it: ${error.message}`);
    }
  }
  return { found: false };
}
async function loadResolvedConfig({
  paths,
  globalPaths,
  log,
  environment = process.env,
  resolve: resolve2
}) {
  const global = await readFirstConfig({
    paths: globalPaths ?? [globalMonitorConfigPath({ environment })],
    log
  });
  const project = await readFirstConfig({ paths, log });
  const layers = [];
  if (global.found) layers.push(global.raw);
  if (project.found) layers.push(project.raw);
  return resolve2(layers, environment, log);
}
function loadMonitorConfig(input) {
  return loadResolvedConfig({ ...input, resolve: resolveMonitorConfig });
}

// core/github.ts
var PollError = class extends Error {
  notFound;
  httpStatus;
  exitCode;
  constructor(message, opts) {
    super(message);
    this.notFound = opts?.notFound ?? false;
    this.httpStatus = opts?.httpStatus;
    this.exitCode = opts?.exitCode;
  }
};
function ghHttpStatus({ message }) {
  const match = /\bHTTP\s+(\d{3})\b/i.exec(message);
  if (match === null) return void 0;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : void 0;
}
var PR_QUERY = `
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
}`;
var REVIEW_THREADS_PAGE_QUERY = `
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
}`;
var CHECKS_PAGE_QUERY = `
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
}`;
var REVIEWS_PAGE_QUERY = `
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
}`;
var LABELS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      labels(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { name }
      }
    }
  }
}`;
function parseGhPayload(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new PollError("gh returned non-JSON output");
  }
}
function assertCompleteGraphQlPayload(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  if (errors.length === 0) return;
  const detail = errors.map((error) => typeof error?.message === "string" ? error.message : "unknown GraphQL error").join("; ");
  throw new PollError(`GitHub returned an incomplete GraphQL response: ${detail}`);
}
async function paginateConnection({
  input,
  connection,
  query,
  select,
  name,
  variables = [],
  includeNumber = true,
  missingMeansNotFound = true
}) {
  if (connection === void 0) return;
  connection.nodes ??= [];
  const seenCursors = /* @__PURE__ */ new Set();
  while (connection.pageInfo?.hasNextPage) {
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== "string" || seenCursors.has(cursor)) {
      throw new PollError(`GitHub returned an invalid ${name} pagination cursor`);
    }
    seenCursors.add(cursor);
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
        ...includeNumber ? ["-F", `number=${input.target.number}`] : [],
        ...variables.flatMap((variable) => ["-F", variable]),
        "-f",
        `cursor=${cursor}`
      ])
    );
    assertCompleteGraphQlPayload(page);
    const next = select(page);
    if (next === void 0) {
      throw new PollError(`GitHub data changed while fetching ${name}`, {
        notFound: missingMeansNotFound
      });
    }
    connection.nodes.push(...next.nodes ?? []);
    connection.pageInfo = next.pageInfo;
  }
}
async function fetchPrSnapshot(input) {
  const payload = parseGhPayload(await input.runGh([
    "api",
    "graphql",
    "-f",
    `query=${PR_QUERY}`,
    "-F",
    `owner=${input.target.owner}`,
    "-F",
    `repo=${input.target.repo}`,
    "-F",
    `number=${input.target.number}`
  ]));
  const pr = payload?.data?.repository?.pullRequest;
  assertCompleteGraphQlPayload(payload);
  if (!pr) return normalizeSnapshot(payload, { ignoreTag: input.ignoreTag, selfLogin: input.selfLogin });
  const pageInput = { runGh: input.runGh, target: input.target };
  await paginateConnection({
    input: pageInput,
    connection: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts,
    query: CHECKS_PAGE_QUERY,
    select: (page) => page?.data?.repository?.object?.statusCheckRollup?.contexts,
    name: "check-context",
    variables: [`head=${pr.headRefOid}`],
    includeNumber: false,
    missingMeansNotFound: false
  });
  await paginateConnection({
    input: pageInput,
    connection: pr.latestReviews,
    query: REVIEWS_PAGE_QUERY,
    select: (page) => page?.data?.repository?.pullRequest?.latestReviews,
    name: "latest-review"
  });
  await paginateConnection({
    input: pageInput,
    connection: pr.reviewThreads,
    query: REVIEW_THREADS_PAGE_QUERY,
    select: (page) => page?.data?.repository?.pullRequest?.reviewThreads,
    name: "review-thread"
  });
  await paginateConnection({
    input: pageInput,
    connection: pr.labels,
    query: LABELS_PAGE_QUERY,
    select: (page) => page?.data?.repository?.pullRequest?.labels,
    name: "label"
  });
  return normalizeSnapshot(payload, { ignoreTag: input.ignoreTag, selfLogin: input.selfLogin });
}
function toMeta(raw, classifier) {
  const author = raw.author?.login ?? "ghost";
  const isLocal = classifier.selfLogin !== void 0 && author.toLowerCase() === classifier.selfLogin.toLowerCase();
  const reviewState = raw.pullRequestReview?.state;
  return {
    id: raw.id,
    author,
    isBot: raw.author?.__typename === "Bot",
    createdAt: raw.createdAt,
    isLocal,
    isAgentReply: isLocal && classifier.replyPrefix !== void 0 && raw.body.startsWith(classifier.replyPrefix),
    ...typeof reviewState === "string" ? { reviewState } : {}
  };
}
function normalizeSnapshot(payload, opts) {
  const rawPayload = payload;
  const pr = rawPayload?.data?.repository?.pullRequest;
  assertCompleteGraphQlPayload(rawPayload);
  if (!pr) throw new PollError("PR not found in GraphQL response", { notFound: true });
  const classifier = { replyPrefix: opts.ignoreTag, selfLogin: opts.selfLogin };
  const checks = [];
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  for (const ctx of contexts) {
    if (ctx.__typename === "CheckRun") {
      const outcome = ctx.status !== "COMPLETED" ? "pending" : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(ctx.conclusion) ? "success" : "failure";
      checks.push({ id: ctx.id, name: ctx.name, outcome });
    } else if (ctx.__typename === "StatusContext") {
      const outcome = ctx.state === "SUCCESS" ? "success" : ["PENDING", "EXPECTED"].includes(ctx.state) ? "pending" : "failure";
      checks.push({
        id: `status:${ctx.context}:${ctx.createdAt ?? ""}`,
        name: ctx.context,
        outcome
      });
    }
  }
  const rawReviews = (pr.latestReviews?.nodes ?? []).filter(
    (node) => node.author?.login && node.state !== "PENDING"
  );
  const reviews = rawReviews.map((node) => ({
    login: node.author.login,
    state: node.state,
    submittedAt: node.submittedAt ?? ""
  }));
  const reviewSummaries = rawReviews.filter(
    (node) => typeof node.body === "string" && node.body.trim().length > 0 || node.state === "CHANGES_REQUESTED" && (node.comments?.totalCount ?? 0) === 0
  ).map(
    (node) => toMeta(
      {
        id: node.id,
        author: node.author,
        body: typeof node.body === "string" ? node.body : "",
        createdAt: node.submittedAt ?? ""
      },
      classifier
    )
  );
  const pendingReviewers = (pr.reviewRequests?.nodes ?? []).map((node) => node.requestedReviewer?.login ?? node.requestedReviewer?.slug).filter((name) => typeof name === "string");
  const threads = pr.reviewThreads?.nodes ?? [];
  const reviewThreads = threads.map((thread) => {
    const line = typeof thread.line === "number" ? thread.line : thread.originalLine;
    return {
      id: thread.id,
      isResolved: thread.isResolved,
      ...typeof thread.path === "string" ? { path: thread.path } : {},
      ...typeof line === "number" ? { line } : {},
      comments: (thread.comments?.nodes ?? []).map((comment) => toMeta(comment, classifier))
    };
  });
  const issueNodes = pr.comments?.nodes ?? [];
  const issueComments = issueNodes.map((node) => toMeta(node, classifier));
  const acknowledgementCount = issueComments.filter((comment) => comment.isAgentReply).length;
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
      0
    ),
    issueComments,
    labels: (pr.labels?.nodes ?? []).map((node) => node?.name).filter((name) => typeof name === "string")
  };
}
function ciPhase(snapshot) {
  if (snapshot.checks.length === 0) return "none";
  return snapshot.checks.some((check) => check.outcome === "pending") ? "running" : "concluded";
}

// core/target.ts
var SHORT_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)#(\d+)$/;
var URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/;
function parseTarget(input) {
  const trimmed = input.trim();
  const match = SHORT_RE.exec(trimmed) ?? URL_RE.exec(trimmed);
  if (!match) {
    return {
      error: `Invalid PR identifier: "${input}". Use "owner/repo#123" or a full PR URL (https://github.com/owner/repo/pull/123). The repo must always be explicit.`
    };
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}
function targetKey(target) {
  return `${target.owner}/${target.repo}#${target.number}`;
}
function targetRegistryKey(target) {
  return `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}#${target.number}`;
}
function targetUrl(target) {
  return `https://github.com/${target.owner}/${target.repo}/pull/${target.number}`;
}

// core/label.ts
var READY_LABEL_COLOR = "0e8a16";
var READY_LABEL_DESCRIPTION = "This PR is ready for human review";
async function getOpenPullRequest({
  runGh,
  target
}) {
  const repo = `repos/${target.owner}/${target.repo}`;
  let raw;
  try {
    raw = await runGh(["api", `${repo}/pulls/${target.number}`]);
  } catch (error) {
    if (error instanceof PollError && error.notFound) {
      throw new Error(`it is not a pull request, or it does not exist or is not accessible.`);
    }
    throw error;
  }
  const pr = JSON.parse(raw);
  if (pr.merged === true || pr.state !== "open") {
    throw new Error(`the PR is already ${pr.merged === true ? "MERGED" : "CLOSED"}.`);
  }
  return {
    title: typeof pr.title === "string" ? pr.title : void 0,
    headSha: typeof pr.head?.sha === "string" ? pr.head.sha : void 0
  };
}
async function markReadyForHumanReview(runGh, target, label) {
  const repo = `repos/${target.owner}/${target.repo}`;
  await getOpenPullRequest({ runGh, target });
  try {
    await runGh([
      "api",
      `${repo}/labels`,
      "-f",
      `name=${label}`,
      "-f",
      `color=${READY_LABEL_COLOR}`,
      "-f",
      `description=${READY_LABEL_DESCRIPTION}`
    ]);
  } catch {
  }
  await runGh(["api", `${repo}/issues/${target.number}/labels`, "-f", `labels[]=${label}`]);
  return `Marked ${targetKey(target)} as ready for human review: label "${label}" added.`;
}
async function removeReadyForHumanReview(runGh, target, label) {
  const repo = `repos/${target.owner}/${target.repo}`;
  await getOpenPullRequest({ runGh, target });
  try {
    await runGh(["api", "--method", "DELETE", `${repo}/issues/${target.number}/labels/${encodeURIComponent(label)}`]);
  } catch (error) {
    if (error instanceof PollError && error.notFound) {
      return `${targetKey(target)} did not carry the "${label}" label; nothing to remove.`;
    }
    throw error;
  }
  return `Removed the "${label}" label from ${targetKey(target)}: it is no longer flagged for human review.`;
}

// core/merge.ts
var AUTO_MERGED_LABEL = "automatically-merged";
var AUTO_MERGED_LABEL_COLOR = "1d76db";
var AUTO_MERGED_LABEL_DESCRIPTION = "Merged automatically by Sesori PR Monitor";
var AutoMergeHeadChangedError = class extends Error {
  expectedHeadSha;
  actualHeadSha;
  constructor({ expectedHeadSha, actualHeadSha }) {
    super(
      actualHeadSha === void 0 ? `GitHub rejected the accepted head ${expectedHeadSha} with HTTP 409 before confirming the merge` : `the PR head changed from ${expectedHeadSha} to ${actualHeadSha} before GitHub confirmed the merge`
    );
    this.name = "AutoMergeHeadChangedError";
    this.expectedHeadSha = expectedHeadSha;
    this.actualHeadSha = actualHeadSha;
  }
};
var AutoMergeOutcomeUnknownError = class extends Error {
  constructor({ message }) {
    super(message);
    this.name = "AutoMergeOutcomeUnknownError";
  }
};
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isDefinitiveHttpRejection(error) {
  if (!(error instanceof PollError) || error.httpStatus === void 0) return false;
  return error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408;
}
function autoMergeFailureText({ error }) {
  if (error instanceof AutoMergeOutcomeUnknownError) {
    return `Auto-merge outcome is unknown after the ready label was added; the ready label remains and no automatic retry will occur: ${error.message}`;
  }
  if (error instanceof AutoMergeHeadChangedError) {
    return `Auto-merge was canceled because the accepted head changed; the monitor will reassess readiness on its next poll: ${error.message}`;
  }
  return "Auto-merge failed after the ready label was added; the ready label remains and no automatic retry will occur: " + errorMessage(error);
}
async function getAutoMergePullRequest({
  runGh,
  target
}) {
  const pullRequest = await getOpenPullRequest({ runGh, target });
  if (pullRequest.title === void 0 || pullRequest.title.length === 0 || pullRequest.headSha === void 0 || pullRequest.headSha.length === 0) {
    throw new Error("GitHub's pull-request response did not include the title and head SHA required for auto-merge.");
  }
  return { title: pullRequest.title, headSha: pullRequest.headSha };
}
async function getPullRequestMergeState({
  runGh,
  target
}) {
  const repo = `repos/${target.owner}/${target.repo}`;
  const raw = await runGh(["api", `${repo}/pulls/${target.number}`]);
  const pullRequest = JSON.parse(raw);
  const merged = pullRequest.merged === true;
  const state = merged ? "MERGED" : pullRequest.state === "open" ? "OPEN" : pullRequest.state === "closed" ? "CLOSED" : "UNKNOWN";
  return {
    state,
    headSha: typeof pullRequest.head?.sha === "string" ? pullRequest.head.sha : void 0
  };
}
async function addAutoMergedLabel({ runGh, target }) {
  const repo = `repos/${target.owner}/${target.repo}`;
  try {
    await runGh([
      "api",
      `${repo}/labels`,
      "-f",
      `name=${AUTO_MERGED_LABEL}`,
      "-f",
      `color=${AUTO_MERGED_LABEL_COLOR}`,
      "-f",
      `description=${AUTO_MERGED_LABEL_DESCRIPTION}`
    ]);
  } catch {
  }
  await runGh(["api", `${repo}/issues/${target.number}/labels`, "-f", `labels[]=${AUTO_MERGED_LABEL}`]);
}
async function successfulMergeText({
  runGh,
  target,
  pullRequest
}) {
  const merged = `Auto-merge succeeded: squash-merged ${targetKey(target)} at ${pullRequest.headSha} using only the PR title.`;
  try {
    await addAutoMergedLabel({ runGh, target });
    return `${merged} Label "${AUTO_MERGED_LABEL}" added.`;
  } catch (error) {
    return `${merged} Warning: could not add label "${AUTO_MERGED_LABEL}": ${errorMessage(error)}`;
  }
}
async function reconcileIndeterminateMerge({
  runGh,
  target,
  pullRequest,
  cause
}) {
  let observed;
  try {
    observed = await getPullRequestMergeState({ runGh, target });
  } catch (reconciliationError) {
    throw new AutoMergeOutcomeUnknownError({
      message: `the merge request did not return a usable result (${errorMessage(cause)}), and the follow-up PR query failed (${errorMessage(reconciliationError)})`
    });
  }
  if (observed.state === "MERGED" && observed.headSha === pullRequest.headSha) {
    return await successfulMergeText({ runGh, target, pullRequest });
  }
  if (observed.state === "OPEN" && observed.headSha !== void 0 && observed.headSha !== pullRequest.headSha) {
    throw new AutoMergeHeadChangedError({
      expectedHeadSha: pullRequest.headSha,
      actualHeadSha: observed.headSha
    });
  }
  const observedHead = observed.headSha === void 0 ? "unknown head" : `head ${observed.headSha}`;
  throw new AutoMergeOutcomeUnknownError({
    message: `the merge request did not return a usable result (${errorMessage(cause)}); the follow-up PR query observed ${observed.state} at ${observedHead}, so the accepted head could not be confirmed as merged`
  });
}
async function squashMergePullRequest({
  runGh,
  target,
  pullRequest
}) {
  if (pullRequest.title.length === 0 || pullRequest.headSha.length === 0) {
    throw new Error("Auto-merge requires a non-empty PR title and head SHA.");
  }
  const repo = `repos/${target.owner}/${target.repo}`;
  let raw;
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
      "commit_message="
    ]);
  } catch (error) {
    if (isDefinitiveHttpRejection(error)) {
      if (error.httpStatus === 409) {
        throw new AutoMergeHeadChangedError({ expectedHeadSha: pullRequest.headSha });
      }
      throw error;
    }
    return await reconcileIndeterminateMerge({ runGh, target, pullRequest, cause: error });
  }
  let result;
  try {
    result = JSON.parse(raw);
  } catch (error) {
    return await reconcileIndeterminateMerge({ runGh, target, pullRequest, cause: error });
  }
  if (result.merged !== true) {
    const detail = typeof result.message === "string" && result.message.length > 0 ? result.message : "GitHub did not confirm the merge.";
    throw new Error(detail);
  }
  return await successfulMergeText({ runGh, target, pullRequest });
}

// core/activity.ts
function reviewSig(snapshot) {
  const states = snapshot.reviews.map((review) => `${review.login}=${review.state}@${review.submittedAt}`).sort();
  const pending = [...snapshot.pendingReviewers].sort();
  return `${states.join(",")}|${pending.join(",")}`;
}
function relevantComments(comments) {
  return comments.filter((comment) => !comment.isAgentReply);
}
function hasAddedRelevantComment(prev, next) {
  const before = new Set(prev.map((comment) => comment.id));
  return next.some((comment) => !comment.isAgentReply && !before.has(comment.id));
}
function reviewThreadsReceivedNewComments(prev, next) {
  const before = new Map(prev.map((thread) => [thread.id, thread]));
  return next.some((thread) => {
    const previous = before.get(thread.id);
    return hasAddedRelevantComment(previous?.comments ?? [], thread.comments);
  });
}
function reviewThreadsChanged(prev, next) {
  const before = new Map(prev.map((thread) => [thread.id, thread]));
  const after = new Set(next.map((thread) => thread.id));
  if (prev.some((thread) => !after.has(thread.id))) return true;
  return next.some((thread) => {
    const previous = before.get(thread.id);
    if (!previous) return relevantComments(thread.comments).length > 0 || !thread.isResolved;
    return previous.isResolved !== thread.isResolved || hasAddedRelevantComment(previous.comments, thread.comments);
  });
}
function checkKey(check) {
  return check.id ?? check.name;
}
function ciConcludedSig(snapshot) {
  const failed = snapshot.checks.filter((check) => check.outcome === "failure").map(checkKey).sort();
  return `${snapshot.headSha}:${failed.join(",")}`;
}
function mergeableChanged(lastDefinite, next) {
  if (next.mergeable === "UNKNOWN") return false;
  if (lastDefinite === void 0) return false;
  return lastDefinite !== next.mergeable;
}
function hasNewMergeConflict(lastDefinite, next) {
  return next.state === "OPEN" && next.mergeable === "CONFLICTING" && lastDefinite !== "CONFLICTING";
}
function hasNewCiFailure(prev, next) {
  const failing = next.checks.filter((check) => check.outcome === "failure");
  if (failing.length === 0) return false;
  if (prev.headSha !== next.headSha) return true;
  const before = new Set(prev.checks.filter((check) => check.outcome === "failure").map(checkKey));
  return failing.some((check) => !before.has(checkKey(check)));
}
function detectActivity(prev, next, lastDefiniteMergeable) {
  if (prev.state !== next.state) return true;
  if (prev.headSha !== next.headSha) return true;
  if (mergeableChanged(lastDefiniteMergeable, next)) return true;
  if (reviewSig(prev) !== reviewSig(next)) return true;
  if (reviewThreadsChanged(prev.reviewThreads, next.reviewThreads)) return true;
  if (prev.issueCommentsTotal !== next.issueCommentsTotal || hasAddedRelevantComment(prev.issueComments, next.issueComments) || hasAddedRelevantComment(prev.reviewSummaries, next.reviewSummaries)) {
    return true;
  }
  if (ciPhase(next) === "concluded" && (ciPhase(prev) !== "concluded" || ciConcludedSig(prev) !== ciConcludedSig(next))) {
    return true;
  }
  return false;
}

// core/readiness.ts
function latestComments(comments) {
  let latestAt = Number.NEGATIVE_INFINITY;
  let latest = [];
  for (const comment of comments) {
    const createdAt = Date.parse(comment.createdAt);
    if (Number.isNaN(createdAt)) return comments;
    if (createdAt > latestAt) {
      latestAt = createdAt;
      latest = [comment];
    } else if (createdAt === latestAt) {
      latest.push(comment);
    }
  }
  return latest;
}
function channelIsAcknowledged(comments) {
  return comments.length > 0 && latestComments(comments).every((comment) => comment.isAgentReply);
}
function feedbackChannels(snapshot) {
  const channels = /* @__PURE__ */ new Map();
  channels.set("unthreaded", [...snapshot.issueComments, ...snapshot.reviewSummaries]);
  for (const thread of snapshot.reviewThreads) channels.set(`thread:${thread.id}`, thread.comments);
  return channels;
}
function hasAcknowledgementRegression(prev, next) {
  const before = feedbackChannels(prev);
  return [...feedbackChannels(next)].some(([channel, comments]) => {
    const previous = before.get(channel);
    if (channel === "unthreaded") {
      return comments.length > 0 && channelIsAcknowledged(previous ?? []) && !channelIsAcknowledged(comments);
    }
    return !channelIsAcknowledged(comments) && (previous === void 0 || channelIsAcknowledged(previous));
  });
}
function ciIsReady(snapshot) {
  const phase = ciPhase(snapshot);
  return phase === "none" || phase === "concluded" && snapshot.checks.every((check) => check.outcome === "success");
}
function assessAutomaticReadiness(snapshot) {
  const blockers = [];
  if (snapshot.state !== "OPEN") blockers.push(`PR is ${snapshot.state.toLowerCase()}`);
  if (!ciIsReady(snapshot)) {
    blockers.push(ciPhase(snapshot) === "running" ? "CI is running" : "CI is failing");
  }
  if (snapshot.mergeable !== "MERGEABLE") {
    blockers.push(
      snapshot.mergeable === "CONFLICTING" ? "the PR has a merge conflict" : "mergeability is still unknown"
    );
  }
  const awaitingThreadReplies = snapshot.reviewThreads.filter(
    (thread) => !channelIsAcknowledged(thread.comments)
  ).length;
  if (awaitingThreadReplies > 0) {
    blockers.push(
      `${awaitingThreadReplies} review ${awaitingThreadReplies === 1 ? "thread awaits" : "threads await"} a prefixed reply from the local GitHub account`
    );
  }
  const unthreaded = [...snapshot.issueComments, ...snapshot.reviewSummaries];
  const awaitingUnthreadedReply = unthreaded.length > 0 && !channelIsAcknowledged(unthreaded);
  if (awaitingUnthreadedReply) {
    blockers.push("issue or review-summary feedback awaits a prefixed reply from the local GitHub account");
  }
  return {
    eligible: blockers.length === 0,
    blockers,
    awaitingThreadReplies,
    awaitingUnthreadedReply
  };
}
function hasReadyLabel(snapshot, readyLabel) {
  const normalized = readyLabel.toLowerCase();
  return snapshot.labels.some((label) => label.toLowerCase() === normalized);
}
function withReadyLabel(snapshot, readyLabel, ready) {
  const normalized = readyLabel.toLowerCase();
  const withoutReady = snapshot.labels.filter((label) => label.toLowerCase() !== normalized);
  return { ...snapshot, labels: ready ? [...withoutReady, readyLabel] : withoutReady };
}
function hasReadinessInvalidation(prev, next, lastDefiniteMergeable) {
  if (next.state !== "OPEN") return false;
  if (prev.headSha !== next.headSha) return true;
  if (hasNewMergeConflict(lastDefiniteMergeable, next)) return true;
  if (ciIsReady(prev) && !ciIsReady(next)) return true;
  if (hasNewCiFailure(prev, next)) return true;
  if (hasAcknowledgementRegression(prev, next)) return true;
  if (reviewThreadsReceivedNewComments(prev.reviewThreads, next.reviewThreads)) return true;
  if (hasAddedRelevantComment(prev.issueComments, next.issueComments)) return true;
  if (hasAddedRelevantComment(prev.reviewSummaries, next.reviewSummaries)) return true;
  return false;
}

// core/report.ts
var DEFAULT_READY_LABEL = "ready-for-human-review";
var DEFAULT_REPLY_PREFIX = "<!-- pr-monitor:reply -->";
function authorBreakdown(comments) {
  const counts = /* @__PURE__ */ new Map();
  for (const comment of comments) {
    const account = comment.isBot ? `${comment.author}[bot]` : comment.author;
    const qualifiers = [
      comment.isLocal ? "local account, unprefixed" : void 0,
      comment.reviewState === "PENDING" ? "pending review" : void 0
    ].filter((qualifier) => qualifier !== void 0);
    const name = qualifiers.length > 0 ? `${account} [${qualifiers.join("; ")}]` : account;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${count} ${name}`).join(", ");
}
function newSince(comments, baselineMs, baselineComments) {
  const fresh = (() => {
    if (baselineComments !== void 0) {
      const seen = new Set(baselineComments.map((comment) => comment.id));
      return comments.filter((comment) => !seen.has(comment.id));
    }
    return comments.filter((comment) => Date.parse(comment.createdAt) > baselineMs);
  })();
  return relevantComments(fresh);
}
function countLabel(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
function inlineCode(value) {
  let fence = "`";
  while (value.includes(fence)) fence += "`";
  return `${fence}${value}${fence}`;
}
function threadLocator(thread) {
  const threadId = `thread ${inlineCode(thread.id)}`;
  if (thread.path !== void 0) {
    const location = inlineCode(`${thread.path}${thread.line === void 0 ? "" : `:${thread.line}`}`);
    return `${location} [${threadId}]`;
  }
  return threadId;
}
function inlineLine(snapshot, baselineMs, baseline) {
  const unresolved = snapshot.reviewThreads.filter((thread) => !thread.isResolved).length;
  const before = new Map(baseline?.reviewThreads.map((thread) => [thread.id, thread.comments]) ?? []);
  const changed = snapshot.reviewThreads.map((thread) => ({
    thread,
    comments: newSince(thread.comments, baselineMs, baseline ? before.get(thread.id) ?? [] : void 0)
  })).filter((item) => item.comments.length > 0);
  if (changed.length === 0) {
    return `- [comment:inline] ${countLabel(unresolved, "unresolved thread")}; 0 threads received new relevant comments since last flush`;
  }
  const fresh = changed.flatMap((item) => item.comments);
  const previousUnresolved = baseline?.reviewThreads.filter((thread) => !thread.isResolved).length;
  const unresolvedNotice = previousUnresolved === void 0 ? `Inspect every changed thread regardless of the current unresolved-thread count (${unresolved}).` : previousUnresolved === unresolved ? `The unresolved-thread count is unchanged at ${unresolved}; inspect every changed thread anyway.` : `The unresolved-thread count changed from ${previousUnresolved} to ${unresolved}; inspect every changed thread.`;
  const changedUnresolved = changed.filter((item) => !item.thread.isResolved).length;
  const changedResolved = changed.length - changedUnresolved;
  const states = [
    changedUnresolved > 0 ? `${changedUnresolved} currently unresolved` : void 0,
    changedResolved > 0 ? `${changedResolved} currently resolved` : void 0
  ].filter((part) => part !== void 0);
  const changedThreads = changed.map(
    ({ thread, comments }) => `${threadLocator(thread)} (${thread.isResolved ? "resolved" : "unresolved"}; ${authorBreakdown(comments)})`
  ).join("; ");
  const localNotice = fresh.some((comment) => comment.isLocal) ? ` A listed ${inlineCode("[local account, unprefixed]")} entry is a new human comment, not an earlier agent reply.` : "";
  const pendingNotice = fresh.some((comment) => comment.isLocal && comment.reviewState === "PENDING") ? " Pending-review comments may be absent from REST pull-comment results; inspect the listed thread through GraphQL before marking ready." : "";
  return `- [comment:inline] ACTION REQUIRED: ${countLabel(changed.length, "thread")} received ${countLabel(fresh.length, "new relevant comment")} since last flush (${states.join(", ")}; ${authorBreakdown(fresh)}). ${unresolvedNotice} Changed threads: ${changedThreads}.${localNotice}${pendingNotice}`;
}
function ciLine(snapshot, forcedHoldMinutes) {
  const phase = ciPhase(snapshot);
  if (phase === "none") return "- CI: none";
  const total = snapshot.checks.length;
  const failed = snapshot.checks.filter((check) => check.outcome === "failure");
  const pending = snapshot.checks.filter((check) => check.outcome === "pending");
  if (phase === "concluded") {
    if (failed.length === 0) return `- CI: passing (${total}/${total})`;
    return `- CI: failing (${failed.length}/${total} failed: ${failed.map((check) => check.name).join(", ")})`;
  }
  if (forcedHoldMinutes !== void 0) {
    return `- CI: running for ${forcedHoldMinutes}m+ (in_progress: ${pending.map((check) => check.name).join(", ")})`;
  }
  const done = total - pending.length;
  const failedPart = failed.length > 0 ? `, ${failed.length} failed so far: ${failed.map((check) => check.name).join(", ")}` : "";
  return `- CI: running (${done}/${total} done${failedPart})`;
}
function reviewLine(snapshot) {
  const MARKS = {
    APPROVED: "\u2713 approved",
    CHANGES_REQUESTED: "\u2717 changes_requested",
    COMMENTED: "\u2726 commented",
    DISMISSED: "\u2298 dismissed"
  };
  const parts = snapshot.reviews.map((review) => `${review.login} ${MARKS[review.state] ?? review.state.toLowerCase()}`);
  for (const login of snapshot.pendingReviewers) parts.push(`${login} \u23F3 pending`);
  return `- Reviews: ${parts.length > 0 ? parts.join(" \xB7 ") : "none"}`;
}
function reviewSummaryLine(snapshot, baselineMs, baseline) {
  const fresh = newSince(snapshot.reviewSummaries, baselineMs, baseline?.reviewSummaries);
  return fresh.length === 0 ? "- [comment:review] 0 new relevant review summaries since last flush" : `- [comment:review] ACTION REQUIRED: ${countLabel(fresh.length, "new relevant review summary")} since last flush (${authorBreakdown(fresh)}).`;
}
function buildReadinessLines({
  target,
  snapshot,
  readyLabel,
  replyPrefix,
  readinessError,
  autoMergeEnabled = false,
  autoMergeNotice
}) {
  const ready = hasReadyLabel(snapshot, readyLabel);
  const lines = [
    ready ? `- Ready for human review: YES \u2014 label "${readyLabel}" is present.` : `- Ready for human review: NO \u2014 label "${readyLabel}" is absent.`
  ];
  if (autoMergeEnabled) {
    lines.push(
      "- Auto-merge: ENABLED \u2014 automatic readiness and mark_ready make one squash-merge attempt for the accepted head; the squash commit uses only the PR title."
    );
  }
  if (readinessError !== void 0) lines.push(`- Readiness automation failed: ${readinessError}`);
  if (autoMergeNotice !== void 0) lines.push(`- ${autoMergeNotice}`);
  if (!ready && snapshot.state === "OPEN") {
    const assessment = assessAutomaticReadiness(snapshot);
    if (assessment.blockers.length > 0) {
      lines.push(`- Automatic readiness blocked by: ${assessment.blockers.join("; ")}.`);
    }
    lines.push(
      `- Required next step: Do more work until the PR is ready for review, or use ${inlineCode(`pr_monitor(action: "mark_ready", pr: "${targetKey(target)}")`)} if you believe nothing else is required. Local agent replies count only when they begin with ${inlineCode(replyPrefix)}.`
    );
  }
  return lines;
}
function buildReport(target, snapshot, opts) {
  const stateSuffix = snapshot.state !== "OPEN" ? ` \u2014 ${snapshot.state}` : "";
  const title = snapshot.title.replace(/\s+/g, " ").trim();
  const newIssue = newSince(snapshot.issueComments, opts.baselineMs, opts.baselineSnapshot?.issueComments);
  const newPart = (fresh) => fresh.length > 0 ? `${fresh.length} new relevant since last flush: ${authorBreakdown(fresh)}` : "0 new since last flush";
  const readyLabel = opts.readyLabel ?? DEFAULT_READY_LABEL;
  const replyPrefix = opts.replyPrefix ?? DEFAULT_REPLY_PREFIX;
  const lines = [
    `[PR Monitor] [${targetKey(target)}](${snapshot.url}) \u2014 "${title}"${stateSuffix}`,
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
      autoMergeNotice: opts.autoMergeNotice
    })
  ];
  if (snapshot.labels.length > 0) lines.push(`- Labels: ${snapshot.labels.join(", ")}`);
  if (snapshot.state !== "OPEN") {
    lines.push(`- Monitor stopped: PR ${snapshot.state === "MERGED" ? "merged" : "closed"}`);
  }
  return lines.join("\n");
}

// core/watch.ts
var MAX_CONSECUTIVE_FAILURES = 10;
var PrWatch = class {
  target;
  config;
  deps;
  startedAt;
  snapshot;
  // Last MERGEABLE/CONFLICTING value seen, carried across transient UNKNOWN
  // polls so a MERGEABLE -> UNKNOWN -> CONFLICTING settle is still detected.
  lastDefiniteMergeable;
  dirty = false;
  lastActivityAt = 0;
  lastFlushAt;
  lastFlushedSnapshot;
  // True until the configured startup report is successfully delivered or a
  // manual/automatic flush returns it. While true, reports use a zero baseline
  // so comments already present when the watch started cannot be hidden by a
  // failed initial delivery.
  initialAnnouncementPending;
  holdStartedAt;
  // Set for actionable or terminal changes that must skip both timers.
  urgent = false;
  // Head SHA whose CI failure already triggered an instant flush. Caps the
  // instant path at one report per commit.
  ciFailureFlushedSha;
  consecutiveFailures = 0;
  deliveryFailures = 0;
  fetchStartedAt;
  snapshotAt;
  stopped = false;
  stopCleanup;
  // An already-started GitHub readiness mutation must drain before a successor
  // can own this PR. This includes an auto-merge already in flight; stopping
  // after label completion fences a follow-on merge that has not started yet.
  // Fetches and deliveries are fenced by `stopped` but do not block teardown.
  readinessMutation;
  readinessRetry;
  readinessRetryBaseline;
  readinessError;
  reportedReadinessError;
  // One-shot result from an automatic readiness-triggered merge attempt. It is
  // retained across delivery failure, then cleared by delivery or a superseding
  // manual readiness action.
  autoMergeNotice;
  // A poll may observe new feedback and a prefixed response together. The
  // ready label is still withdrawn and reported first; only a later quiet
  // report can restore it, so the feedback never disappears behind one poll.
  autoReadyAfterInvalidation = false;
  // Serializes fetch/apply/mutate/flush/deliver and manual label actions.
  opQueue = Promise.resolve();
  pendingOps = 0;
  constructor(input) {
    this.target = input.target;
    this.config = input.config;
    this.deps = input.deps;
    this.startedAt = input.deps.now();
    this.lastFlushAt = this.startedAt;
    this.snapshot = input.initial;
    this.lastFlushedSnapshot = input.initial;
    this.initialAnnouncementPending = input.config.announceOnStart;
    this.rememberDefiniteMergeable(input.initial);
  }
  rememberDefiniteMergeable(snapshot) {
    if (snapshot.mergeable !== "UNKNOWN") this.lastDefiniteMergeable = snapshot.mergeable;
  }
  get isStopped() {
    return this.stopped;
  }
  statusLine() {
    const now = this.deps.now();
    const phase = this.holdStartedAt !== void 0 ? "ci-hold" : "watching";
    const baselineAge = Math.round((now - this.lastFlushAt) / 6e4);
    const failures = this.consecutiveFailures > 0 ? `, ${this.consecutiveFailures} consecutive poll failures` : "";
    const readiness = this.deps.readiness;
    const ready = readiness !== void 0 && this.snapshot !== void 0 ? `, ready for human review: ${hasReadyLabel(this.snapshot, readiness.label) ? "yes" : "no"}` : "";
    const autoMerge = this.deps.autoMerge === void 0 ? "" : ", auto-merge: squash";
    return `${targetKey(this.target)} \u2014 ${phase}, ${this.dirty ? "activity buffered" : "quiet"}, baseline ${baselineAge}m ago${failures}${ready}${autoMerge}`;
  }
  runExclusive(task) {
    this.pendingOps += 1;
    const run = this.opQueue.then(task);
    this.opQueue = run.then(
      () => {
        this.pendingOps -= 1;
      },
      () => {
        this.pendingOps -= 1;
      }
    );
    return run;
  }
  trackReadinessMutation(task) {
    const operation = task();
    let tracked;
    tracked = operation.finally(() => {
      if (this.readinessMutation === tracked) this.readinessMutation = void 0;
    });
    this.readinessMutation = tracked;
    return tracked;
  }
  /** Observe the existing label; the agent assesses the initial handoff. */
  async initializeReadiness() {
    if (this.stopped) return;
    await this.runExclusive(async () => {
      const snapshot = this.snapshot;
      const readiness = this.deps.readiness;
      if (this.stopped || snapshot === void 0 || readiness === void 0) return;
      this.notifyReadyChanged(hasReadyLabel(snapshot, readiness.label));
    });
  }
  /** Manual actions are serialized with polling and accept all current state. */
  async manualSetReady(ready) {
    if (this.stopped) throw new Error("the monitor stopped before the ready action could run");
    return await this.runExclusive(async () => {
      if (this.stopped) throw new Error("the monitor stopped before the ready action could run");
      const readiness = this.deps.readiness;
      const snapshot = this.snapshot;
      if (readiness === void 0 || snapshot === void 0) {
        throw new Error("this watch does not have a readiness channel");
      }
      this.autoMergeNotice = void 0;
      return await this.trackReadinessMutation(async () => {
        let text = await readiness.change(ready);
        this.snapshot = withReadyLabel(snapshot, readiness.label, ready);
        if (!this.stopped) {
          this.clearReadinessFailure();
          this.autoReadyAfterInvalidation = false;
          this.notifyReadyChanged(ready);
          if (ready) {
            const autoMerge = await this.attemptAutoMerge({ snapshot: this.snapshot, report: false });
            if (autoMerge !== void 0) text += `
${autoMerge}`;
          } else if (assessAutomaticReadiness(this.snapshot).eligible) {
            this.dirty = true;
            this.lastActivityAt = this.deps.now();
            this.holdStartedAt = void 0;
          }
        }
        return text;
      });
    });
  }
  /** Periodic poll; never throws. Skipped while a poll or flush is in flight. */
  async tick() {
    if (this.stopped || this.pendingOps > 0) return;
    try {
      await this.runExclusive(() => this.pollOnce());
    } catch (error) {
      this.deps.log(`unexpected tick error for ${targetKey(this.target)}: ${error}`);
    }
  }
  async pollOnce() {
    if (this.stopped) return;
    let next;
    try {
      this.fetchStartedAt = this.deps.now();
      next = await this.deps.fetchSnapshot();
    } catch (error) {
      if (!this.stopped) this.handlePollFailure(error);
      return;
    }
    if (this.stopped) return;
    this.consecutiveFailures = 0;
    this.snapshotAt = this.fetchStartedAt;
    next = await this.applySnapshot(next);
    this.snapshot = next;
    if (this.stopped) return;
    this.rememberDefiniteMergeable(next);
    await this.maybeAutoFlush();
  }
  async applySnapshot(next) {
    const previous = this.snapshot;
    if (previous === void 0) return next;
    const becameTerminal = previous.state === "OPEN" && next.state !== "OPEN";
    const becameConflicting = hasNewMergeConflict(this.lastDefiniteMergeable, next);
    const now = this.deps.now();
    if (detectActivity(previous, next, this.lastDefiniteMergeable)) {
      this.dirty = true;
      this.lastActivityAt = now;
      this.holdStartedAt = void 0;
    }
    if (this.config.flushOnCiFailure && next.state === "OPEN" && this.ciFailureFlushedSha !== next.headSha && hasNewCiFailure(previous, next)) {
      this.dirty = true;
      this.urgent = true;
      this.ciFailureFlushedSha = next.headSha;
      this.holdStartedAt = void 0;
    }
    if (becameConflicting || becameTerminal) {
      this.dirty = true;
      this.urgent = true;
      this.holdStartedAt = void 0;
    }
    const readiness = this.deps.readiness;
    if (readiness === void 0) return next;
    const wasReady = hasReadyLabel(previous, readiness.label);
    const observedReady = hasReadyLabel(next, readiness.label);
    if (next.state !== "OPEN") {
      this.clearReadinessFailure();
      if (wasReady !== observedReady) this.notifyReadyChanged(observedReady);
      return next;
    }
    if (this.readinessRetry !== void 0) {
      const desired = this.readinessRetry;
      const retryInvalidated = desired && this.readinessRetryBaseline !== void 0 && hasReadinessInvalidation(this.readinessRetryBaseline, next, this.lastDefiniteMergeable);
      if (retryInvalidated) {
        this.clearReadinessFailure();
        this.dirty = true;
        this.lastActivityAt = now;
        this.holdStartedAt = void 0;
        if (observedReady) {
          this.urgent = true;
          const changed = await this.changeSnapshotReadiness(next, false);
          if (!hasReadyLabel(changed, readiness.label)) this.autoReadyAfterInvalidation = true;
          return changed;
        }
      } else if (observedReady === desired) {
        this.clearReadinessFailure();
        this.notifyReadyChanged(desired);
        this.dirty = true;
        this.urgent = true;
        if (!desired) this.autoReadyAfterInvalidation = true;
        return next;
      } else if (!desired || assessAutomaticReadiness(next).eligible) {
        const changed = await this.changeSnapshotReadiness(next, desired);
        if (hasReadyLabel(changed, readiness.label) === desired) {
          this.dirty = true;
          this.urgent = true;
          if (!desired) this.autoReadyAfterInvalidation = true;
        }
        return changed;
      } else {
        this.clearReadinessFailure();
      }
    }
    if (wasReady && hasReadinessInvalidation(previous, next, this.lastDefiniteMergeable)) {
      this.dirty = true;
      this.urgent = true;
      this.holdStartedAt = void 0;
      if (!observedReady) {
        this.notifyReadyChanged(false);
        this.autoReadyAfterInvalidation = true;
        return next;
      }
      const changed = await this.changeSnapshotReadiness(next, false);
      if (!hasReadyLabel(changed, readiness.label)) this.autoReadyAfterInvalidation = true;
      return changed;
    }
    if (wasReady !== observedReady) {
      this.notifyReadyChanged(observedReady);
      if (!observedReady) {
        this.dirty = true;
        this.lastActivityAt = now;
        this.holdStartedAt = void 0;
      }
    }
    const beforeEligible = assessAutomaticReadiness(previous).eligible;
    const afterEligible = assessAutomaticReadiness(next).eligible;
    if (!observedReady && afterEligible && !beforeEligible) {
      this.dirty = true;
      this.lastActivityAt = now;
      this.holdStartedAt = void 0;
    }
    return next;
  }
  /**
   * Initial status delivered right after the watch starts. A delivery failure
   * is re-armed without advancing the baseline.
   */
  async announceInitial() {
    if (this.stopped) return false;
    return await this.runExclusive(() => this.announceInitialOnce());
  }
  async announceInitialOnce() {
    if (this.stopped || this.snapshot === void 0) return false;
    const readiness = this.deps.readiness;
    if (readiness !== void 0) {
      this.notifyReadyChanged(hasReadyLabel(this.snapshot, readiness.label));
    }
    const report = this.buildCurrentReport({ baselineMs: 0 });
    if (await this.deliverOrLog(report)) {
      this.deliveryFailures = 0;
      this.lastFlushAt = this.snapshotAt ?? this.startedAt;
      this.lastFlushedSnapshot = this.snapshot;
      this.initialAnnouncementPending = false;
      this.dirty = false;
      this.holdStartedAt = void 0;
      this.urgent = false;
      this.afterReportDelivered();
      return true;
    }
    this.deliveryFailures += 1;
    this.dirty = true;
    this.urgent = true;
    if (this.deliveryFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.deps.log(
        `monitor stopped for ${targetKey(this.target)}: ${MAX_CONSECUTIVE_FAILURES} consecutive delivery failures`
      );
      this.stop();
    }
    return false;
  }
  /** Manual flush always re-fetches and returns a full report. */
  async manualFlush() {
    if (this.stopped) return `${targetKey(this.target)}: flush skipped \u2014 monitor stopped.`;
    return await this.runExclusive(() => this.flushOnce());
  }
  async flushOnce() {
    if (this.stopped) return `${targetKey(this.target)}: flush skipped \u2014 monitor stopped.`;
    try {
      this.fetchStartedAt = this.deps.now();
      const fetched = await this.deps.fetchSnapshot();
      if (this.stopped) return `${targetKey(this.target)}: flush skipped \u2014 monitor stopped.`;
      this.consecutiveFailures = 0;
      this.snapshotAt = this.fetchStartedAt;
      this.snapshot = await this.applySnapshot(fetched);
      this.rememberDefiniteMergeable(this.snapshot);
    } catch (error) {
      if (this.stopped) return `${targetKey(this.target)}: flush skipped \u2014 monitor stopped.`;
      if (this.snapshot === void 0) return `${targetKey(this.target)}: flush failed \u2014 ${error.message}`;
      const report2 = this.buildCurrentReport({
        baselineMs: this.initialAnnouncementPending ? 0 : this.lastFlushAt,
        baselineSnapshot: this.initialAnnouncementPending ? void 0 : this.lastFlushedSnapshot
      });
      return `${report2}
(note: refresh failed \u2014 ${error.message}; data is from the previous poll; baseline NOT reset)`;
    }
    if (this.stopped) return `${targetKey(this.target)}: flush skipped \u2014 monitor stopped.`;
    if (this.dirty && !this.autoReadyAfterInvalidation) await this.prepareAutomaticReady();
    if (this.stopped) return `${targetKey(this.target)}: flush skipped \u2014 monitor stopped.`;
    const report = this.flush(void 0);
    this.afterReportDelivered();
    this.stopIfTerminal();
    return report;
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const finish = () => {
      try {
        this.deps.onStopped();
      } catch (error) {
        this.deps.log(`stop observer failed for ${targetKey(this.target)}: ${error}`);
      }
    };
    const mutation = this.readinessMutation;
    if (mutation === void 0) {
      finish();
      this.stopCleanup = Promise.resolve();
      return;
    }
    this.stopCleanup = mutation.then(finish, finish);
  }
  async waitUntilStopped() {
    await this.stopCleanup;
  }
  stopNotice(reason) {
    const base = `[PR Monitor] [${targetKey(this.target)}](${targetUrl(this.target)}) \u2014 ${reason}`;
    const snapshot = this.snapshot;
    const readiness = this.deps.readiness;
    if (snapshot === void 0 || readiness === void 0) return base;
    return [
      base,
      ...buildReadinessLines({
        target: this.target,
        snapshot,
        readyLabel: readiness.label,
        replyPrefix: readiness.replyPrefix,
        readinessError: this.readinessError,
        autoMergeEnabled: this.deps.autoMerge !== void 0,
        autoMergeNotice: this.autoMergeNotice
      })
    ].join("\n");
  }
  handlePollFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PollError && error.notFound) {
      void this.deliverStopNotice(
        this.stopNotice(
          `Monitor stopped: PR not found (deleted or inaccessible). Last error: ${message}`
        )
      );
      this.stop();
      return;
    }
    this.consecutiveFailures += 1;
    this.deps.log(
      `poll failed for ${targetKey(this.target)} (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${message}`
    );
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      void this.deliverStopNotice(
        this.stopNotice(
          `Monitor stopped: ${MAX_CONSECUTIVE_FAILURES} consecutive poll failures. Last error: ${message}`
        )
      );
      this.stop();
    }
  }
  async maybeAutoFlush() {
    if (!this.dirty || this.snapshot === void 0) return;
    const now = this.deps.now();
    let forcedHoldMinutes;
    if (!this.urgent) {
      if (now - this.lastActivityAt < this.config.debounceMinutes * 6e4) return;
      if (ciPhase(this.snapshot) === "running" && this.snapshot.state === "OPEN") {
        if (this.holdStartedAt === void 0) this.holdStartedAt = now;
        const heldMs = now - this.holdStartedAt;
        if (heldMs < this.config.maxCiWaitMinutes * 6e4) return;
        forcedHoldMinutes = Math.round(heldMs / 6e4);
      }
    }
    if (this.stopped) return;
    if (!this.autoReadyAfterInvalidation) await this.prepareAutomaticReady();
    if (this.stopped) return;
    const previousFlushAt = this.lastFlushAt;
    const previousFlushedSnapshot = this.lastFlushedSnapshot;
    const previousInitialAnnouncementPending = this.initialAnnouncementPending;
    const previousHoldStartedAt = this.holdStartedAt;
    const previousUrgent = this.urgent;
    const report = this.flush(forcedHoldMinutes);
    try {
      await this.deps.deliver(report);
      this.deliveryFailures = 0;
      this.afterReportDelivered();
      this.stopIfTerminal();
    } catch (error) {
      this.lastFlushAt = previousFlushAt;
      this.lastFlushedSnapshot = previousFlushedSnapshot;
      this.initialAnnouncementPending = previousInitialAnnouncementPending;
      this.dirty = true;
      this.holdStartedAt = previousHoldStartedAt;
      this.urgent = previousUrgent;
      this.deliveryFailures += 1;
      this.deps.log(
        `report delivery failed for ${targetKey(this.target)} (${this.deliveryFailures}/${MAX_CONSECUTIVE_FAILURES}), will retry: ${error}`
      );
      if (this.deliveryFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.deps.log(
          `monitor stopped for ${targetKey(this.target)}: ${MAX_CONSECUTIVE_FAILURES} consecutive delivery failures`
        );
        if (!this.stopped && this.deps.persist !== void 0) {
          try {
            await this.deps.persist(
              this.stopNotice(
                `Monitor stopped: ${MAX_CONSECUTIVE_FAILURES} consecutive delivery failures. Last error: ${error instanceof Error ? error.message : String(error)}`
              )
            );
          } catch (persistError) {
            this.deps.log(`terminal stop notice could not be persisted for ${targetKey(this.target)}: ${persistError}`);
          }
        }
        this.stop();
      }
    }
  }
  async prepareAutomaticReady() {
    const snapshot = this.snapshot;
    const readiness = this.deps.readiness;
    if (snapshot === void 0 || readiness === void 0 || // Failed delivery alone is not new activity. Keep unchanged startup
    // retries for agent assessment, but allow activity since that snapshot.
    this.initialAnnouncementPending && assessAutomaticReadiness(this.lastFlushedSnapshot).eligible && !detectActivity(this.lastFlushedSnapshot, snapshot, this.lastFlushedSnapshot.mergeable) || snapshot.state !== "OPEN" || hasReadyLabel(snapshot, readiness.label) || !assessAutomaticReadiness(snapshot).eligible) {
      return;
    }
    this.snapshot = await this.changeSnapshotReadiness(snapshot, true);
  }
  async changeSnapshotReadiness(snapshot, ready) {
    const readiness = this.deps.readiness;
    if (readiness === void 0) return snapshot;
    return await this.trackReadinessMutation(async () => {
      try {
        await readiness.change(ready);
        const changed = withReadyLabel(snapshot, readiness.label, ready);
        this.snapshot = changed;
        if (this.stopped) return changed;
        this.clearReadinessFailure();
        this.notifyReadyChanged(ready);
        if (ready) await this.attemptAutoMerge({ snapshot: changed, report: true });
        return changed;
      } catch (error) {
        this.snapshot = snapshot;
        const action = ready ? "add" : "remove";
        const message = `could not ${action} label "${readiness.label}": ${error instanceof Error ? error.message : String(error)}`;
        if (this.readinessRetry !== ready || this.readinessRetryBaseline === void 0) {
          this.readinessRetryBaseline = snapshot;
        }
        this.readinessRetry = ready;
        this.readinessError = message;
        if (message !== this.reportedReadinessError) {
          this.dirty = true;
          this.urgent = true;
        }
        this.deps.log(`readiness automation failed for ${targetKey(this.target)}: ${message}`);
        return snapshot;
      }
    });
  }
  async attemptAutoMerge({
    snapshot,
    report
  }) {
    const autoMerge = this.deps.autoMerge;
    if (autoMerge === void 0) return void 0;
    let notice;
    try {
      notice = await autoMerge.squashMerge({
        pullRequest: { title: snapshot.title, headSha: snapshot.headSha }
      });
    } catch (error) {
      notice = autoMergeFailureText({ error });
      this.deps.log(`auto-merge failed for ${targetKey(this.target)}: ${error}`);
    }
    if (report) this.autoMergeNotice = notice;
    return notice;
  }
  clearReadinessFailure() {
    this.readinessRetry = void 0;
    this.readinessRetryBaseline = void 0;
    this.readinessError = void 0;
    this.reportedReadinessError = void 0;
  }
  notifyReadyChanged(ready) {
    try {
      this.deps.readiness?.onChanged(ready);
    } catch (error) {
      this.deps.log(`ready-state observer failed for ${targetKey(this.target)}: ${error}`);
    }
  }
  afterReportDelivered() {
    this.reportedReadinessError = this.readinessError;
    this.autoMergeNotice = void 0;
    if (!this.autoReadyAfterInvalidation) return;
    this.autoReadyAfterInvalidation = false;
    const snapshot = this.snapshot;
    const readiness = this.deps.readiness;
    if (snapshot !== void 0 && readiness !== void 0 && snapshot.state === "OPEN" && !hasReadyLabel(snapshot, readiness.label) && assessAutomaticReadiness(snapshot).eligible) {
      this.dirty = true;
      this.lastActivityAt = this.deps.now();
      this.holdStartedAt = void 0;
      this.urgent = false;
    }
  }
  /**
   * Deliver a terminal stop notice, falling back to the persistent channel
   * when the delivery channel itself fails — a watch that stops must not do so
   * silently when any channel can still carry the fact.
   */
  async deliverStopNotice(message) {
    if (await this.deliverOrLog(message)) return;
    if (this.deps.persist === void 0) return;
    try {
      await this.deps.persist(message);
    } catch (error) {
      this.deps.log(`terminal stop notice could not be persisted for ${targetKey(this.target)}: ${error}`);
    }
  }
  async deliverOrLog(message) {
    try {
      await this.deps.deliver(message);
      return true;
    } catch (error) {
      this.deps.log(`report delivery failed for ${targetKey(this.target)}: ${error}`);
      return false;
    }
  }
  buildCurrentReport({
    baselineMs,
    baselineSnapshot,
    forcedHoldMinutes
  }) {
    const readiness = this.deps.readiness;
    const report = buildReport(this.target, this.snapshot, {
      baselineMs,
      baselineSnapshot,
      forcedHoldMinutes,
      readyLabel: readiness?.label,
      replyPrefix: readiness?.replyPrefix,
      readinessError: this.readinessError,
      autoMergeEnabled: this.deps.autoMerge !== void 0,
      autoMergeNotice: this.autoMergeNotice
    });
    if (!this.initialAnnouncementPending || this.snapshot?.state !== "OPEN") return report;
    const startupNotice = this.deps.startupNotice === void 0 ? "" : `
- Startup safety reset: ${this.deps.startupNotice}`;
    return report + startupNotice + "\n- Startup/restart assessment: inspect the current head's checks, expected automated reviews, and existing feedback now. If already settled with nothing left to do, call mark_ready without waiting for a new event. Empty results after creation or a fresh push do not prove readiness; PR age alone is insufficient.";
  }
  flush(forcedHoldMinutes) {
    const snapshot = this.snapshot;
    const report = this.buildCurrentReport({
      baselineMs: this.initialAnnouncementPending ? 0 : this.lastFlushAt,
      baselineSnapshot: this.initialAnnouncementPending ? void 0 : this.lastFlushedSnapshot,
      forcedHoldMinutes
    });
    this.lastFlushAt = this.snapshotAt ?? this.deps.now();
    this.lastFlushedSnapshot = snapshot;
    this.initialAnnouncementPending = false;
    this.dirty = false;
    this.holdStartedAt = void 0;
    this.urgent = false;
    return report;
  }
  stopIfTerminal() {
    if (this.snapshot !== void 0 && this.snapshot.state !== "OPEN") this.stop();
  }
};

// runtime/tool.ts
var MONITOR_ACTION_VALUES = [
  "start" /* start */,
  "stop" /* stop */,
  "flush" /* flush */,
  "status" /* status */,
  "mark_ready" /* markReady */,
  "unmark_ready" /* unmarkReady */
];
function buildMonitorToolDescription({
  delivery,
  configPath,
  lifecycle,
  waiting
}) {
  return `Monitor a GitHub PR in the background. Detects head changes, CI conclusions, reviews, inline/issue comments (including follow-ups on existing or resolved threads), mergeability changes, and merge/close. Activity is aggregated with a rolling debounce; ${delivery} Reports never include comment bodies. Every report states whether the configured ready label is present and tells the agent to keep working or manually mark ready when judgment says no action remains. Startup reports normally observe the existing label; when autoMerge is enabled by trusted config or SESORI_PR_MONITOR_AUTO_MERGE=true, start removes a pre-existing ready label and requires fresh assessment. Assess current-head checks, automated reviews and feedback immediately, including after restarting a monitor. Mark an already-settled PR ready without waiting for a new event, but never infer readiness from empty results after creation or a fresh push. On later activity, the monitor automatically adds readiness when CI is passing (or absent), mergeability is definite, and every feedback channel ends in a correctly prefixed local-account reply. It withdraws readiness on later commits, relevant comments, CI regression, or conflict. A newly failing check (when flushOnCiFailure is enabled), readiness withdrawal, merge conflict, or terminal state skips debounce. The monitor owns all polling and notifications arrive automatically. NEVER create sleeps, delayed or scheduled jobs, background polling loops, repeated \`gh pr checks\`, or routine status/flush calls while waiting. ${waiting} Actions: start (watch one PR), stop (stop one or all), flush (on-demand full report; never routine after a delivered report), status (list this session's monitors), mark_ready (unconditionally accept current state and add the configured ready label), and unmark_ready (remove it now; automation may restore it after a later clean assessment). With autoMerge enabled, automatic readiness and mark_ready also make one squash-merge attempt for the accepted head using only the PR title; rejected or unknown outcomes keep readiness and are not retried automatically, while a changed head cancels standalone readiness. Ready actions do not require an active monitor. The PR must be \`owner/repo#123\` or a full URL; \`all\` is allowed only for stop/flush. Global tuning lives in ~/.config/pr-monitor/config.json; ${configPath} overrides it. An explicit SESORI_PR_MONITOR_AUTO_MERGE environment value overrides autoMerge config. ${lifecycle}`;
}

// runtime/monitor-session.ts
var MonitorSession = class {
  deps;
  watches = /* @__PURE__ */ new Map();
  // Destructive startup work happens before a watch can own the target. Keep
  // it in the session cleanup barrier so a reloaded successor cannot race it.
  startupMutations = /* @__PURE__ */ new Set();
  // Standalone ready actions have no watch to supply a cleanup barrier. Track
  // them here so replacement sessions cannot overlap label or merge mutations.
  standaloneReadinessMutations = /* @__PURE__ */ new Set();
  lifecycleGeneration = 0;
  selfLogin;
  selfLoginPromise;
  constructor(deps) {
    this.deps = {
      ...deps,
      now: deps.now ?? Date.now,
      schedule: deps.schedule ?? (({ callback, intervalMs }) => setInterval(callback, intervalMs)),
      cancel: deps.cancel ?? (({ timer }) => {
        clearInterval(timer);
      })
    };
  }
  trackStartupMutation({ mutation }) {
    const operation = Promise.resolve().then(mutation);
    const barrier = operation.then(
      () => void 0,
      () => void 0
    );
    this.startupMutations.add(barrier);
    void barrier.then(() => this.startupMutations.delete(barrier));
    return operation;
  }
  trackStandaloneReadinessMutation({ mutation }) {
    const operation = Promise.resolve().then(mutation);
    const barrier = operation.then(
      () => void 0,
      () => void 0
    );
    this.standaloneReadinessMutations.add(barrier);
    void barrier.then(() => this.standaloneReadinessMutations.delete(barrier));
    return operation;
  }
  list() {
    return [...this.watches.values()].map(({ watch, config }) => ({
      target: watch.target,
      config,
      statusLine: watch.statusLine()
    }));
  }
  async execute({
    action,
    pr,
    start,
    loadConfig
  }) {
    const actionLoadConfig = loadConfig ?? this.deps.loadConfig ?? (() => Promise.reject(new Error("this host did not provide a configuration loader")));
    switch (action) {
      case "start" /* start */:
        if (!pr || pr === "all") {
          return { text: "action 'start' requires a single explicit pr: 'owner/repo#123' or a PR URL." };
        }
        if (start === void 0) return { text: "Cannot start monitor: this host did not provide a report channel." };
        return await this.start({ pr, options: start, loadConfig: actionLoadConfig });
      case "stop" /* stop */:
        if (!pr) return { text: "action 'stop' requires pr: 'owner/repo#123', a PR URL, or 'all'." };
        return await this.stop({ pr });
      case "flush" /* flush */:
        if (!pr) return { text: "action 'flush' requires pr: 'owner/repo#123', a PR URL, or 'all'." };
        return await this.flush({ pr });
      case "status" /* status */:
        return { text: this.status() };
      case "mark_ready" /* markReady */:
        if (!pr || pr === "all") {
          return { text: "action 'mark_ready' requires a single explicit pr: 'owner/repo#123' or a PR URL." };
        }
        return await this.changeReady({ pr, ready: true, loadConfig: actionLoadConfig });
      case "unmark_ready" /* unmarkReady */:
        if (!pr || pr === "all") {
          return { text: "action 'unmark_ready' requires a single explicit pr: 'owner/repo#123' or a PR URL." };
        }
        return await this.changeReady({ pr, ready: false, loadConfig: actionLoadConfig });
    }
  }
  async stopAll({
    notice,
    channel = "normal" /* normal */
  }) {
    this.lifecycleGeneration += 1;
    const entries = [...this.watches.values()];
    const startupMutations = [...this.startupMutations];
    const standaloneReadinessMutations = [...this.standaloneReadinessMutations];
    for (const entry of entries) entry.watch.stop();
    await Promise.all([
      ...entries.map((entry) => entry.watch.waitUntilStopped()),
      ...startupMutations,
      ...standaloneReadinessMutations
    ]);
    if (notice === void 0) return;
    await Promise.all(
      entries.map(async (entry) => {
        const report = entry.watch.stopNotice(notice);
        const send = channel === "persistent" /* persistent */ ? entry.channel.persist ?? entry.channel.deliver : entry.channel.deliver;
        try {
          await send({ report });
        } catch (error) {
          this.deps.log(`stop notice delivery failed for ${targetKey(entry.watch.target)}: ${error}`);
        }
      })
    );
  }
  async start({
    pr,
    options,
    loadConfig
  }) {
    const target = parseTarget(pr);
    if ("error" in target) return { text: target.error };
    const key = targetRegistryKey(target);
    const displayKey = targetKey(target);
    const existing = this.watches.get(key);
    if (existing) return { text: `Already monitoring ${displayKey} in this session.
${existing.watch.statusLine()}` };
    const lifecycleGeneration = this.lifecycleGeneration;
    const preparationError = await options.prepare?.();
    if (preparationError !== void 0) return { text: preparationError };
    let config;
    try {
      config = await loadConfig();
    } catch (error) {
      return {
        text: `Cannot start monitor for ${displayKey}: loading configuration failed (${error.message}).`
      };
    }
    if (config.ignoreCommentTag !== void 0 && this.selfLogin === void 0) {
      try {
        this.selfLoginPromise ??= this.deps.runGh(["api", "user", "--jq", ".login"]).then((login) => login.trim());
        this.selfLogin = await this.selfLoginPromise;
      } catch (error) {
        this.selfLoginPromise = void 0;
        return {
          text: `Cannot start monitor: resolving the authenticated gh user for the reply prefix failed (${error.message}). Run \`gh auth status\` to check.`
        };
      }
    }
    let initial;
    try {
      initial = await this.fetchSnapshot({ target, config });
    } catch (error) {
      return { text: `Cannot start monitor for ${displayKey}: ${error.message}` };
    }
    if (this.lifecycleGeneration !== lifecycleGeneration) {
      return { text: `Monitor session ended while ${displayKey} was starting; no active monitor remains.` };
    }
    if (initial.state !== "OPEN") {
      return { text: `Cannot start monitor: ${displayKey} is already ${initial.state}.` };
    }
    const raced = this.watches.get(key);
    if (raced) return { text: `Already monitoring ${displayKey} in this session.
${raced.watch.statusLine()}` };
    let startupNotice;
    if (config.autoMerge && hasReadyLabel(initial, config.readyLabel)) {
      try {
        await this.trackStartupMutation({
          mutation: () => removeReadyForHumanReview(this.deps.runGh, target, config.readyLabel)
        });
      } catch (error) {
        return {
          text: `Cannot start monitor for ${displayKey}: auto-merge is enabled but the pre-existing ready label "${config.readyLabel}" could not be removed (${error.message}).`
        };
      }
      initial = withReadyLabel(initial, config.readyLabel, false);
      startupNotice = `pre-existing ready label "${config.readyLabel}" was removed because auto-merge is enabled. Reassess the current head and call mark_ready if it is ready; that action will try to squash-merge it.`;
      if (this.lifecycleGeneration !== lifecycleGeneration) {
        return {
          text: `Monitor session ended while ${displayKey} was starting. ${startupNotice} No active monitor remains.`
        };
      }
      const resetRace = this.watches.get(key);
      if (resetRace) {
        return { text: `Already monitoring ${displayKey} in this session.
${resetRace.watch.statusLine()}` };
      }
    }
    const reportChannel = options.createChannel({ target, config });
    let timer;
    const watch = new PrWatch({
      target,
      config,
      initial,
      deps: {
        now: this.deps.now,
        fetchSnapshot: () => this.fetchSnapshot({ target, config }),
        deliver: (report) => reportChannel.deliver({ report }),
        persist: reportChannel.persist === void 0 ? void 0 : (report) => reportChannel.persist?.({ report }) ?? Promise.resolve(),
        log: this.deps.log,
        onStopped: () => {
          this.deps.cancel({ timer });
          const entry = this.watches.get(key);
          if (entry?.watch === watch) {
            this.watches.delete(key);
            this.notifyWatchChanged({ type: "stopped" /* stopped */, target, config });
          }
        },
        readiness: {
          label: config.readyLabel,
          replyPrefix: config.ignoreCommentTag ?? "<!-- pr-monitor:reply -->",
          change: (ready) => ready ? markReadyForHumanReview(this.deps.runGh, target, config.readyLabel) : removeReadyForHumanReview(this.deps.runGh, target, config.readyLabel),
          onChanged: (ready) => this.notifyReadyChanged({ target, ready, watched: true, config })
        },
        autoMerge: config.autoMerge ? {
          squashMerge: ({ pullRequest }) => squashMergePullRequest({
            runGh: this.deps.runGh,
            target,
            pullRequest
          })
        } : void 0,
        startupNotice
      }
    });
    timer = this.deps.schedule({
      intervalMs: config.pollIntervalSeconds * 1e3,
      callback: () => {
        void watch.tick().finally(() => this.notifyTickSettled({ target, config }));
      }
    });
    this.watches.set(key, { watch, timer, config, channel: reportChannel });
    this.notifyWatchChanged({ type: "started" /* started */, target, config });
    let announcement = "disabled" /* disabled */;
    if (options.announcementMode === "await_delivery" /* awaitDelivery */) {
      if (config.announceOnStart) {
        announcement = await watch.announceInitial() ? "delivered" /* delivered */ : "retrying" /* retrying */;
      } else {
        await watch.initializeReadiness();
      }
      if (watch.isStopped) {
        return { text: `Monitor for ${displayKey} stopped before startup completed; no active monitor remains.` };
      }
    } else if (config.announceOnStart) {
      announcement = "pending" /* pending */;
      void watch.announceInitial();
    } else {
      void watch.initializeReadiness();
    }
    this.deps.log(`started monitoring ${displayKey}`);
    const autoMergeNotice = config.autoMerge ? " Auto-merge enabled: automatic readiness and mark_ready make one squash-merge attempt for the accepted head using only the PR title." : "";
    const resetNotice = startupNotice === void 0 ? "" : ` Startup safety reset: ${startupNotice}`;
    return {
      text: `Started monitoring ${displayKey} \u2014 "${initial.title}".${autoMergeNotice}${resetNotice}`,
      start: { target, config, announcement }
    };
  }
  select({ pr }) {
    if (pr === "all") return [...this.watches.values()];
    const target = parseTarget(pr);
    if ("error" in target) return target;
    const entry = this.watches.get(targetRegistryKey(target));
    if (!entry) {
      return {
        error: `No monitor for ${targetKey(target)} in this session. Use action "status" to list active monitors.`
      };
    }
    return [entry];
  }
  async stop({ pr }) {
    const selected = this.select({ pr });
    if ("error" in selected) return { text: selected.error };
    if (selected.length === 0) return { text: "No active monitors in this session." };
    for (const entry of selected) entry.watch.stop();
    await Promise.all(selected.map((entry) => entry.watch.waitUntilStopped()));
    return {
      text: `Stopped ${selected.length} monitor(s): ${selected.map((entry) => targetKey(entry.watch.target)).join(", ")}.`
    };
  }
  async flush({ pr }) {
    const selected = this.select({ pr });
    if ("error" in selected) return { text: selected.error };
    if (selected.length === 0) return { text: "No active monitors in this session." };
    const reports = await Promise.all(selected.map((entry) => entry.watch.manualFlush()));
    return { text: reports.join("\n\n") };
  }
  status() {
    if (this.watches.size === 0) return "No active monitors in this session.";
    return [...this.watches.values()].map(({ watch, config }) => {
      let suffix = "";
      try {
        suffix = this.deps.statusSuffix?.({ target: watch.target, config }) ?? "";
      } catch (error) {
        this.deps.log(`status decoration failed for ${targetKey(watch.target)}: ${error}`);
      }
      return `${watch.statusLine()}${suffix}`;
    }).join("\n");
  }
  async changeReady({
    pr,
    ready,
    loadConfig
  }) {
    const target = parseTarget(pr);
    if ("error" in target) return { text: target.error };
    const key = targetRegistryKey(target);
    const displayKey = targetKey(target);
    try {
      const watchedEntry = this.watches.get(key);
      if (watchedEntry !== void 0) {
        const text = await watchedEntry.watch.manualSetReady(ready);
        return {
          text,
          ready: { target: watchedEntry.watch.target, ready, watched: true }
        };
      }
      return await this.trackStandaloneReadinessMutation({
        mutation: () => this.changeStandaloneReady({ target, ready, loadConfig })
      });
    } catch (error) {
      const action = ready ? `mark ${displayKey} as ready for human review` : `withdraw the ready-for-human-review label from ${displayKey}`;
      return { text: `Cannot ${action}: ${error.message}` };
    }
  }
  async changeStandaloneReady({
    target,
    ready,
    loadConfig
  }) {
    const config = await loadConfig();
    const acceptedPullRequest = ready && config.autoMerge ? await getAutoMergePullRequest({ runGh: this.deps.runGh, target }) : void 0;
    let effectiveReady = ready;
    let text = ready ? await markReadyForHumanReview(this.deps.runGh, target, config.readyLabel) : await removeReadyForHumanReview(this.deps.runGh, target, config.readyLabel);
    if (acceptedPullRequest !== void 0) {
      let revalidatedPullRequest;
      try {
        revalidatedPullRequest = await getAutoMergePullRequest({ runGh: this.deps.runGh, target });
      } catch (error) {
        const withdrawal = await this.withdrawUnsafeStandaloneReadiness({
          target,
          config,
          reason: `the accepted head could not be revalidated after labeling (${error instanceof Error ? error.message : String(error)})`
        });
        effectiveReady = !withdrawal.removed;
        text += `
${withdrawal.text}`;
      }
      if (revalidatedPullRequest !== void 0 && revalidatedPullRequest.headSha !== acceptedPullRequest.headSha) {
        const withdrawal = await this.withdrawUnsafeStandaloneReadiness({
          target,
          config,
          reason: `the PR head changed from ${acceptedPullRequest.headSha} to ${revalidatedPullRequest.headSha} while readiness was being applied`
        });
        effectiveReady = !withdrawal.removed;
        text += `
${withdrawal.text}`;
      } else if (revalidatedPullRequest !== void 0) {
        try {
          text += `
${await squashMergePullRequest({
            runGh: this.deps.runGh,
            target,
            pullRequest: revalidatedPullRequest
          })}`;
        } catch (error) {
          if (error instanceof AutoMergeHeadChangedError) {
            const withdrawal = await this.withdrawUnsafeStandaloneReadiness({
              target,
              config,
              reason: error.message
            });
            effectiveReady = !withdrawal.removed;
            text += `
${withdrawal.text}`;
          } else {
            const failure = autoMergeFailureText({ error });
            this.deps.log(`auto-merge failed for ${targetKey(target)}: ${error}`);
            text += `
${failure}`;
          }
        }
      }
    }
    this.notifyReadyChanged({ target, ready: effectiveReady, watched: false, config });
    return { text, ready: { target, ready: effectiveReady, watched: false } };
  }
  async withdrawUnsafeStandaloneReadiness({
    target,
    config,
    reason
  }) {
    const canceled = `Auto-merge canceled because ${reason}.`;
    try {
      const removed = await removeReadyForHumanReview(this.deps.runGh, target, config.readyLabel);
      return { text: `${canceled} ${removed}`, removed: true };
    } catch (error) {
      this.deps.log(`unsafe standalone readiness cleanup failed for ${targetKey(target)}: ${error}`);
      return {
        text: `${canceled} WARNING: label "${config.readyLabel}" could not be removed (${error instanceof Error ? error.message : String(error)}); remove it manually before reassessing the PR.`,
        removed: false
      };
    }
  }
  fetchSnapshot({ target, config }) {
    return fetchPrSnapshot({
      runGh: this.deps.runGh,
      target,
      ignoreTag: config.ignoreCommentTag,
      selfLogin: this.selfLogin
    });
  }
  notifyWatchChanged(event) {
    try {
      this.deps.onWatchChanged?.(event);
    } catch (error) {
      this.deps.log(`watch ${event.type} observer failed for ${targetKey(event.target)}: ${error}`);
    }
  }
  notifyTickSettled(event) {
    try {
      this.deps.onTickSettled?.(event);
    } catch (error) {
      this.deps.log(`tick observer failed for ${targetKey(event.target)}: ${error}`);
    }
  }
  notifyReadyChanged(event) {
    try {
      this.deps.onReadyChanged?.(event);
    } catch (error) {
      this.deps.log(`ready-state observer failed for ${targetKey(event.target)}: ${error}`);
    }
  }
};

// runtime/node-gh.ts
import { execFile } from "node:child_process";
function createNodeGhRunner() {
  return (args) => new Promise((resolve2, reject) => {
    execFile("gh", args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || error.message;
        const notFound = /could not resolve to|not found|404/i.test(message) && !/could not resolve host/i.test(message);
        const exitCode = typeof error.code === "number" || typeof error.code === "string" ? error.code : void 0;
        reject(new PollError(message, { notFound, httpStatus: ghHttpStatus({ message }), exitCode }));
        return;
      }
      resolve2(stdout);
    });
  });
}

// hermes/src/worker.ts
var description = buildMonitorToolDescription({
  delivery: "Background monitoring requires Hermes Desktop/TUI: reports start a turn in the owning conversation when idle and inject into its active turn when busy. Standalone mark_ready/unmark_ready actions need no background-delivery route and work on other Hermes hosts.",
  configPath: "repository .pr-monitor.json, then .hermes/pr-monitor.json, then .opencode/pr-monitor.json",
  lifecycle: "Watches stop on conversation finalization, plugin unload, or host exit; restart them after a restart.",
  waiting: "When nothing remains to handle, end the turn; never create a waiter."
});
var schema = {
  name: "pr_monitor",
  description,
  parameters: { type: "object", properties: {
    action: { type: "string", enum: MONITOR_ACTION_VALUES },
    pr: { type: "string", description: "Explicit owner/repo#123 or GitHub PR URL; all only for stop/flush." }
  }, required: ["action"], additionalProperties: false }
};
if (process.argv.includes("--describe")) {
  console.log(JSON.stringify(schema, null, 2));
} else {
  const log = (message) => console.error(`[pr-monitor] ${message}`);
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  let sequence = 0;
  let closed = false;
  const pending = /* @__PURE__ */ new Map();
  const deliver = ({ report }) => new Promise((accept, reject) => {
    if (closed) {
      reject(new Error("Hermes bridge closed"));
      return;
    }
    const id = ++sequence;
    pending.set(id, { resolve: accept, reject });
    send({ type: "report", id, report });
  });
  const loadConfig = (cwd) => loadMonitorConfig({ paths: [
    resolve(cwd, ".pr-monitor.json"),
    resolve(cwd, ".hermes/pr-monitor.json"),
    resolve(cwd, ".opencode/pr-monitor.json")
  ], log });
  const session = new MonitorSession({ runGh: createNodeGhRunner(), log });
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    for (const callback of pending.values()) callback.reject(new Error("Hermes bridge closed"));
    pending.clear();
    await session.stopAll({});
    process.exit(0);
  };
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log("invalid bridge JSON");
      return;
    }
    if (message.type === "ack") {
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.ok === true) callback.resolve();
      else callback.reject(new Error(typeof message.error === "string" ? message.error : "Hermes rejected report"));
      return;
    }
    if (message.type !== "command" || closed) return;
    const id = message.id;
    if (!MONITOR_ACTION_VALUES.includes(message.action) || message.pr !== void 0 && typeof message.pr !== "string" || typeof message.cwd !== "string" || !isAbsolute2(message.cwd)) {
      send({ type: "result", id, error: "Invalid monitor action or PR" });
      return;
    }
    void session.execute({
      action: message.action,
      pr: message.pr,
      loadConfig: () => loadConfig(message.cwd),
      start: { announcementMode: "background" /* background */, createChannel: () => ({ deliver }) }
    }).then(
      (result) => send({ type: "result", id, text: result.text + (result.start ? `
Agent replies must begin with ${JSON.stringify(result.start.config.ignoreCommentTag)}. Assess current-head checks, automated reviews and feedback immediately; empty fresh results do not establish readiness.` : "") }),
      (error) => send({ type: "result", id, error: String(error) })
    );
  });
  input.on("close", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}
