import assert from "node:assert/strict"
import test from "node:test"

import { detectActivity, hasNewCiFailure, hasNewMergeConflict } from "../core/activity"
import { loadMonitorConfig, type WatchConfig } from "../core/config"
import {
  fetchPrSnapshot,
  ghHttpStatus,
  normalizeSnapshot,
  PollError,
  type CommentMeta,
  type PrSnapshot,
  type ReviewThreadInfo,
} from "../core/github"
import {
  assessAutomaticReadiness,
  hasAcknowledgementRegression,
  hasReadyLabel,
} from "../core/readiness"
import { buildReport } from "../core/report"
import type { Target } from "../core/target"
import { PrWatch } from "../core/watch"

const target: Target = { owner: "sesori", repo: "example", number: 42 }

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    title: "test PR",
    url: "https://github.com/sesori/example/pull/42",
    state: "OPEN",
    mergeable: "MERGEABLE",
    headSha: "head-1",
    checks: [],
    reviews: [],
    reviewSummaries: [],
    pendingReviewers: [],
    reviewThreads: [],
    issueCommentsTotal: 0,
    issueComments: [],
    labels: [],
    ...overrides,
  }
}

function thread(
  id: string,
  isResolved: boolean,
  comments: Array<{
    author: string
    createdAt: string
    isBot?: boolean
    isLocal?: boolean
    isAgentReply?: boolean
    reviewState?: string
  }>,
  location: { path?: string; line?: number } = {},
): ReviewThreadInfo {
  return {
    id,
    isResolved,
    ...location,
    comments: comments.map((comment, index) => ({
      id: `${id}-comment-${index + 1}`,
      isBot: false,
      isLocal: false,
      isAgentReply: false,
      ...comment,
    })),
  }
}

function config(overrides: Partial<WatchConfig> = {}): WatchConfig {
  return {
    debounceMinutes: 2,
    maxCiWaitMinutes: 30,
    pollIntervalSeconds: 60,
    ignoreCommentTag: undefined,
    announceOnStart: true,
    flushOnCiFailure: true,
    ...overrides,
  }
}

function watchHarness(
  initial: PrSnapshot,
  polled: PrSnapshot[],
  cfg: WatchConfig = config({ announceOnStart: false }),
  opts: {
    deliveryFailures?: number
    readiness?: boolean
    readinessFailures?: number
    autoMerge?: boolean
    autoMergeFailures?: number
  } = {},
) {
  let now = Date.parse("2026-08-03T12:00:00Z")
  let index = 0
  let remainingDeliveryFailures = opts.deliveryFailures ?? 0
  let remainingReadinessFailures = opts.readinessFailures ?? 0
  let remainingAutoMergeFailures = opts.autoMergeFailures ?? 0
  let deliveryAttempts = 0
  const reports: string[] = []
  const persisted: string[] = []
  const readyChanges: boolean[] = []
  const readyObservations: boolean[] = []
  const autoMerges: Array<{ title: string; headSha: string }> = []
  const watch = new PrWatch({
    target,
    config: cfg,
    initial,
    deps: {
      now: () => now,
      fetchSnapshot: async () => polled[Math.min(index++, polled.length - 1)]!,
      deliver: async (report) => {
        deliveryAttempts += 1
        if (remainingDeliveryFailures > 0) {
          remainingDeliveryFailures -= 1
          throw new Error("delivery failed")
        }
        reports.push(report)
      },
      persist: async (report) => {
        persisted.push(report)
      },
      log: () => {},
      onStopped: () => {},
      readiness: opts.readiness
        ? {
            label: "ready-for-human-review",
            replyPrefix: "[Agent reply]",
            change: async (ready) => {
              readyChanges.push(ready)
              if (remainingReadinessFailures > 0) {
                remainingReadinessFailures -= 1
                throw new Error("label mutation failed")
              }
              return ready ? "ready added" : "ready removed"
            },
            onChanged: (ready) => readyObservations.push(ready),
          }
        : undefined,
      autoMerge: opts.autoMerge
        ? {
            squashMerge: async ({ pullRequest }) => {
              autoMerges.push(pullRequest)
              if (remainingAutoMergeFailures > 0) {
                remainingAutoMergeFailures -= 1
                throw new Error("merge rejected")
              }
              return "Auto-merge succeeded: squash merge complete."
            },
          }
        : undefined,
    },
  })
  return {
    watch,
    reports,
    persisted,
    readyChanges,
    readyObservations,
    autoMerges,
    get deliveryAttempts() {
      return deliveryAttempts
    },
    advance(ms: number) {
      now += ms
    },
  }
}

test("GitHub CLI HTTP status metadata is parsed without misclassifying transport failures", () => {
  assert.equal(ghHttpStatus({ message: "gh: Pull Request is not mergeable (HTTP 405)" }), 405)
  assert.equal(ghHttpStatus({ message: "HTTP 409: Conflict" }), 409)
  assert.equal(ghHttpStatus({ message: "could not resolve host: api.github.com" }), undefined)
})

test("the default debounce is two minutes", async () => {
  const loaded = await loadMonitorConfig({ paths: [], globalPaths: [], environment: {}, log: () => {} })
  assert.equal(loaded.debounceMinutes, 2)
  assert.equal(loaded.ignoreCommentTag, "<!-- pr-monitor:reply -->")
  assert.equal(loaded.autoMerge, false)
})

test("ready-label matching follows GitHub's case-insensitive label identity", () => {
  assert.equal(hasReadyLabel(snapshot({ labels: ["Ready-For-Human-Review"] }), "ready-for-human-review"), true)
})

