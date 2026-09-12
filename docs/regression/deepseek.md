# DeepSeek Harness monitoring and installation

The `deepseek/` npm workspace is a native Cordis bundle using shared `runtime/MonitorSession` and `core/PrWatch`.
It registers one monitor runtime and tool per exact root `Agent`, delivers through `Agent.steer()`, and registers the
canonical skill with DeepSeek's skill provider API. Highest level: L5. Result vocabulary and proof boundaries follow
[README.md](README.md).

DeepSeek Harness is a developer preview. Compatibility research and package types are pinned to upstream commit
[`c291e7961a51`](https://github.com/deepseek-ai/deepseek-harness/commit/c291e7961a515f6d7af9304e7fd1d257929aef26),
release 0.1.5-rc.2 on Node.js 22.19+. Recheck every public contract named below when the host changes.

| Level | Boundary | Requirement | Evidence / status |
|---|---|---|---|
| L1 | Adapter contract | `agent/created` registers `pr_monitor` only in each root Agent context; all six actions use one scoped `MonitorSession`. Child Agents receive no independent tool or timer. | `test/deepseek.test.ts` |
| L1 | Adapter contract | Initial, busy, idle, manual, and terminal reports use plugin-authored user messages through `agent.steer()` and never target another root Agent. | `test/deepseek.test.ts` |
| L2 | Adapter contract | Agent disposal and plugin unload remove tools, cancel timers, fence late delivery, and prevent a replacement Agent with the same session ID from inheriting watches. | `test/deepseek.test.ts` |
| L2 | Configuration | Load user-global config and auto-merge environment values only from inherited-process or Harness-home user provenance; reject project config and invoking-project `.env` without a host trust signal. | `test/deepseek.test.ts` plus `deepseek/extension.ts` |
| L2 | Skill API | Register exactly one canonical `monitor-pr` candidate at `BUNDLED_SKILL_RANK`; project and user providers can override it. Remove YAML frontmatter from returned content, instruct delegated children without the tool to hand ownership back to root, and dispose the provider on unload. | `test/deepseek.test.ts` and `scripts/check-pack.mjs` |
| L2 | Automated | Shared polling, feedback, readiness, labels, error rollback, and auto-merge safety remain host-neutral. | `test/{core,runtime,merge,deepseek}.test.ts` |
| L3 | Packaged bundle | npm archive has exact files, external host imports, sole public exports, copied canonical skill, `dsh.bundle.patch` metadata, and a patch inserting one plugin. Fresh consumer import and TypeScript compile pass. | Pass: 2026-09-12, `scripts/check-pack.mjs`, macOS / Node 22.23.2 |
| L3 | Actual host loader | `dsh plugin --profile web add` composes the packed bundle; `--dump-config` shows one plugin; full Web loader boot succeeds from the isolated profile. | Pass: 2026-09-12, Harness 0.1.5-rc.2 / Node 22.23.2 and 26.8.1 / macOS |
| L3 | Actual root Agent | A real root Agent exposes one `pr_monitor` tool and one skill; delegated child Agents get no independent registration. | Partial: real Headless root registered/executed start and stop and advertised the skill; actual child Agent not run |
| L3 | Model-driven host | A real Harness Agent starts a monitor and consumes a natively steered report. A Web conversation ends its turn and wakes for a later idle report without another user prompt. | Partial: controlled-provider Headless Agent consumed the busy initial report; delayed idle Web wake not run |
| L3 | Actual host / external | Merge a disposable PR after readiness handoff; original idle conversation gets one terminal report and monitoring stops. | Not run |
| L4 | Actual host | Busy/idle delivery, two tabs, clear/compact/resume, root replacement, child-agent calls, bundle unload/reload, and process shutdown preserve identity and stop fences. | Not run |
| L4 | External auto-merge | Global config and environment opt-in merge a disposable PR with title-only squash commit and marker. Project config cannot opt in. | Not run |
| L5 | Packaged / external | Install release from npm into supported Harness profiles on macOS/Linux/Windows and verify compatibility across the declared floor and current release. | Not run |

DeepSeek MCP exposes external tools but no conversation-bound asynchronous injection API, so it cannot implement
this adapter's delivery contract. The native Cordis route is mandatory. Host SDKs remain external `"*"` peers:
Harness's profile loader resolves them from its shared closure, while a nested `dsh-tools` dependency can create a
second scheduler-symbol realm. Plain Node import from the profile bypasses this host resolution and is not a loader
acceptance check. Agent identity is object identity, not only `agent.id`: a process can create a replacement for a
persisted session, and old monitors must not follow it.

Harness exposes root creation and Agent-scoped effects but no trustworthy project approval state. Repository config
is therefore intentionally unsupported. This restriction includes `.pr-monitor.json`, `.dsh/pr-monitor.json`, and
values from the invoking project's `.env`; the adapter resolves environment values through Harness's immutable
launch-provenance snapshot. The skill registry's bundle layer is host-global, so a delegated child may discover the
canonical skill while the root-scoped monitor tool is absent. The skill explicitly returns the PR target and
monitoring request to its parent rather than emulating the monitor. No fake Context, source import, npm archive check, or configuration dump satisfies
an actual-host/model-driven row.

## 2026-09-12 automated evidence

- `test/deepseek.test.ts` runs the real DeepSeek `defineTool()` argument wrapper against controlled Cordis/Agent
  services. It covers root-only registration, every action, skill rank/content, busy and idle steer delivery,
  cross-conversation isolation, terminal reporting, Agent disposal, same-ID replacement, timer fencing, plugin
  cleanup, package metadata, peer ranges, global config, and project-`.env` provenance rejection.
- TypeScript checks compile against exact 0.1.5-rc.2 Agent/launch-environment/LLM/skill/tool declarations and
  Cordis 4.0.2.
- `npm run pack:check` packed, installed, imported, and type-checked the DeepSeek artifact in a disposable consumer.
  `npm run host:check:deepseek` installed Harness 0.1.5-rc.2 and pnpm into an isolated directory, added the packed
  artifact to an isolated Web profile, verified exactly one composed layer plus bundle/skill contents, booted the
  complete Web loader on an ephemeral loopback port under Node 22 and 26, terminated it cleanly, then removed all
  temporary state. The same check ran a real Headless root Agent against a controlled loopback DeepSeek-compatible
  provider, fake `gh`, and an invoking project whose config files and `.env` attempted to enable auto-merge. The
  model selected `pr_monitor(start)`, received the native steered initial report, confirmed status remained global-only with
  auto-merge disabled, selected `pr_monitor(stop)`, and exposed `monitor-pr` in its request context. This proves
  root registration, real tool execution, busy report injection, skill advertisement, and cleanup without real
  credentials. It does not prove a
  delegated-child boundary, delayed idle Web wake, real GitHub, or authenticated provider behavior.
