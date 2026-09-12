# @sesori/pr-monitor-deepseek

DeepSeek Harness bundle for [PR Monitor](https://github.com/sesori-ai/pr-monitor-plugin). It registers one
conversation-scoped `pr_monitor` tool and one bundled `monitor-pr` skill.

DeepSeek Harness remains a developer preview. This adapter targets **0.1.5-rc.2+**, Node.js 22.19+, and the long-lived
Web profile.

## Install

GitHub CLI must already be installed and authenticated. Harness also requires pnpm 10+ on `PATH` for profile
plugin management:

```sh
gh auth status
pnpm --version
```

Install the bundle into the Web profile, inspect the composed configuration, then start Harness:

```sh
npx @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add @sesori/pr-monitor-deepseek
npx @deepseek-ai/dsh@0.1.5-rc.2 --profile web --dump-config
npx @deepseek-ai/dsh@0.1.5-rc.2 web
```

Pin `@sesori/pr-monitor-deepseek@X.Y.Z` for deliberate upgrades. Restart Harness after installing or updating the
bundle.

## Delivery and lifecycle

DeepSeek keeps host SDKs external and resolves them through its profile loader. Do not copy the installed bundle out
of its profile and import it directly with plain Node; that bypasses Harness's module-resolution contract.

Each root DeepSeek Agent receives its own tool and monitor registry. Reports use native `agent.steer(...)` delivery:
an idle conversation starts a turn, while a busy conversation receives the report at its next step boundary. Exact
Agent object identity prevents another open conversation—or a replacement reusing the same session ID—from receiving
the report. A same-ID replacement receives its tool only after the prior runtime's in-flight startup/readiness
mutation cleanup drains. DeepSeek's bundled skill catalog is host-global, so a delegated child may discover
`monitor-pr` without receiving the root-only tool; the skill tells it to return the PR target and monitoring request
to its parent/root.

Disposing the conversation, unloading the bundle, or stopping Harness cancels its watches. Persisted conversations
do not restore watches after a process restart; start missing monitors again after resuming.

DeepSeek Harness does not currently expose project-trust proof to plugins. This adapter therefore loads only the
user-global `~/.config/pr-monitor/config.json` (or its absolute XDG equivalent). It accepts
`SESORI_PR_MONITOR_AUTO_MERGE` only from the inherited process or Harness-home user environment; the invoking
project's `.env` provenance is excluded. Repository `.pr-monitor.json` and `.dsh/pr-monitor.json` files are also
ignored rather than allowing untrusted project data to enable automatic merging.

See the repository [install instructions](../README.md#deepseek-harness),
[host guide](../docs/hosts.md#deepseek-harness), and [configuration guide](../docs/configuration.md).