test("automatic readiness accepts deliberately unresolved threads after a prefixed local reply", () => {
  const result = assessAutomaticReadiness(
    snapshot({
      checks: [{ name: "tests", outcome: "success" }],
      reviews: [{ login: "reviewer", state: "CHANGES_REQUESTED", submittedAt: "2026-08-03T11:00:00Z" }],
      reviewSummaries: [
        {
          id: "review-summary",
          author: "reviewer",
          isBot: false,
          createdAt: "2026-08-03T11:02:00Z",
          isLocal: false,
          isAgentReply: false,
        },
      ],
      pendingReviewers: ["another-reviewer"],
      reviewThreads: [
        thread("thread-1", false, [
          { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
          {
            author: "owner",
            createdAt: "2026-08-03T11:05:00Z",
            isLocal: true,
            isAgentReply: true,
          },
        ]),
      ],
      issueCommentsTotal: 1,
      issueComments: [
        {
          id: "issue-feedback",
          author: "reviewer",
          isBot: false,
          createdAt: "2026-08-03T11:01:00Z",
          isLocal: false,
          isAgentReply: false,
        },
        {
          id: "issue-reply",
          author: "owner",
          isBot: false,
          createdAt: "2026-08-03T11:06:00Z",
          isLocal: true,
          isAgentReply: true,
        },
      ],
    }),
  )

  assert.equal(result.eligible, true)
  assert.deepEqual(result.blockers, [])
})

test("automatic readiness conservatively blocks mixed same-second cross-channel feedback", () => {
  const sameTime = "2026-08-03T11:00:00Z"
  const mixed = assessAutomaticReadiness(
    snapshot({
      issueComments: [
        {
          id: "issue-reply",
          author: "owner",
          isBot: false,
          createdAt: sameTime,
          isLocal: true,
          isAgentReply: true,
        },
      ],
      reviewSummaries: [
        {
          id: "review-feedback",
          author: "reviewer",
          isBot: false,
          createdAt: sameTime,
          isLocal: false,
          isAgentReply: false,
        },
      ],
    }),
  )
  const emptyThread = assessAutomaticReadiness(
    snapshot({ reviewThreads: [thread("empty-thread", false, [])] }),
  )
  const acknowledged = assessAutomaticReadiness(
    snapshot({
      issueComments: [
        {
          id: "issue-reply",
          author: "owner",
          isBot: false,
          createdAt: sameTime,
          isLocal: true,
          isAgentReply: true,
        },
      ],
      reviewSummaries: [
        {
          id: "review-reply",
          author: "owner",
          isBot: false,
          createdAt: sameTime,
          isLocal: true,
          isAgentReply: true,
        },
      ],
    }),
  )

  assert.equal(mixed.eligible, false)
  assert.equal(mixed.awaitingUnthreadedReply, true)
  assert.equal(emptyThread.eligible, false)
  assert.equal(emptyThread.awaitingThreadReplies, 1)
  assert.equal(acknowledged.eligible, true)
})

test("startup observes readiness without auto-labelling empty or completed snapshots", async () => {
  for (const initial of [snapshot(), snapshot({ checks: [{ name: "tests", outcome: "success" }] })]) {
    for (const announceOnStart of [true, false]) {
      const harness = watchHarness(initial, [initial], config({ announceOnStart }), { readiness: true })
      await harness.watch.initializeReadiness()
      if (announceOnStart) await harness.watch.announceInitial()
      harness.advance(10 * 60_000)
      await harness.watch.tick()
      await harness.watch.manualFlush()
      assert.deepEqual(harness.readyChanges, [])
      if (announceOnStart) {
        assert.match(harness.reports[0]!, /Ready for human review: NO/)
        assert.match(harness.reports[0]!, /Startup\/restart assessment/)
      }
    }
  }
})

test("a restarted monitor can hand off a settled PR immediately after agent assessment", async () => {
  const initial = snapshot({ checks: [{ name: "tests", outcome: "success" }] })
  const harness = watchHarness(initial, [initial], config(), { readiness: true })
  await harness.watch.announceInitial()
  assert.deepEqual(harness.readyChanges, [])
  await harness.watch.manualSetReady(true)
  assert.deepEqual(harness.readyChanges, [true])
  assert.equal(harness.readyObservations.at(-1), true)
})

test("startup preserves an existing ready label and retries delivery without auto-labelling", async () => {
  const accepted = snapshot({ labels: ["ready-for-human-review"] })
  const existing = watchHarness(accepted, [accepted], config(), { readiness: true })
  await existing.watch.initializeReadiness()
  await existing.watch.announceInitial()
  assert.deepEqual(existing.readyChanges, [])
  assert.match(existing.reports[0]!, /Ready for human review: YES/)

  const initial = snapshot()
  const retry = watchHarness(initial, [initial], config(), { readiness: true, deliveryFailures: 1 })
  await retry.watch.announceInitial()
  await retry.watch.tick()
  assert.deepEqual(retry.readyChanges, [])
  assert.match(retry.reports[0]!, /Startup\/restart assessment/)
})

test("startup delivery retries still auto-label when CI finishes or feedback is handled", async () => {
  const comment = { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" }
  const cases = [
    [
      snapshot({ checks: [{ name: "tests", outcome: "pending" }] }),
      snapshot({ checks: [{ name: "tests", outcome: "success" }] }),
    ],
    [
      snapshot({ reviewThreads: [thread("thread-1", false, [comment])] }),
      snapshot({
        reviewThreads: [thread("thread-1", false, [
          comment,
          { author: "owner", createdAt: "2026-08-03T12:01:00Z", isLocal: true, isAgentReply: true },
        ])],
      }),
    ],
  ] as const
  for (const [initial, changed] of cases) {
    for (const manual of [false, true]) {
      const harness = watchHarness(initial, [changed], config(), { readiness: true, deliveryFailures: 1 })
      assert.equal(await harness.watch.announceInitial(), false)
      let report: string
      if (manual) {
        report = await harness.watch.manualFlush()
      } else {
        await harness.watch.tick()
        report = harness.reports[0]!
      }
      assert.deepEqual(harness.readyChanges, [true])
      assert.match(report, /Ready for human review: YES/)
    }
  }
})

test("checks completing after startup still trigger automatic readiness", async () => {
  const initial = snapshot({ checks: [{ name: "tests", outcome: "pending" }] })
  const passed = snapshot({ checks: [{ name: "tests", outcome: "success" }] })
  const harness = watchHarness(initial, [passed, passed], config(), { readiness: true })
  await harness.watch.announceInitial()
  await harness.watch.tick()
  harness.advance(2 * 60_000)
  await harness.watch.tick()
  assert.deepEqual(harness.readyChanges, [true])
  assert.match(harness.reports.at(-1)!, /Ready for human review: YES/)
})

test("new bot feedback on an existing unresolved thread urgently withdraws readiness", async () => {
  const acknowledged = thread("thread-1", false, [
    { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
    {
      author: "owner",
      createdAt: "2026-08-03T11:05:00Z",
      isLocal: true,
      isAgentReply: true,
    },
  ])
  const followUp = thread("thread-1", false, [
    ...acknowledged.comments.map(({ id: _id, ...comment }) => comment),
    { author: "review-bot", createdAt: "2026-08-03T12:01:00Z", isBot: true },
  ])
  const initial = snapshot({ labels: ["ready-for-human-review"], reviewThreads: [acknowledged] })
  const changed = snapshot({ labels: ["ready-for-human-review"], reviewThreads: [followUp] })
  const harness = watchHarness(initial, [changed], config({ announceOnStart: false }), { readiness: true })

  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [false])
  assert.equal(harness.reports.length, 1)
  assert.match(harness.reports[0]!, /ACTION REQUIRED: 1 thread received 1 new relevant comment/)
  assert.match(harness.reports[0]!, /unresolved-thread count is unchanged at 1/)
  assert.match(harness.reports[0]!, /Ready for human review: NO/)
})

test("deleting the latest prefixed reply urgently withdraws readiness", async () => {
  const feedback = {
    author: "reviewer",
    createdAt: "2026-08-03T11:00:00Z",
  }
  const reply = {
    author: "owner",
    createdAt: "2026-08-03T11:05:00Z",
    isLocal: true,
    isAgentReply: true,
  }
  const initial = snapshot({
    labels: ["ready-for-human-review"],
    reviewThreads: [thread("thread-1", false, [feedback, reply])],
  })
  const changed = snapshot({
    labels: ["ready-for-human-review"],
    reviewThreads: [thread("thread-1", false, [feedback])],
  })
  const edited = snapshot({
    labels: ["ready-for-human-review"],
    reviewThreads: [thread("thread-1", false, [feedback, { ...reply, isAgentReply: false }])],
  })
  const agentOnly = snapshot({
    reviewThreads: [thread("thread-2", false, [reply])],
  })
  const emptied = snapshot({
    reviewThreads: [thread("thread-2", false, [])],
  })
  const harness = watchHarness(initial, [changed], config({ announceOnStart: false }), { readiness: true })

  assert.equal(hasAcknowledgementRegression(initial, edited), true)
  assert.equal(hasAcknowledgementRegression(agentOnly, emptied), true)
  assert.equal(hasAcknowledgementRegression(snapshot(), emptied), true)
  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [false])
  assert.match(harness.reports[0]!, /Ready for human review: NO/)
  assert.match(harness.reports[0]!, /1 review thread awaits a prefixed reply/)
})

test("new review-summary feedback withdraws readiness even when its review is approving", async () => {
  const initial = snapshot({ labels: ["ready-for-human-review"] })
  const changed = snapshot({
    labels: ["ready-for-human-review"],
    reviews: [{ login: "review-bot", state: "APPROVED", submittedAt: "2026-08-03T12:01:00Z" }],
    reviewSummaries: [
      {
        id: "review-summary",
        author: "review-bot",
        isBot: true,
        createdAt: "2026-08-03T12:01:00Z",
        isLocal: false,
        isAgentReply: false,
      },
    ],
  })
  const harness = watchHarness(initial, [changed], config({ announceOnStart: false }), { readiness: true })

  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [false])
  assert.match(harness.reports[0]!, /\[comment:review\] ACTION REQUIRED: 1 new relevant review summary/)
})

