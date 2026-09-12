import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { Context } from "@deepseek-ai/cordis"
import type { Agent } from "@deepseek-ai/dsh-agent"
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillSummary,
} from "@deepseek-ai/dsh-skill"
import { defineTool } from "@deepseek-ai/dsh-tools"
import {
  AUTO_MERGE_ENV,
  globalMonitorConfigPath,
  loadMonitorConfig,
  type MonitorConfig,
} from "../core/config"
import type { GhRunner } from "../core/github"
import {
  InitialAnnouncementMode,
  InitialAnnouncementState,
  MonitorSession,
  type MonitorActionResult,
} from "../runtime/monitor-session"
import { createNodeGhRunner } from "../runtime/node-gh"
import { packageSkillDirectory } from "../runtime/package-skill"
import {
  buildMonitorToolDescription,
  MONITOR_ACTION_VALUES,
  MonitorAction,
} from "../runtime/tool"

const PLUGIN_NAME = "pr-monitor"

const SKILL_NAME = "monitor-pr"
const SKILL_PROVIDER = "pr-monitor-bundled"

type OwnerCleanup = () => void | Promise<void>

export type DeepSeekMonitorDependencies = {
  runGh?: GhRunner
  loadConfig?: (input: { agent: Agent }) => Promise<MonitorConfig>
  log?: (message: string) => void
  schedule?: (input: { callback: () => void; intervalMs: number }) => unknown
  cancel?: (input: { timer: unknown }) => void
  skillMarkdown?: string
}

export type DeepSeekMonitorController = {
  dispose: () => Promise<void>
}

function formatResult({ result }: { result: MonitorActionResult<MonitorConfig> }): string {
  if (result.start === undefined) return result.text
  const { config, announcement } = result.start
  const replyPrefix = config.ignoreCommentTag ?? "<!-- pr-monitor:reply -->"
  return (
    `${result.text}\n` +
    (announcement === InitialAnnouncementState.pending
      ? "An initial [PR Monitor] status report is being delivered now. "
      : "") +
    `Polling every ${config.pollIntervalSeconds}s; reports arrive automatically in this DeepSeek Harness ` +
    `conversation after ${config.debounceMinutes} quiet minutes following activity. ` +
    (config.flushOnCiFailure
      ? "A failing check is reported at the next poll without waiting for that quiet window or the rest of CI. "
      : "") +
    "A new merge conflict or terminal PR state is also reported at the next poll without waiting. " +
    `Readiness is managed automatically; agent-authored GitHub replies must begin with \`${replyPrefix}\`. ` +
    "Use mark_ready when new feedback is non-actionable and no reply should be posted. " +
    "End the turn when there is no delivered report to handle. Never create sleeps, scheduled checks, polling " +
    "loops, repeated CI checks, or routine status/flush calls. " +
    "Only user-global config and provenance-safe launch environment values are loaded because DeepSeek Harness " +
    "exposes no project-trust signal. Invoking-project .env values are ignored for monitor configuration. " +
    "The monitor stops when this root conversation or the Harness process ends and is not restored on resume."
  )
}

function parseSkill({ markdown }: { markdown: string }): { body: string; description: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown)
  if (frontmatter === null) throw new Error("packaged monitor-pr skill has no YAML frontmatter")
  const descriptionBlock = /^description:\s*>[-+]?\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(
    frontmatter[1] ?? "",
  )
  if (descriptionBlock === null) throw new Error("packaged monitor-pr skill has no folded description")
  const description = descriptionBlock[1]
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
  if (description === undefined || description.length === 0) {
    throw new Error("packaged monitor-pr skill has an empty description")
  }
  return { body: markdown.slice(frontmatter[0].length), description }
}

function registerPackagedSkill({
  ctx,
  markdown,
}: {
  ctx: Context
  markdown: string
}): () => void {
  const parsed = parseSkill({ markdown })
  const summary: SkillSummary = {
    name: SKILL_NAME,
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: "bundled",
    provider: SKILL_PROVIDER,
  }
  const candidate: SkillCandidate = {
    ...summary,
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_NAME,
  }
  const definition: SkillDefinition = {
    ...summary,
    content: parsed.body,
  }

  return ctx.skills.registerProvider(() => ({
    name: SKILL_PROVIDER,
    list: () => Promise.resolve([candidate]),
    get: (selected) =>
      Promise.resolve(
        selected.provider === SKILL_PROVIDER && selected.locator === SKILL_NAME
          ? definition
          : undefined,
      ),
  }))
}

