# Monitor behavior

[← README](../README.md)

PR Monitor turns GitHub state changes into bounded, factual work items for an agent. This document describes the
shared behavior across every host; delivery and lifecycle differences are in the [installation guide](installation.md).

## Polling and activity

Each watched PR uses one base `gh api graphql` query per tick. Extra pages are fetched only when check contexts,
latest reviews, review threads, or labels overflow their first page.

Activity includes:

- a new head commit;
- PR state or definite mergeability changes;
- review and review-summary changes;
- relevant inline or issue comments;
- review-thread resolution changes; and
- CI suite conclusions.

A head change counts immediately, before GitHub registers new checks. A transition into running CI and non-failing
per-check progress on the same head stay quiet. Mergeability compares against the last definite value, preventing
transient `UNKNOWN` churn while still detecting a settled conflict.

## Report timing

### Ordinary activity

Ordinary activity uses a rolling debounce. Every new event resets `debounceMinutes`; one report is sent after the PR
has remained quiet for that window.

If a due report reaches its quiet window while CI is running, PR Monitor holds it for up to `maxCiWaitMinutes`. This
usually replaces separate “activity” and “CI finished” messages with one complete report.

### Immediate activity

These events bypass both debounce and CI hold, producing a report at the next poll:

- the first newly failing check on a head when `flushOnCiFailure` is enabled;
- a newly definite merge conflict; and
- merge or close.

Only one instant CI-failure report is sent per head. Further failures on that commit appear in the normal
suite-conclusion report.

## Report contents

Reports identify status and authors without quoting comment bodies. A full report includes:

- PR target, URL, and title;
- CI phase, completion counts, and failed check names;
- mergeability;
- requested and completed reviews;
- new review summaries;
- changed inline threads, current resolution state, and relevant-comment authors;
- issue-comment counts and authors;
- ready-label presence; and
- one explicit next step.

“New since last flush” compares stable GitHub comment IDs with the last delivered report or manual `flush`. Comments
created in the same timestamp second are not lost.

## Feedback acknowledgement

PR Monitor treats acknowledgement separately from GitHub thread resolution.

### Inline review threads

Any new relevant comment on an existing thread—including a resolved thread—is reported as `ACTION REQUIRED`. The
report identifies every changed thread and warns when the unresolved count did not change.

A thread is acknowledged when its latest feedback is followed by a local-account reply beginning with the exact
configured `ignoreCommentTag`. The thread may remain unresolved intentionally.

### Review summaries and issue comments

Flat feedback has no thread reply channel. A later prefixed issue comment from the local account acknowledges the
latest review-summary or issue-comment feedback.

Editing or deleting an acknowledgement withdraws its evidence. Feedback and replies sharing the same GitHub
one-second timestamp remain conservatively unacknowledged until a later reply or manual `mark_ready`.

## Readiness

Automatic readiness requires all three conditions:

1. CI is green or absent;
2. mergeability is definitely `MERGEABLE`; and
3. every feedback channel ends in a valid prefixed local reply.

A later head, relevant comment or review summary, acknowledgement edit/deletion, CI regression, or conflict
withdraws readiness. Resolution state, stale review state, pending reviewers, draft state, and terminal state do not
independently withdraw it.

At startup, PR Monitor observes an existing ready label without automatically re-adding it. The agent must assess
the initial report, including after a host restart. It may mark an already-settled PR immediately, but empty results
after PR creation or a fresh push—and age alone—do not prove readiness. With auto-merge enabled, startup instead
clears stale readiness and requires fresh assessment; see [auto-merge safety](configuration.md#auto-merge).

`mark_ready` unconditionally accepts the current state and applies the configured label. Use it only after inspecting
non-actionable activity that should not receive another reply. `unmark_ready` is idempotent and removes the label
now; it is not a permanent hold, so later observed clean activity may restore readiness.

## Failure and terminal handling

- A deleted or inaccessible PR stops immediately with a notice.
- Ten consecutive polling failures stop the monitor.
- Ten consecutive report-delivery failures stop the monitor.
- Delivery failure preserves the old baseline, so the same activity retries instead of disappearing.
- Failed initial delivery retains a zero baseline and retries the full startup report on the next poll.
- Merge and close produce an immediate final report with `Monitor stopped: PR merged|closed`, then stop the watch.
- Manual, lifecycle, and failure stops use the same `Monitor stopped: <reason>` wording.

Watches are session-scoped and in memory. They stop automatically on terminal PR state but do not survive host
restart. After `start`, the agent must end its turn and let PR Monitor deliver events; sleeps, scheduled checks,
background polling, repeated `gh pr checks`, and routine `status` or `flush` calls are unsupported.