test("manual flush reports withdrawal before restoring already-acknowledged feedback", async () => {
  const initialThread = thread("thread-1", false, [
    {
      author: "owner",
      createdAt: "2026-08-03T11:00:00Z",
      isLocal: true,
      isAgentReply: true,
    },
  ])
  const changedThread = thread("thread-1", false, [
    {
      author: "owner",
      createdAt: "2026-08-03T11:00:00Z",
      isLocal: true,
      isAgentReply: true,
    },
    { author: "reviewer", createdAt: "2026-08-03T11:05:00Z" },
    {
      author: "owner",
      createdAt: "2026-08-03T11:06:00Z",
      isLocal: true,
      isAgentReply: true,
    },
  ])
  const initial = snapshot({ labels: ["ready-for-human-review"], reviewThreads: [initialThread] })
  const changed = snapshot({ labels: ["ready-for-human-review"], reviewThreads: [changedThread] })
  const harness = watchHarness(initial, [changed], config({ announceOnStart: false }), { readiness: true })

  const report = await harness.watch.manualFlush()

  assert.deepEqual(harness.readyChanges, [false])
  assert.match(report, /Ready for human review: NO/)
})

test("manual readiness accepts current bot feedback but later feedback withdraws it", async () => {
  const first = thread("thread-1", false, [
    { author: "review-bot", createdAt: "2026-08-03T11:00:00Z", isBot: true },
  ])
  const second = thread("thread-1", false, [
    { author: "review-bot", createdAt: "2026-08-03T11:00:00Z", isBot: true },
    { author: "review-bot", createdAt: "2026-08-03T12:01:00Z", isBot: true },
  ])
  const initial = snapshot({ mergeable: "CONFLICTING", reviewThreads: [first] })
  const accepted = snapshot({
    mergeable: "CONFLICTING",
    labels: ["ready-for-human-review"],
    reviewThreads: [first],
  })
  const later = snapshot({
    mergeable: "CONFLICTING",
    labels: ["ready-for-human-review"],
    reviewThreads: [second],
  })
  const harness = watchHarness(initial, [accepted, later], config({ announceOnStart: false }), { readiness: true })

  await harness.watch.manualSetReady(true)
  await harness.watch.tick()
  assert.deepEqual(harness.readyChanges, [true])
  assert.equal(harness.reports.length, 0)

  await harness.watch.tick()
  assert.deepEqual(harness.readyChanges, [true, false])
  assert.match(harness.reports[0]!, /Ready for human review: NO/)
})

test("failed automatic withdrawal is reported and retried without losing feedback", async () => {
  const initialThread = thread("thread-1", false, [
    {
      author: "owner",
      createdAt: "2026-08-03T11:00:00Z",
      isLocal: true,
      isAgentReply: true,
    },
  ])
  const changedThread = thread("thread-1", false, [
    {
      author: "owner",
      createdAt: "2026-08-03T11:00:00Z",
      isLocal: true,
      isAgentReply: true,
    },
    { author: "reviewer", createdAt: "2026-08-03T12:01:00Z" },
  ])
  const initial = snapshot({ labels: ["ready-for-human-review"], reviewThreads: [initialThread] })
  const changed = snapshot({ labels: ["ready-for-human-review"], reviewThreads: [changedThread] })
  const harness = watchHarness(
    initial,
    [changed, changed],
    config({ announceOnStart: false }),
    { readiness: true, readinessFailures: 1 },
  )

  await harness.watch.tick()
  assert.match(harness.reports[0]!, /Readiness automation failed: could not remove label/)
  assert.match(harness.reports[0]!, /Ready for human review: YES/)

  await harness.watch.tick()
  assert.deepEqual(harness.readyChanges, [false, false])
  assert.match(harness.reports[1]!, /Ready for human review: NO/)
  assert.doesNotMatch(harness.reports[1]!, /Readiness automation failed/)
})

test("an ambiguously failed auto-add cannot accept newer feedback when its label appears", async () => {
  const initial = snapshot({ checks: [{ name: "tests", outcome: "pending" }] })
  const passed = snapshot({ checks: [{ name: "tests", outcome: "success" }] })
  const changed = snapshot({
    labels: ["ready-for-human-review"],
    reviewThreads: [
      thread("thread-1", false, [
        { author: "reviewer", createdAt: "2026-08-03T12:01:00Z" },
      ]),
    ],
  })
  const harness = watchHarness(
    initial,
    [passed, passed, changed],
    config({ announceOnStart: false }),
    { readiness: true, readinessFailures: 1 },
  )

  await harness.watch.tick()
  harness.advance(2 * 60_000)
  await harness.watch.tick()
  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [true, false])
  assert.match(harness.reports.at(-1)!, /Ready for human review: NO/)
  assert.match(harness.reports.at(-1)!, /ACTION REQUIRED/)
})