function isLiveRoot({ ctx, agent }: { ctx: Context; agent: Agent }): boolean {
  return ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent)
}

function trustedConfigEnvironment({
  ctx,
  log,
}: {
  ctx: Context
  log: (message: string) => void
}): { environment: Readonly<Record<string, string | undefined>>; globalPaths: readonly string[] } {
  const launchEnvironment = launchEnvironmentOf(ctx)
  const trustedSources = ["process", "user-env"] as const
  const environment: Record<string, string | undefined> = {}
  const autoMerge = launchEnvironment.getFrom(AUTO_MERGE_ENV, trustedSources)
  if (autoMerge !== undefined) environment[AUTO_MERGE_ENV] = autoMerge.value

  for (const name of ["XDG_CONFIG_HOME", "HOME", "USERPROFILE"] as const) {
    const entry = launchEnvironment.getFrom(name, trustedSources)
    if (entry === undefined) continue
    const value = entry.value.trim()
    if (name === "XDG_CONFIG_HOME" || isAbsolute(value)) environment[name] = entry.value
  }

  const xdgConfigHome = environment["XDG_CONFIG_HOME"]?.trim()
  const homeDirectory = environment["HOME"]?.trim() || environment["USERPROFILE"]?.trim()
  if ((xdgConfigHome === undefined || !isAbsolute(xdgConfigHome)) && homeDirectory === undefined) {
    log("DeepSeek Harness supplied no trusted absolute user config root; user-global config is skipped.")
    return { environment, globalPaths: [] }
  }
  return {
    environment,
    globalPaths: [globalMonitorConfigPath({ environment, homeDirectory: homeDirectory ?? "" })],
  }
}

function registerAgentRuntime({
  ctx,
  agent,
  dependencies,
  runtimes,
  isStopping,
}: {
  ctx: Context
  agent: Agent
  dependencies: DeepSeekMonitorDependencies
  runtimes: Map<Agent, OwnerCleanup>
  isStopping: () => boolean
}): void {
  if (isStopping() || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return

  const log =
    dependencies.log ??
    ((message: string) => {
      ctx.logger.info(`[pr-monitor] ${message}`)
    })
  const monitor = new MonitorSession<MonitorConfig>({
    runGh: dependencies.runGh ?? createNodeGhRunner(),
    log,
    schedule: dependencies.schedule,
    cancel: dependencies.cancel,
  })
  const loadConfig = (): Promise<MonitorConfig> => {
    const customLoadConfig = dependencies.loadConfig
    if (customLoadConfig !== undefined) return customLoadConfig({ agent })
    const trustedConfig = trustedConfigEnvironment({ ctx, log })
    return loadMonitorConfig({ paths: [], log, ...trustedConfig })
  }

  let cleanup: OwnerCleanup
  let cleanupPromise: Promise<void> | undefined
  let disposeTool = (): void => {}
  const runCleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      try {
        disposeTool()
      } finally {
        try {
          await monitor.stopAll({})
        } finally {
          if (runtimes.get(agent) === cleanup) runtimes.delete(agent)
        }
      }
    })()
    return cleanupPromise
  }
  const disposeScope = agent.ctx.effect(() => {
    disposeTool = agent.ctx.tools.register(defineTool({
      name: "pr_monitor",
      description: buildMonitorToolDescription({
        delivery: "reports are steered into THIS root conversation as visible '[PR Monitor]' user messages.",
        configPath: "no DeepSeek Harness project file",
        lifecycle:
          "Monitors belong to the exact root Agent and do not survive Agent disposal or a Harness process restart. " +
          "DeepSeek Harness exposes no project-trust signal, so project config files and invoking-project .env " +
          "values are ignored when resolving monitor configuration.",
        waiting: "After start, end the turn whenever there is no delivered report to handle.",
      }),
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: MONITOR_ACTION_VALUES,
          description: "What to do.",
        },
        pr: {
          type: "string",
          description:
            "PR identifier: 'owner/repo#123' or PR URL. Required for start/stop/flush/mark_ready/unmark_ready; " +
            "'all' allowed for stop/flush.",
        },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      async execute(args, exec): Promise<string> {
        if (exec.agent !== agent || !isLiveRoot({ ctx, agent }) || isStopping()) {
          return "Cannot use PR Monitor: the owning DeepSeek Harness root conversation is no longer live."
        }
        const result = await monitor.execute({
          action: args.action,
          pr: args.pr,
          loadConfig,
          start:
            args.action === MonitorAction.start
              ? {
                  announcementMode: InitialAnnouncementMode.background,
                  createChannel: () => ({
                    deliver: ({ report }) => {
                      if (!isLiveRoot({ ctx, agent }) || isStopping()) {
                        return Promise.reject(
                          new Error("the owning DeepSeek Harness root conversation is no longer live"),
                        )
                      }
                      agent.steer(
                        createUserMessage({
                          content: [{ type: "text", text: report }],
                          source: { kind: "plugin", plugin: PLUGIN_NAME },
                        }),
                      )
                      return Promise.resolve()
                    },
                  }),
                }
              : undefined,
        })
        return formatResult({ result })
      },
    }))

    return runCleanup
  }, "pr-monitor.runtime()")
  cleanup = async () => {
    try {
      await Promise.resolve(disposeScope())
    } finally {
      await runCleanup()
    }
  }

  runtimes.set(agent, cleanup)
}

