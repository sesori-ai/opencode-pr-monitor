export enum MonitorAction {
  start = "start",
  stop = "stop",
  flush = "flush",
  status = "status",
  markReady = "mark_ready",
  unmarkReady = "unmark_ready",
}

export const MONITOR_ACTION_VALUES = [
  MonitorAction.start,
  MonitorAction.stop,
  MonitorAction.flush,
  MonitorAction.status,
  MonitorAction.markReady,
  MonitorAction.unmarkReady,
] as const

export function buildMonitorToolDescription({
  delivery,
  configPath,
  lifecycle,
  waiting,
}: {
  delivery: string
  configPath: string
  lifecycle: string
  waiting: string
}): string {
  return (
    "Monitor a GitHub PR in the background. Detects head changes, CI conclusions, reviews, inline/issue comments " +
    "(including follow-ups on existing or resolved threads), mergeability changes, and merge/close. Activity is " +
    `aggregated with a rolling debounce; ${delivery} Reports never include comment bodies. Every report states ` +
    "whether the configured ready label is present and tells the agent to keep working or manually mark ready when " +
    "judgment says no action remains. Startup reports normally observe the existing label; when " +
    "SESORI_PR_MONITOR_AUTO_MERGE=true, start removes a pre-existing ready label and requires fresh assessment. " +
    "Assess current-head checks, automated reviews and feedback immediately, including after restarting a monitor. " +
    "Mark an already-settled PR " +
    "ready without waiting for a new event, but never infer readiness from empty results after creation or a fresh push. " +
    "On later activity, the monitor automatically adds readiness when CI is passing (or absent), " +
    "mergeability is definite, and every feedback channel ends in a correctly prefixed local-account reply. It " +
    "withdraws readiness on later commits, relevant comments, CI regression, or conflict. A newly failing check " +
    "(when flushOnCiFailure is enabled), readiness withdrawal, merge conflict, or terminal state skips debounce. " +
    "The monitor owns all polling and notifications arrive automatically. NEVER create sleeps, delayed or scheduled " +
    "jobs, background polling loops, repeated `gh pr checks`, or routine status/flush calls while waiting. " +
    `${waiting} Actions: start (watch one PR), stop (stop one or all), flush (on-demand full report; never routine ` +
    "after a delivered report), status (list this session's monitors), mark_ready (unconditionally accept current " +
    "state and add the configured ready label), and unmark_ready (remove it now; automation may restore it after a " +
    "later clean assessment). With SESORI_PR_MONITOR_AUTO_MERGE=true, automatic readiness and mark_ready also " +
    "make one squash-merge attempt for the accepted head using only the PR title; merge failure keeps readiness " +
    "and is not retried " +
    "automatically. Ready actions do not require an active monitor. The PR must be `owner/repo#123` or a " +
    `full URL; \`all\` is allowed only for stop/flush. Tuning lives in ${configPath}. ${lifecycle}`
  )
}