test("a ready label observed after failed auto-add does not authorize auto-merge", async () => {
  const initial = snapshot({ checks: [{ name: "tests", outcome: "pending" }] })
  const passed = snapshot({ checks: [{ name: "tests", outcome: "success" }] })
  const observedReady = snapshot({
    checks: [{ name: "tests", outcome: "success" }],
    labels: ["ready-for-human-review"],
  })
  const harness = watchHarness(
    initial,
    [passed, passed, observedReady],
    config({ announceOnStart: false }),
    { readiness: true, readinessFailures: 1, autoMerge: true },
  )

  await harness.watch.tick()
  harness.advance(2 * 60_000)
  await harness.watch.tick()
  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [true])
  assert.deepEqual(harness.autoMerges, [])
  assert.match(harness.reports.at(-1)!, /Ready for human review: YES/)
  assert.doesNotMatch(harness.reports.at(-1)!, /Auto-merge succeeded/)
})

test("stopping a watch fences queued flush and ready mutations", async () => {
  let resolveFetch!: (snapshot: PrSnapshot) => void
  let announceFetch!: () => void
  const fetchStarted = new Promise<void>((resolve) => {
    announceFetch = resolve
  })
  const fetched = new Promise<PrSnapshot>((resolve) => {
    resolveFetch = resolve
  })
  const readyChanges: boolean[] = []
  const initial = snapshot({ mergeable: "UNKNOWN" })
  const watch = new PrWatch({
    target,
    config: config({ announceOnStart: false }),
    initial,
    deps: {
      now: () => Date.parse("2026-08-03T12:00:00Z"),
      fetchSnapshot: () => {
        announceFetch()
        return fetched
      },
      deliver: async () => {},
      log: () => {},
      onStopped: () => {},
      readiness: {
        label: "ready-for-human-review",
        replyPrefix: "[Agent reply]",
        change: async (ready) => {
          readyChanges.push(ready)
          return "changed"
        },
        onChanged: () => {},
      },
    },
  })

  const flushing = watch.manualFlush()
  await fetchStarted
  const marking = watch.manualSetReady(true)
  watch.stop()
  resolveFetch(initial)

  assert.match(await flushing, /flush skipped — monitor stopped/)
  await assert.rejects(marking, /monitor stopped before the ready action could run/)
  assert.deepEqual(readyChanges, [])
})

test("stop cleanup does not wait for a stalled non-mutation operation", async () => {
  let resolveFetch!: (snapshot: PrSnapshot) => void
  let announceFetch!: () => void
  const fetchStarted = new Promise<void>((resolve) => {
    announceFetch = resolve
  })
  const fetched = new Promise<PrSnapshot>((resolve) => {
    resolveFetch = resolve
  })
  let stopped = false
  const initial = snapshot()
  const watch = new PrWatch({
    target,
    config: config({ announceOnStart: false }),
    initial,
    deps: {
      now: () => Date.parse("2026-08-03T12:00:00Z"),
      fetchSnapshot: () => {
        announceFetch()
        return fetched
      },
      deliver: async () => {},
      log: () => {},
      onStopped: () => {
        stopped = true
      },
    },
  })

  const flushing = watch.manualFlush()
  await fetchStarted
  watch.stop()
  await watch.waitUntilStopped()

  assert.equal(stopped, true)
  resolveFetch(initial)
  assert.match(await flushing, /flush skipped — monitor stopped/)
})

test("stop notices reflect a label mutation that finished while the watch drained", async () => {
  let releaseMutation!: () => void
  let announceMutation!: () => void
  const mutationStarted = new Promise<void>((resolve) => {
    announceMutation = resolve
  })
  const mutationGate = new Promise<void>((resolve) => {
    releaseMutation = resolve
  })
  const initial = snapshot({ mergeable: "UNKNOWN" })
  const watch = new PrWatch({
    target,
    config: config({ announceOnStart: false }),
    initial,
    deps: {
      now: () => Date.parse("2026-08-03T12:00:00Z"),
      fetchSnapshot: async () => initial,
      deliver: async () => {},
      log: () => {},
      onStopped: () => {},
      readiness: {
        label: "ready-for-human-review",
        replyPrefix: "[Agent reply]",
        change: async () => {
          announceMutation()
          await mutationGate
          return "changed"
        },
        onChanged: () => {},
      },
    },
  })

  const marking = watch.manualSetReady(true)
  await mutationStarted
  watch.stop()
  releaseMutation()
  await marking
  await watch.waitUntilStopped()

  assert.match(watch.stopNotice("Monitor stopped for test."), /Ready for human review: YES/)
})

test("a new CI-less head withdraws readiness and restores it after quiet", async () => {
  const initial = snapshot({ labels: ["ready-for-human-review"], headSha: "head-1" })
  const pushed = snapshot({ labels: ["ready-for-human-review"], headSha: "head-2" })
  const observedUnready = snapshot({ labels: [], headSha: "head-2" })
  const harness = watchHarness(
    initial,
    [pushed, observedUnready],
    config({ announceOnStart: false }),
    { readiness: true },
  )

  await harness.watch.tick()
  assert.deepEqual(harness.readyChanges, [false])
  assert.match(harness.reports[0]!, /Ready for human review: NO/)

  harness.advance(2 * 60_000)
  await harness.watch.tick()
  assert.deepEqual(harness.readyChanges, [false, true])
  assert.match(harness.reports[1]!, /Ready for human review: YES/)
})

test("automatic readiness triggers one title-only auto-merge attempt for the accepted head", async () => {
  const initial = snapshot({ checks: [{ name: "tests", outcome: "pending" }] })
  const passed = snapshot({
    title: "Accepted title",
    headSha: "accepted-head",
    checks: [{ name: "tests", outcome: "success" }],
  })
  const observedReady = snapshot({
    ...passed,
    labels: ["ready-for-human-review"],
  })
  const harness = watchHarness(
    initial,
    [passed, passed, observedReady],
    config({ announceOnStart: false }),
    { readiness: true, autoMerge: true },
  )

  await harness.watch.tick()
  harness.advance(2 * 60_000)
  await harness.watch.tick()
  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [true])
  assert.deepEqual(harness.autoMerges, [{ title: "Accepted title", headSha: "accepted-head" }])
  assert.match(harness.reports[0]!, /Auto-merge: ENABLED/)
  assert.match(harness.reports[0]!, /Auto-merge succeeded/)
})

test("an externally observed ready label does not trigger auto-merge", async () => {
  const initial = snapshot()
  const externallyReady = snapshot({ labels: ["ready-for-human-review"] })
  const harness = watchHarness(initial, [externallyReady], config({ announceOnStart: false }), {
    readiness: true,
    autoMerge: true,
  })

  await harness.watch.tick()

  assert.deepEqual(harness.readyObservations, [true])
  assert.deepEqual(harness.autoMerges, [])
})

test("failed automatic merge keeps readiness and is not retried on later polls", async () => {
  const initial = snapshot({ checks: [{ name: "tests", outcome: "pending" }] })
  const passed = snapshot({ checks: [{ name: "tests", outcome: "success" }] })
  const observedReady = snapshot({
    checks: [{ name: "tests", outcome: "success" }],
    labels: ["ready-for-human-review"],
  })
  const harness = watchHarness(
    initial,
    [passed, passed, observedReady],
    config({ announceOnStart: false }),
    { readiness: true, autoMerge: true, autoMergeFailures: 1 },
  )

  await harness.watch.tick()
  harness.advance(2 * 60_000)
  await harness.watch.tick()
  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [true])
  assert.equal(harness.autoMerges.length, 1)
  assert.match(harness.reports[0]!, /Auto-merge failed after the ready label was added/)
  assert.match(harness.reports[0]!, /no automatic retry will occur/)
  assert.match(harness.reports[0]!, /Ready for human review: YES/)
})

