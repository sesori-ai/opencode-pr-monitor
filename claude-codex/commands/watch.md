---
description: Start monitoring a GitHub PR in the background
argument-hint: "[owner/repo#123 | PR URL]"
---

Start a background PR monitor with the pr_monitor tool (action "start").

PR to monitor: $ARGUMENTS

If no PR was given above, resolve the current branch's open PR with `gh pr view --json url -q .url` and monitor that one. The pr argument passed to the tool must be explicit — `owner/repo#123` or a full PR URL.

After starting, briefly confirm what is being watched and keep working on whatever you were doing. `[PR Monitor]`
reports will be injected into this conversation when something happens on the PR. If the result reports an
auto-merge startup safety reset, note that the pre-existing ready label was removed and reassess before using
`mark_ready` again.

Then follow the **monitor-pr** skill: act on every report and its explicit readiness line. Unless `keepAlive` is
disabled, the session stays on the PR until the ready label is present, whether automation or a confirmed manual
`mark_ready` added it.