export function registerDeepSeekMonitor({
  ctx,
  dependencies = {},
}: {
  ctx: Context
  dependencies?: DeepSeekMonitorDependencies
}): DeepSeekMonitorController {
  const runtimes = new Map<Agent, OwnerCleanup>()
  let stopping = false
  const lifecycle = ctx.effect(() => {
    const markdown =
      dependencies.skillMarkdown ??
      readFileSync(join(packageSkillDirectory({ moduleUrl: import.meta.url }), SKILL_NAME, "SKILL.md"), "utf8")
    const disposeSkill = registerPackagedSkill({ ctx, markdown })
    const register = ({ agent }: { agent: Agent }): void => {
      for (const [owner, cleanup] of runtimes.entries()) {
        if (owner === agent || owner.id !== agent.id) continue
        void Promise.resolve(cleanup()).catch((error: unknown) => {
          const message = `replacement cleanup failed for DeepSeek Agent ${owner.id}: ${String(error)}`
          if (dependencies.log !== undefined) dependencies.log(message)
          else ctx.logger.warn(`[pr-monitor] ${message}`)
        })
      }
      registerAgentRuntime({
        ctx,
        agent,
        dependencies,
        runtimes,
        isStopping: () => stopping,
      })
    }
    const stopCreated = ctx.on("agent/created", register)
    for (const agent of ctx.agents.roots()) register({ agent })

    return async () => {
      stopping = true
      const entries = [...runtimes.entries()]
      runtimes.clear()
      const cleanups = [
        { label: "agent/created listener", cleanup: stopCreated },
        { label: "skill provider", cleanup: disposeSkill },
        ...entries.map(([agent, cleanup]) => ({ label: `DeepSeek Agent ${agent.id}`, cleanup })),
      ]
      const results = await Promise.allSettled(
        cleanups.map(({ cleanup }) => Promise.resolve().then(() => cleanup())),
      )
      for (const [index, result] of results.entries()) {
        if (result.status !== "rejected") continue
        const message = `cleanup failed for ${cleanups[index]?.label ?? "unknown owner"}: ${String(result.reason)}`
        if (dependencies.log !== undefined) dependencies.log(message)
        else ctx.logger.warn(`[pr-monitor] ${message}`)
      }
    }
  }, "pr-monitor.lifecycle()")

  return {
    dispose: async () => {
      await Promise.resolve(lifecycle())
    },
  }
}