test("manual readiness triggers auto-merge and returns its result", async () => {
  const initial = snapshot({ title: "Manual title", headSha: "manual-head", mergeable: "UNKNOWN" })
  const harness = watchHarness(initial, [initial], config({ announceOnStart: false }), {
    readiness: true,
    autoMerge: true,
  })

  const result = await harness.watch.manualSetReady(true)

  assert.match(result, /ready added/)
  assert.match(result, /Auto-merge succeeded/)
  assert.deepEqual(harness.autoMerges, [{ title: "Manual title", headSha: "manual-head" }])
})

test("manual readiness clears an undelivered automatic merge notice", async () => {
  const initial = snapshot({ checks: [{ name: "tests", outcome: "pending" }] })
  const passed = snapshot({
    title: "Accepted title",
    headSha: "accepted-head",
    checks: [{ name: "tests", outcome: "success" }],
  })
  const harness = watchHarness(
    initial,
    [passed, passed],
    config({ announceOnStart: false }),
    { readiness: true, autoMerge: true, autoMergeFailures: 1, deliveryFailures: 1 },
  )

  await harness.watch.tick()
  harness.advance(120_001)
  await harness.watch.tick()
  const manualResult = await harness.watch.manualSetReady(true)
  const stopNotice = harness.watch.stopNotice("Monitor stopped for test.")

  assert.match(manualResult, /Auto-merge succeeded/)
  assert.doesNotMatch(stopNotice, /Auto-merge failed|merge rejected/)
})

test("external removal plus feedback reports unready before an acknowledged restore", async () => {
  const initialThread = thread("thread-1", false, [
    {
      author: "owner",
      createdAt: "2026-08-03T11:00:00Z",
      isLocal: true,
      isAgentReply: true,
    },
  ])
  const changedThread = thread("thread-1", false, [
    {
      author: "owner",
      createdAt: "2026-08-03T11:00:00Z",
      isLocal: true,
      isAgentReply: true,
    },
    { author: "reviewer", createdAt: "2026-08-03T11:05:00Z" },
    {
      author: "owner",
      createdAt: "2026-08-03T11:06:00Z",
      isLocal: true,
      isAgentReply: true,
    },
  ])
  const initial = snapshot({ labels: ["ready-for-human-review"], reviewThreads: [initialThread] })
  const changed = snapshot({ labels: [], reviewThreads: [changedThread] })
  const harness = watchHarness(initial, [changed], config({ announceOnStart: false }), { readiness: true })

  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [])
  assert.match(harness.reports[0]!, /Ready for human review: NO/)
  assert.match(harness.reports[0]!, /ACTION REQUIRED/)
})

test("external label removal creates no hold and automatic readiness restores it", async () => {
  const initial = snapshot({ labels: ["ready-for-human-review"] })
  const removed = snapshot({ labels: [] })
  const harness = watchHarness(initial, [removed, removed], config({ announceOnStart: false }), { readiness: true })

  await harness.watch.tick()
  assert.deepEqual(harness.readyChanges, [])
  harness.advance(2 * 60_000)
  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [true])
  assert.match(harness.reports[0]!, /Ready for human review: YES/)
})

test("thread resolution reports activity without withdrawing readiness", async () => {
  const comments = [
    { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
    {
      author: "owner",
      createdAt: "2026-08-03T11:05:00Z",
      isLocal: true,
      isAgentReply: true,
    },
  ]
  const initial = snapshot({
    labels: ["ready-for-human-review"],
    reviewThreads: [thread("thread-1", false, comments)],
  })
  const resolved = snapshot({
    labels: ["ready-for-human-review"],
    reviewThreads: [thread("thread-1", true, comments)],
  })
  const harness = watchHarness(initial, [resolved, resolved], config({ announceOnStart: false }), { readiness: true })

  await harness.watch.tick()
  assert.deepEqual(harness.readyChanges, [])
  harness.advance(2 * 60_000)
  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [])
  assert.match(harness.reports[0]!, /Ready for human review: YES/)
})

