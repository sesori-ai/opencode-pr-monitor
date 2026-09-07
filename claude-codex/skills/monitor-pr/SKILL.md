---
name: monitor-pr
description: >-
  Drive a GitHub PR to ready-for-human-review without supervision. Start
  pr_monitor immediately after opening a PR and act on every automatic report;
  the monitor owns polling, delivery, and readiness labels — reports arrive on
  their own, so never create sleeps, delays, timeouts, scheduled checks, or
  polling loops. Address every newly commented thread, failing CI, and
  conflicts. Use after `gh pr create`, when asked to watch a PR, and whenever a
  "[PR Monitor]" or "[PR Monitor keep-alive]" message appears.
---

# monitor-pr

Own a PR from creation through handoff. The monitor polls GitHub, delivers
reports, and automatically adds or withdraws the configured ready label. The
agent judges the substance of feedback and may manually accept non-actionable
activity without creating bot acknowledgement loops.

## 1. Start immediately

After `gh pr create`:

```
pr_monitor(action: "start", pr: "owner/repo#123")
```

Always pass an explicit PR. Watches belong to this agent process (Claude Code
or Codex) and do not survive a restart. In a fresh session, use `status` once
and restart anything missing.

If Codex reports that its delivery hook has not registered the conversation,
monitoring has not started. Installing the plugin does not grant hook trust.
Direct the user to review and enable all four PR Monitor hooks (`SessionStart`,
`UserPromptSubmit`, `PostToolUse`, `Stop`) through `/hooks` in Codex CLI, on the
host running the session with the same OS user and `CODEX_HOME`. Sesori and
other clients without that screen require a terminal on the app-server host.
After approval, a new prompt or tool event registers the conversation; retry
then. Changed hooks may need review after updates. Do not repeatedly retry
without a setup change, manufacture registration files, or bypass hook trust.
See the [required hook-trust setup steps](https://github.com/sesori-ai/pr-monitor-plugin#trust-the-delivery-hooks-required). If the user has
already approved these exact hooks, help complete that review without asking
for the same permission again.

The start result states the configured agent-reply prefix. Every GitHub reply
written by the agent **must begin with that exact prefix** (default
`<!-- pr-monitor:reply -->`). The human owner may comment through the same
GitHub account; an unprefixed local-account comment is therefore human feedback.

## Assess the initial report, including after a restart

Startup observes the existing label without automatically adding it. Treat
the initial PR state as an actionable report. Restarting the harness
kills its monitors; when you start one again, assess readiness immediately.
Do not wait for a new commit, comment, or CI transition to make an already
settled PR eligible for handoff.

Inspect the current head's checks, expected automated review activity, and the
full existing feedback. Use the PR creation and latest-push history as context:

- **Just created or recently pushed:** no checks, reviews, or issues may mean
  results have not arrived yet. Do not call `mark_ready` from that absence.
  Keep monitoring for the expected checks and automated reviews to settle.
- **Already settled, including after a harness restart:** if checks and
  automated reviews have completed or are not applicable, the PR is mergeable,
  and all feedback is handled or verified non-actionable, call `mark_ready`
  now and confirm success. Feedback predating this monitor still needs that
  judgment; no later event is required.

PR age alone proves nothing: an old PR can have a new head. Assess the current
head and repository workflow, not a fixed age cutoff. Requested human review
can remain pending; this label hands the PR to that reviewer. If evidence is
incomplete, keep the monitor active and use its delivered reports rather than
creating sleeps or polling loops.

## 2. Handle every report

- For failing CI, inspect the named check, fix the root cause, test, commit, and
  push. Never weaken tests.
- For `Mergeable: CONFLICTING`, merge the actual base into the PR branch. Never
  rebase or force-push; preserve both sides and test.
- For `ACTION REQUIRED` inline feedback, inspect **every thread that received a
  new relevant comment**, including existing unresolved and resolved threads.
  An unchanged unresolved-thread count does not mean there is no new feedback.
- Fetch bodies for new review summaries and issue comments; reports omit them.
- Treat a local-account, unprefixed comment as a human instruction.
- A merged/closed report is terminal; the monitor stopped itself.

When feedback needs a response, begin the GitHub reply with the configured
prefix. That final prefixed reply—not thread resolution—is the monitor's
authoritative evidence that the feedback channel was handled. Deliberately
unresolved threads are allowed for human review.

A delivered report already advanced its baseline. Never routinely call `flush`
after handling one.

## 3. Follow readiness, do not reconstruct it

Every report explicitly says `Ready for human review: YES` or `NO`.

- `YES`: the label is present and keep-alive is handed off. A
  resolution-only or approval report must not cause `unmark_ready`.
- `NO`: keep working, or use manual `mark_ready` when inspection shows nothing
  actionable remains.

Automatic readiness requires passing/no CI, definite mergeability, and a
prefixed local reply after the latest threaded and flat feedback. It ignores
unresolved-thread count, stale `CHANGES_REQUESTED`, pending reviewers, and draft
state. A new commit, relevant comment/review summary, CI regression, or definite
conflict withdraws readiness. Thread resolution alone does not.

## 4. Do not acknowledge an acknowledgement

A bot may post a non-actionable acknowledgement after a fix. Its new comment
correctly withdraws readiness. Inspect it, but do **not** reply merely to make
the bot acknowledge another acknowledgement. Instead call:

```
pr_monitor(action: "mark_ready", pr: "owner/repo#123")
```

This also applies to clean review summaries (such as "0 issues found"), review
quota notices, and other no-op feedback. Fetch and inspect the full text first.
They do not qualify for automatic readiness merely because a bot posted them.
When CI is green, the PR is mergeable, and no actionable work remains, use
`mark_ready` yourself; do not wait for another bot reply to clear the gate.

`mark_ready` unconditionally accepts all activity currently observed by the
watch and adds the label. Only later invalidating activity withdraws it. Claim
handoff only after the tool confirms success.

If the comment asks for work, do that work and leave a prefixed reply instead.
`unmark_ready` removes the label now but does not create a permanent hold;
automation may restore readiness after a later clean assessment.

## 5. Never invent a wait

The monitor delivers on its own: a new report arrives as a `[PR Monitor]`
message even while the session is idle, and starts its own turn. Waiting is
never the agent's job. Never run `sleep`, delayed Bash, cron, a background
polling loop, repeated `gh pr checks`, routine `status`/`flush` calls, or any
other delay/timeout mechanism to wait for the monitor. When nothing is left to
handle, end the turn — the next report re-opens the work by itself.

Only on hosts without push delivery (Codex, or a legacy Claude Code), the plugin
may inject a `[PR Monitor keep-alive]` message containing an exact waiter
command (`node "<plugin>/hooks/await-activity.mjs" --session <pid> --timeout 540`).
Run that exact command with your shell tool and a 600000 ms timeout (Claude
Code Bash `timeout: 600000`; Codex shell `timeout_ms: 600000`), only when such
a message explicitly asks; never wrap it in another delay and never start it
unasked. If no keep-alive message asks, end the turn. If the user asks to stop,
call `pr_monitor(action: "stop", pr: "all")`.

## Other actions

- `status`: list this session's watches and handoff state.
- `flush`: deliberately fetch a full status; never routine after a report.
- `stop`: stop one/all watches without waiting for merge.

## Avoid the bot-review spiral

A bot edge case earns a code change only when plausible and consequential.
Decline contrived findings with one prefixed reasoned reply. If feedback rounds
cluster on one seam, fix the seam once or surface it instead of accumulating
patches.
