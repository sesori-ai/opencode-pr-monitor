# How the monitor decides

[← README](../README.md)

This page explains what PR Monitor watches, when it sends a report, and how it decides a PR is ready for a human.
The behavior is the same on every host. Delivery and lifecycle differences are in the [host guide](hosts.md).

## What counts as activity

Each watched PR is polled with one GitHub GraphQL query per tick. Extra pages are fetched only when checks, reviews,
review threads, or labels overflow the first page.

These count as activity:

- a new head commit;
- the PR state changing, or mergeability settling on a definite value;
- a new or changed review, or a new review summary;
- a relevant inline or issue comment;
- a review thread being resolved or unresolved; and
- a CI suite finishing.

A new commit counts right away, before GitHub has registered its checks. CI merely starting, or individual checks
passing on the same commit, does not count. Mergeability is compared against the last definite value, so GitHub's
temporary `UNKNOWN` state does not cause noise while a real conflict is still caught.

## When you get a report

### Ordinary activity

Ordinary activity is batched. Each new event restarts a quiet timer of `debounceMinutes`. When the PR has been quiet
for that long, one report goes out.

If the timer runs out while CI is still running, the report waits for CI, up to `maxCiWaitMinutes`. That way you
usually get one "here is what changed, and CI passed" message instead of two.

### Right away

Three things skip the timers and are reported at the next poll:

- the first failing check on a commit, when `flushOnCiFailure` is on;
- a merge conflict that has just become definite; and
- the PR merging or closing.

Only the first CI failure on a commit is reported instantly. Later failures on the same commit ride along with the
normal report.

## What a report contains

Reports state facts and name people. They never quote comment bodies. A full report has:

- the PR, its URL, and its title;
- CI status, how many checks finished, and the names of any failed checks;
- mergeability;
- requested and completed reviews;
- new review summaries;
- inline threads that changed, whether they are resolved, and who commented;
- how many issue comments arrived and from whom;
- whether the ready label is present; and
- one clear next step.

"New since the last report" is worked out from GitHub comment IDs, not timestamps, so two comments posted in the
same second are not lost.

## Answering feedback

PR Monitor tracks whether feedback has been answered separately from whether GitHub shows a thread as resolved.

**Inline review threads.** Any new relevant comment on an existing thread, resolved or not, is reported as
`ACTION REQUIRED`. The report lists every changed thread and points out when the unresolved count did not change. A
thread counts as answered when the latest feedback is followed by a reply from the monitoring account that starts
with the exact `ignoreCommentTag` prefix. The thread can stay unresolved on purpose.

**Review summaries and issue comments.** These have no thread to reply in. A later prefixed issue comment from the
monitoring account answers the latest review summary or issue comment.

Editing or deleting a reply removes it as proof. If feedback and a reply land in the same second, PR Monitor plays it
safe and treats the feedback as unanswered until a later reply or a manual `mark_ready`.

## Readiness

PR Monitor adds the ready label on its own when all three hold:

1. CI is green, or there is no CI;
2. GitHub reports the PR as `MERGEABLE`; and
3. every feedback channel ends with a valid prefixed reply.

A new commit, a relevant comment or review summary, an edited or deleted reply, a CI failure, or a conflict takes the
label off again. Thread resolution, stale reviews, pending reviewers, draft status, and the PR being merged or closed
do not on their own.

When a monitor starts, it notes an existing ready label but does not re-add one. The agent has to look at the first
report and decide, including after a host restart. A PR that was already settled can be marked ready immediately,
but "nothing has happened yet" right after opening or pushing is not evidence, and neither is age. With auto-merge
on, startup instead removes a stale ready label and asks for a fresh assessment; see
[auto-merge](configuration.md#auto-merge).

`mark_ready` accepts the PR as it is and adds the label. Use it after looking at feedback that needs no reply, such
as a bot comment. `unmark_ready` removes the label now, but it is not a permanent hold: if the monitor later sees the
PR clean again, the label comes back.

## When a monitor stops

- The PR was deleted or is no longer accessible: stops immediately with a notice.
- Ten polls in a row failed: stops.
- Ten report deliveries in a row failed: stops.
- A single failed delivery keeps the old baseline, so the same activity is retried rather than lost. A failed first
  report is retried in full at the next poll.
- The PR merged or closed: one final report ending in `Monitor stopped: PR merged` or `PR closed`, then the monitor
  stops.
- Manual, lifecycle, and failure stops all use the same `Monitor stopped: <reason>` wording.

Monitors live in memory and belong to the conversation that started them. They stop by themselves when the PR is
done but do not survive a host restart. After `start`, the agent should end its turn and let reports come to it.
Sleeps, scheduled checks, background polling, repeated `gh pr checks`, and routine `status` or `flush` calls are not
supported.