test("a prefixed local reply can restore automatic readiness after quiet", async () => {
  const initialThread = thread("thread-1", false, [
    { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
  ])
  const repliedThread = thread("thread-1", false, [
    { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
    {
      author: "owner",
      createdAt: "2026-08-03T12:01:00Z",
      isLocal: true,
      isAgentReply: true,
    },
  ])
  const initial = snapshot({ reviewThreads: [initialThread] })
  const replied = snapshot({ reviewThreads: [repliedThread] })
  const harness = watchHarness(initial, [replied, replied], config({ announceOnStart: false }), { readiness: true })

  await harness.watch.tick()
  assert.deepEqual(harness.readyChanges, [])
  harness.advance(2 * 60_000)
  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [true])
  assert.match(harness.reports[0]!, /Ready for human review: YES/)
})

test("a failed initial announcement retries all startup comments", async () => {
  const initial = snapshot({
    reviewThreads: [
      thread("thread-1", false, [
        { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
        { author: "reviewer", createdAt: "2026-08-03T11:01:00Z" },
      ]),
      thread("thread-2", true, [{ author: "alice", createdAt: "2026-08-03T11:02:00Z" }]),
    ],
    issueCommentsTotal: 1,
    issueComments: [
      {
        id: "issue-1",
        author: "owner",
        isBot: false,
        createdAt: "2026-08-03T11:03:00Z",
        isLocal: false,
        isAgentReply: false,
      },
    ],
  })
  const harness = watchHarness(initial, [initial], config(), { deliveryFailures: 1 })

  assert.equal(await harness.watch.announceInitial(), false)
  assert.equal(harness.deliveryAttempts, 1)
  assert.equal(harness.reports.length, 0)

  await harness.watch.tick()
  assert.equal(harness.deliveryAttempts, 2)
  assert.equal(harness.reports.length, 1)
  assert.match(
    harness.reports[0]!,
    /2 threads received 3 new relevant comments since last flush/,
  )
  assert.match(harness.reports[0]!, /\[comment:issue\] 1 total \(1 new relevant since last flush: 1 owner\)/)
})

test("the initial announcement counts toward the delivery-failure limit", async () => {
  const initial = snapshot()
  const harness = watchHarness(initial, Array.from({ length: 9 }, () => initial), config(), {
    deliveryFailures: 10,
  })

  await harness.watch.announceInitial()
  for (let attempt = 1; attempt < 10; attempt += 1) await harness.watch.tick()

  assert.equal(harness.deliveryAttempts, 10)
  assert.equal(harness.watch.isStopped, true)
  assert.equal(harness.persisted.length, 1)
  assert.match(harness.persisted[0]!, /Monitor stopped: 10 consecutive delivery failures/)
})

test("normalization preserves tagged replies as private acknowledgement evidence", () => {
  const payload = {
    data: {
      repository: {
        pullRequest: {
          title: "test PR",
          url: "https://github.com/sesori/example/pull/42",
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: "head-1",
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: {
            nodes: [
              {
                id: "review-bot-summary",
                author: { login: "review-bot", __typename: "Bot" },
                state: "APPROVED",
                submittedAt: "2026-08-03T10:00:00Z",
                body: "The fix is acknowledged.",
                comments: { totalCount: 0 },
              },
              {
                id: "empty-changes-requested",
                author: { login: "reviewer", __typename: "User" },
                state: "CHANGES_REQUESTED",
                submittedAt: "2026-08-03T10:05:00Z",
                body: "",
                comments: { totalCount: 0 },
              },
              {
                id: "empty-commented",
                author: { login: "reviewer-2", __typename: "User" },
                state: "COMMENTED",
                submittedAt: "2026-08-03T10:06:00Z",
                body: "",
                comments: { totalCount: 0 },
              },
            ],
          },
          reviewThreads: {
            nodes: [
              {
                id: "thread-1",
                isResolved: false,
                path: "client/module_core/lib/src/services/new_session_options_service.dart",
                line: 258,
                comments: {
                  nodes: [
                    {
                      id: "comment-1",
                      author: { login: "reviewer", __typename: "User" },
                      body: "Please reconsider this.",
                      createdAt: "2026-08-03T11:00:00Z",
                    },
                    {
                      id: "comment-2",
                      author: { login: "owner", __typename: "User" },
                      body: "[Sesori reply] I do not think this is needed.",
                      createdAt: "2026-08-03T11:05:00Z",
                    },
                    {
                      id: "comment-3",
                      author: { login: "owner", __typename: "User" },
                      body: "Please still address the [Sesori reply] edge case.",
                      createdAt: "2026-08-03T11:10:00Z",
                      pullRequestReview: { state: "PENDING" },
                    },
                  ],
                },
              },
              {
                id: "thread-2",
                isResolved: true,
                comments: {
                  nodes: [
                    {
                      id: "comment-4",
                      author: { login: "alice", __typename: "User" },
                      body: "Follow-up on the resolved thread.",
                      createdAt: "2026-08-03T11:15:00Z",
                    },
                  ],
                },
              },
            ],
          },
          comments: { totalCount: 0, nodes: [] },
          labels: { nodes: [] },
        },
      },
    },
  }

  const result = normalizeSnapshot(payload, { ignoreTag: "[Sesori reply]", selfLogin: "owner" })

  assert.deepEqual(
    result.reviewSummaries.map((comment) => ({
      id: comment.id,
      author: comment.author,
      isBot: comment.isBot,
      isAgentReply: comment.isAgentReply,
    })),
    [
      { id: "review-bot-summary", author: "review-bot", isBot: true, isAgentReply: false },
      { id: "empty-changes-requested", author: "reviewer", isBot: false, isAgentReply: false },
    ],
  )
  assert.equal(result.reviewThreads[0]?.path, "client/module_core/lib/src/services/new_session_options_service.dart")
  assert.equal(result.reviewThreads[0]?.line, 258)
  assert.equal(result.reviewThreads[0]?.comments[2]?.reviewState, "PENDING")
  assert.deepEqual(
    result.reviewThreads.map((item) => ({
      id: item.id,
      isResolved: item.isResolved,
      comments: item.comments.map((comment) => ({
        author: comment.author,
        isLocal: comment.isLocal,
        isAgentReply: comment.isAgentReply,
      })),
    })),
    [
      {
        id: "thread-1",
        isResolved: false,
        comments: [
          { author: "reviewer", isLocal: false, isAgentReply: false },
          { author: "owner", isLocal: true, isAgentReply: true },
          { author: "owner", isLocal: true, isAgentReply: false },
        ],
      },
      {
        id: "thread-2",
        isResolved: true,
        comments: [{ author: "alice", isLocal: false, isAgentReply: false }],
      },
    ],
  )
})

test("fetching a snapshot paginates review threads", async () => {
  const payload = {
    data: {
      repository: {
        pullRequest: {
          title: "test PR",
          url: "https://github.com/sesori/example/pull/42",
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: "head-1",
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { nodes: [] },
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            nodes: [
              {
                id: "thread-1",
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      id: "comment-1",
                      author: { login: "reviewer", __typename: "User" },
                      body: "First page",
                      createdAt: "2026-08-03T11:00:00Z",
                    },
                  ],
                },
              },
            ],
          },
          comments: { totalCount: 0, nodes: [] },
          labels: { nodes: [] },
        },
      },
    },
  }
  const secondPage = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "thread-2",
                isResolved: true,
                comments: {
                  nodes: [
                    {
                      id: "comment-2",
                      author: { login: "alice", __typename: "User" },
                      body: "Second page",
                      createdAt: "2026-08-03T11:05:00Z",
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  }
  const calls: string[][] = []
  const result = await fetchPrSnapshot({
    target,
    ignoreTag: undefined,
    selfLogin: undefined,
    runGh: async (args) => {
      calls.push(args)
      return JSON.stringify(calls.length === 1 ? payload : secondPage)
    },
  })

  assert.deepEqual(result.reviewThreads.map((item) => item.id), ["thread-1", "thread-2"])
  assert.equal(calls.length, 2)
  assert.ok(calls[1]?.includes("cursor=cursor-1"))
})

test("snapshot pagination includes late checks, review summaries, and labels", async () => {
  const initial = {
    data: {
      repository: {
        pullRequest: {
          title: "test PR",
          url: "https://github.com/sesori/example/pull/42",
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: "head-1",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: true, endCursor: "checks-1" },
                      nodes: [
                        {
                          __typename: "CheckRun",
                          id: "check-1",
                          name: "first",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
          reviewRequests: { nodes: [] },
          latestReviews: {
            pageInfo: { hasNextPage: true, endCursor: "reviews-1" },
            nodes: [
              {
                id: "review-1",
                author: { login: "first-reviewer", __typename: "User" },
                state: "COMMENTED",
                submittedAt: "2026-08-03T11:00:00Z",
                body: "First summary",
                comments: { totalCount: 0 },
              },
            ],
          },
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          labels: {
            pageInfo: { hasNextPage: true, endCursor: "labels-1" },
            nodes: [{ name: "first-label" }],
          },
        },
      },
    },
  }
  const pages = {
    checks: {
      data: {
        repository: {
          object: {
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    __typename: "CheckRun",
                    id: "check-2",
                    name: "late failure",
                    status: "COMPLETED",
                    conclusion: "FAILURE",
                  },
                ],
              },
            },
          },
        },
      },
    },
    reviews: {
      data: {
        repository: {
          pullRequest: {
            latestReviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "review-2",
                  author: { login: "late-reviewer", __typename: "User" },
                  state: "CHANGES_REQUESTED",
                  submittedAt: "2026-08-03T11:05:00Z",
                  body: "Late summary",
                  comments: { totalCount: 0 },
                },
              ],
            },
          },
        },
      },
    },
    labels: {
      data: {
        repository: {
          pullRequest: {
            labels: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ name: "ready-for-human-review" }],
            },
          },
        },
      },
    },
  }
  const calls: string[][] = []
  const result = await fetchPrSnapshot({
    target,
    ignoreTag: "[Agent reply]",
    selfLogin: "owner",
    runGh: async (args) => {
      calls.push(args)
      if (calls.length === 1) return JSON.stringify(initial)
      const query = args.find((arg) => arg.startsWith("query=")) ?? ""
      if (query.includes("contexts(first: 100, after")) return JSON.stringify(pages.checks)
      if (query.includes("latestReviews(first: 50, after")) return JSON.stringify(pages.reviews)
      if (query.includes("labels(first: 100, after")) return JSON.stringify(pages.labels)
      throw new Error(`unexpected page query: ${query}`)
    },
  })

  assert.deepEqual(result.checks.map((check) => check.id), ["check-1", "check-2"])
  assert.ok(calls[1]?.includes("head=head-1"))
  assert.equal(calls[1]?.some((arg) => arg.startsWith("number=")), false)
  assert.deepEqual(result.reviewSummaries.map((comment) => comment.id), ["review-1", "review-2"])
  assert.deepEqual(result.labels, ["first-label", "ready-for-human-review"])
  assert.equal(calls.length, 4)
})

test("partial GraphQL responses are rejected before readiness assessment", async () => {
  const partial = {
    errors: [{ message: "check contexts could not be resolved", type: "NOT_FOUND" }],
    data: {
      repository: {
        pullRequest: {
          title: "test PR",
          url: "https://github.com/sesori/example/pull/42",
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: "head-1",
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { nodes: [] },
          reviewThreads: { nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          labels: { nodes: [] },
        },
      },
    },
  }

  await assert.rejects(
    fetchPrSnapshot({
      target,
      ignoreTag: undefined,
      selfLogin: undefined,
      runGh: async () => JSON.stringify(partial),
    }),
    (error) => {
      assert.ok(error instanceof PollError)
      assert.equal(error.notFound, false)
      assert.match(error.message, /incomplete GraphQL response: check contexts could not be resolved/)
      return true
    },
  )

  await assert.rejects(
    fetchPrSnapshot({
      target,
      ignoreTag: undefined,
      selfLogin: undefined,
      runGh: async () => JSON.stringify({ errors: [{ message: "service unavailable" }] }),
    }),
    (error) => error instanceof PollError && !error.notFound,
  )

  await assert.rejects(
    fetchPrSnapshot({
      target,
      ignoreTag: undefined,
      selfLogin: undefined,
      runGh: async () => JSON.stringify({ data: { repository: { pullRequest: null } } }),
    }),
    (error) => error instanceof PollError && error.notFound,
  )
})

test("partial pagination responses are rejected before normalization", async () => {
  const first = {
    data: {
      repository: {
        pullRequest: {
          title: "test PR",
          url: "https://github.com/sesori/example/pull/42",
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: "head-1",
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { nodes: [] },
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "threads-1" },
            nodes: [],
          },
          comments: { totalCount: 0, nodes: [] },
          labels: { nodes: [] },
        },
      },
    },
  }
  const partialPage = {
    errors: [{ message: "review thread page timed out" }],
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  }
  let calls = 0

  await assert.rejects(
    fetchPrSnapshot({
      target,
      ignoreTag: undefined,
      selfLogin: undefined,
      runGh: async () => JSON.stringify(++calls === 1 ? first : partialPage),
    }),
    /incomplete GraphQL response: review thread page timed out/,
  )
})

test("a follow-up in an existing thread is activity even when resolution counts do not change", () => {
  const before = snapshot({
    reviewThreads: [
      thread("thread-1", false, [{ author: "reviewer", createdAt: "2026-08-03T11:00:00Z" }]),
    ],
  })
  const after = snapshot({
    reviewThreads: [
      thread("thread-1", false, [
        { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
        { author: "owner", createdAt: "2026-08-03T11:10:00Z" },
      ]),
    ],
  })

  assert.equal(detectActivity(before, after, "MERGEABLE"), true)
})

test("reports locate pending unprefixed local-account follow-ups as human feedback", () => {
  const before = snapshot({
    reviewThreads: [
      thread("thread-1", false, [
        {
          author: "owner",
          createdAt: "2026-08-03T11:00:00Z",
          isLocal: true,
          isAgentReply: true,
        },
      ]),
    ],
  })
  const after = snapshot({
    reviewThreads: [
      thread(
        "thread-1",
        false,
        [
          {
            author: "owner",
            createdAt: "2026-08-03T11:00:00Z",
            isLocal: true,
            isAgentReply: true,
          },
          {
            author: "owner",
            createdAt: "2026-08-03T12:01:00Z",
            isLocal: true,
            isAgentReply: false,
            reviewState: "PENDING",
          },
        ],
        {
          path: "bridge/app/lib/src/services/session_creation_service.dart",
          line: 90,
        },
      ),
    ],
  })

  const report = buildReport(target, after, {
    baselineMs: Date.parse("2026-08-03T12:00:00Z"),
    baselineSnapshot: before,
    replyPrefix: "[Agent reply]",
  })

  assert.match(report, /owner \[local account, unprefixed; pending review\]/)
  assert.ok(
    report.includes(
      "Changed threads: `bridge/app/lib/src/services/session_creation_service.dart:90` [thread `thread-1`] " +
        "(unresolved; 1 owner [local account, unprefixed; pending review])",
    ),
  )
  assert.match(report, /new human comment, not an earlier agent reply/)
  assert.match(report, /Pending-review comments may be absent from REST pull-comment results/)
  assert.match(report, /inspect the listed thread through GraphQL before marking ready/)
  assert.match(report, /Local agent replies count only when they begin with `\[Agent reply\]`/)
})

test("an ignored reply rolling a full comment window does not look like visible activity", () => {
  const visible = Array.from({ length: 100 }, (_, index): CommentMeta => ({
    id: `comment-${index + 1}`,
    author: "reviewer",
    isBot: false,
    createdAt: `2026-08-03T11:${String(index % 60).padStart(2, "0")}:00Z`,
    isLocal: false,
    isAgentReply: false,
  }))
  const before = snapshot({ reviewThreads: [{ id: "thread-1", isResolved: false, comments: visible }] })
  const afterIgnoredReply = snapshot({
    reviewThreads: [{ id: "thread-1", isResolved: false, comments: visible.slice(1) }],
  })
  const afterHumanReply = snapshot({
    reviewThreads: [
      {
        id: "thread-1",
        isResolved: false,
        comments: [
          ...visible.slice(1),
          {
            id: "comment-101",
            author: "owner",
            isBot: false,
            createdAt: "2026-08-03T12:01:00Z",
            isLocal: false,
            isAgentReply: false,
          },
        ],
      },
    ],
  })

  assert.equal(detectActivity(before, afterIgnoredReply, "MERGEABLE"), false)
  assert.equal(detectActivity(before, afterHumanReply, "MERGEABLE"), true)
})

test("reports identify resolved and unresolved threads that received new comments", () => {
  const report = buildReport(
    target,
    snapshot({
      reviewThreads: [
        thread(
          "thread-1",
          false,
          [
            { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
            { author: "alice", createdAt: "2026-08-03T12:01:00Z" },
          ],
          { path: "core/report.ts", line: 53 },
        ),
        thread(
          "thread-2",
          true,
          [{ author: "owner", createdAt: "2026-08-03T12:02:00Z" }],
          { path: "core/report.ts", line: 53 },
        ),
        thread("thread-3", false, [{ author: "reviewer", createdAt: "2026-08-03T11:30:00Z" }]),
      ],
    }),
    { baselineMs: Date.parse("2026-08-03T12:00:00Z") },
  )

  assert.match(
    report,
    /\[comment:inline\] ACTION REQUIRED: 2 threads received 2 new relevant comments since last flush/,
  )
  assert.match(report, /`core\/report\.ts:53` \[thread `thread-1`\]/)
  assert.match(report, /`core\/report\.ts:53` \[thread `thread-2`\]/)
})

test("report baselines use comment IDs when GitHub timestamps share a second", () => {
  const before = snapshot({
    reviewThreads: [thread("thread-1", false, [{ author: "reviewer", createdAt: "2026-08-03T12:00:00Z" }])],
  })
  const after = snapshot({
    reviewThreads: [
      thread("thread-1", false, [
        { author: "reviewer", createdAt: "2026-08-03T12:00:00Z" },
        { author: "owner", createdAt: "2026-08-03T12:00:00Z" },
      ]),
    ],
  })

  const report = buildReport(target, after, {
    baselineMs: Date.parse("2026-08-03T12:00:00.900Z"),
    baselineSnapshot: before,
  })

  assert.match(report, /1 thread received 1 new relevant comment since last flush/)
})

test("new merge conflicts are recognized across transient UNKNOWN polls", () => {
  assert.equal(hasNewMergeConflict("MERGEABLE", snapshot({ mergeable: "CONFLICTING" })), true)
  assert.equal(hasNewMergeConflict("CONFLICTING", snapshot({ mergeable: "CONFLICTING" })), false)
  assert.equal(hasNewMergeConflict(undefined, snapshot({ mergeable: "CONFLICTING" })), true)
})

test("a MERGEABLE to UNKNOWN to CONFLICTING sequence flushes when it settles", async () => {
  const initial = snapshot({ mergeable: "MERGEABLE" })
  const unknown = snapshot({ mergeable: "UNKNOWN" })
  const conflicting = snapshot({ mergeable: "CONFLICTING" })
  const harness = watchHarness(initial, [unknown, conflicting])

  await harness.watch.tick()
  assert.equal(harness.reports.length, 0)
  await harness.watch.tick()
  assert.equal(harness.reports.length, 1)
  assert.match(harness.reports[0]!, /Mergeable: CONFLICTING/)
})

test("a new merge conflict bypasses debounce and a running-CI hold", async () => {
  const initial = snapshot({ checks: [{ name: "tests", outcome: "pending" }] })
  const next = snapshot({
    mergeable: "CONFLICTING",
    checks: [{ name: "tests", outcome: "pending" }],
  })
  const harness = watchHarness(initial, [next])

  await harness.watch.tick()

  assert.equal(harness.reports.length, 1)
  assert.match(harness.reports[0]!, /Mergeable: CONFLICTING/)
})

test("terminal states preserve an existing ready label", async () => {
  const initial = snapshot({ labels: ["ready-for-human-review"] })
  const merged = snapshot({ state: "MERGED", labels: ["ready-for-human-review"] })
  const harness = watchHarness(initial, [merged], config({ announceOnStart: false }), { readiness: true })

  await harness.watch.tick()

  assert.deepEqual(harness.readyChanges, [])
  assert.match(harness.reports[0]!, /Ready for human review: YES/)
  assert.match(harness.reports[0]!, /Monitor stopped: PR merged/)
  assert.doesNotMatch(harness.reports[0]!, /Required next step/)
})

test("merge and close transitions bypass debounce", async () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const harness = watchHarness(snapshot(), [snapshot({ state })])
    await harness.watch.tick()
    assert.equal(harness.reports.length, 1)
    assert.equal(harness.watch.isStopped, true)
  }
})

test("a failed same-name check rerun is new activity when its check-run identity changes", () => {
  const before = snapshot({ checks: [{ id: "check-run-1", name: "tests", outcome: "failure" }] })
  const after = snapshot({ checks: [{ id: "check-run-2", name: "tests", outcome: "failure" }] })

  assert.equal(hasNewCiFailure(before, after), true)
})

test("a newly failing check still bypasses debounce", async () => {
  const initial = snapshot({ checks: [{ name: "lint", outcome: "pending" }] })
  const next = snapshot({ checks: [{ name: "lint", outcome: "failure" }] })
  const harness = watchHarness(initial, [next])

  await harness.watch.tick()

  assert.equal(harness.reports.length, 1)
  assert.match(harness.reports[0]!, /CI: failing/)
})

test("failed urgent delivery retries immediately", async () => {
  const initial = snapshot({
    reviewThreads: [thread("thread-1", false, [{ author: "reviewer", createdAt: "2026-08-03T11:00:00Z" }])],
  })
  const conflicting = snapshot({
    mergeable: "CONFLICTING",
    reviewThreads: [
      thread("thread-1", false, [
        { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
        { author: "owner", createdAt: "2026-08-03T12:00:01Z" },
      ]),
    ],
  })
  const harness = watchHarness(initial, [conflicting, conflicting], config({ announceOnStart: false }), {
    deliveryFailures: 1,
  })

  await harness.watch.tick()
  assert.equal(harness.deliveryAttempts, 1)
  assert.equal(harness.reports.length, 0)

  await harness.watch.tick()
  assert.equal(harness.deliveryAttempts, 2)
  assert.equal(harness.reports.length, 1)
  assert.match(harness.reports[0]!, /1 thread received 1 new relevant comment since last flush/)
})

test("ordinary activity waits for the two-minute quiet window", async () => {
  const initial = snapshot({
    reviewThreads: [thread("thread-1", false, [{ author: "reviewer", createdAt: "2026-08-03T11:00:00Z" }])],
  })
  const changed = snapshot({
    reviewThreads: [
      thread("thread-1", false, [
        { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
        { author: "alice", createdAt: "2026-08-03T12:00:01Z" },
      ]),
    ],
  })
  const harness = watchHarness(initial, [changed, changed, changed])

  await harness.watch.tick()
  harness.advance(2 * 60_000 - 1)
  await harness.watch.tick()
  assert.equal(harness.reports.length, 0)

  harness.advance(1)
  await harness.watch.tick()
  assert.equal(harness.reports.length, 1)
})
