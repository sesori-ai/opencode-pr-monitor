# Plugin Installation And Release Artifacts

## Capability

One repository publishes two independently installable npm artifacts and one Claude Code Git plugin while keeping
private core/runtime code in lockstep. OpenCode has its own package; Pi and OMP intentionally share one package with
two entries; Claude Code installs from the repository plugin root without a build step.

The highest required regression level is **L5 Full** because release confidence depends on exact packed contents,
real host loaders, package registries/Git installation, and synchronized metadata.

## Distribution Contracts

### Private workspace root

- The root `package.json` is private at version `0.0.0` and coordinates `opencode/` and `pi/` workspaces. It must not
  be published and is intentionally excluded from product-version equality.
- `core/` and `runtime/` are private implementation source, not a public package. Each npm build bundles reachable
  private modules so a release cannot depend on an unpublished core version.
- OpenCode/Pi `dist/` and generated package skill copies are ephemeral and ignored. Claude Code's MCP bundle is
  committed because Git plugin installation runs no build.

### `@sesori/pr-monitor-opencode`

Install through OpenCode configuration:

```jsonc
{
  "plugin": ["@sesori/pr-monitor-opencode"]
}
```

Required floor: OpenCode 1.17 or newer, plus authenticated `gh`.

The tarball contains exactly:

```text
LICENSE
README.md
dist/index.d.ts
dist/index.js
package.json
skills/monitor-pr/SKILL.md
```

- `.` and `./server` both expose the sole runtime export `PrMonitorPlugin` with the compiler-emitted declaration.
  `./package.json` is exported for metadata consumers.
- `@opencode-ai/plugin` remains a declared runtime dependency. Private core/runtime files are embedded in the ESM
  bundle and never appear as install-time package dependencies.
- Build output copies the canonical push-host skill, and the adapter injects that packaged directory exactly once.

### `@sesori/pr-monitor-pi`

Install in Pi:

```sh
pi install npm:@sesori/pr-monitor-pi
```

Install the same package in OMP:

```sh
omp plugin install @sesori/pr-monitor-pi
```

Required floors: Pi 0.84.2 with Node.js 22.19 or newer; OMP 18.0.3 with its bundled Bun runtime; authenticated `gh`
for monitoring actions.

The tarball contains exactly:

```text
LICENSE
README.md
dist/index.d.ts
dist/index.js
dist/omp.d.ts
dist/omp.js
package.json
skills/monitor-pr/SKILL.md
```

- `.` is the upstream Pi extension and `./omp` is the thin OMP compatibility entry. Both are typed default exports;
  `./package.json` is exported.
- Pi host SDKs and TypeBox remain peer dependencies and external to both bundles. OMP rewrites compatible upstream
  imports rather than requiring a second package or monitor implementation.
- `package.json#pi` declares the upstream entry and skill. `package.json#omp` declares only the OMP entry because
  OMP's `resources_discover` handler supplies the same skill path exactly once.

### Claude Code Git plugin

Install from the marketplace:

```text
/plugin marketplace add sesori-ai/pr-monitor-plugin
/plugin install pr-monitor@sesori
```

- Root `.claude-plugin/marketplace.json` points to `./claude-codex`, which is the complete plugin root. Its tracked
  payload contains exactly:

```text
.claude-plugin/plugin.json
.codex-mcp.json
.codex-plugin/plugin.json
.mcp.json
commands/ready.md
commands/status.md
commands/unready.md
commands/watch.md
dist/mcp-server.mjs
hooks/await-activity.mjs
hooks/codex-hooks.json
hooks/drain-spool.mjs
hooks/hooks.json
skills/monitor-pr/SKILL.md
src/mcp-server.ts
src/push.ts
src/session-state.ts
src/spool.ts
```

- Claude discovers `.mcp.json`, `hooks/hooks.json`, `commands/`, and `skills/` by convention. Runtime paths use
  `${CLAUDE_PLUGIN_ROOT}` and must not depend on the repository's checkout depth.
- `claude-codex/dist/mcp-server.mjs` is committed and must reproduce from `claude-codex/src/`, `runtime/`, and `core/`.
  Hooks remain dependency-free source and are not part of that esbuild bundle.
- The conventional Claude skill is waiter-aware and intentionally differs from the canonical OpenCode/Pi/OMP
  push-host skill. Each installed host still discovers exactly one `monitor-pr` skill.

### Codex plugin

Install from the marketplace:

```text
codex plugin marketplace add sesori-ai/pr-monitor-plugin
codex plugin add pr-monitor@sesori
```

- Root `.agents/plugins/marketplace.json` points at the same `./claude-codex` root; `.codex-plugin/plugin.json`
  carries the same version and references `./skills/`, `./hooks/codex-hooks.json`, and `./.codex-mcp.json`.
- `.codex-mcp.json` launches `./dist/mcp-server.mjs` (shebang, mode 755) with `cwd: "."` and `--codex`. Codex expands
  no placeholders in args/env, so the bundle must stay executable and self-locating.
- The Codex hook manifest is generated from the Claude manifest with `--codex` and a SessionStart registration
  hook. Both hosts execute the same hook/waiter implementation. Rebuild it with `npm run build:claude`.
- Installation and hook trust are separate acceptance steps: an enabled plugin with four untrusted hooks must
  remain unregistered and refuse monitor startup. `/hooks` must expose `SessionStart`, `UserPromptSubmit`,
  `PostToolUse`, and `Stop` for explicit review; changed hook definitions require fresh approval.
- Setup guidance must cover clients without a hook-review UI: use Codex CLI on the same host, with the same OS user,
  `CODEX_HOME`, and plugin installation, then return to the original conversation and trigger a hook event.
  Do not prepopulate registration files or bypass hook trust to satisfy this check.
- Live Codex 0.153.4 app-server verification on macOS (2026-09-07): `hooks/list` showed all four PR Monitor hooks
  enabled but untrusted. Reviewing them in Codex CLI attached to the same app-server persisted trust; a subsequent
  tool event in the existing Sesori conversation created its registration, and `pr_monitor(status)` succeeded.
  This verifies trust recovery and registration, not PR report delivery or the idle Stop/waiter loop.
- Host floor: codex-cli 0.153.0 (plugins, hooks stable). Verified there: install from a local marketplace, MCP server
  spawn with the plugin-root cwd and verbatim args, hook trust prompt, and `UserPromptSubmit`/`SessionStart` hook
  firing with `${CLAUDE_PLUGIN_ROOT}` expanded. A model-driven Codex 0.153.4 `exec` smoke test additionally verified
  real thread metadata, conversation config loading, PostToolUse report injection, `mark_ready`, and stop with
  disposable hook state and a fake GitHub backend. Multi-conversation isolation and Stop/waiter scoping have
  MCP/hook integration coverage; the live Codex app UI and model-driven idle Stop/waiter loop were not exercised.

## Release Metadata And Order

One product version must match across:

- `opencode/package.json` and its `package-lock.json` workspace entry;
- `pi/package.json` and its lockfile workspace entry;
- `claude-codex/.claude-plugin/plugin.json`;
- `claude-codex/.codex-plugin/plugin.json`; and
- the MCP server version in `claude-codex/src/mcp-server.ts`.

The private root stays `0.0.0`. `npm run version:check` rejects any product drift. Release notes remain under
`Unreleased` until a separate release change assigns them to a version.

From a clean release commit:

1. Complete every required matrix row below from the clean release commit, including minimum/current OpenCode,
   Pi, and OMP loaders and the live Claude release-host session. Run test/type/build/version/pack/host checks and
   confirm rebuilding leaves the committed Claude bundle clean.
2. Publish both npm workspaces only after the complete matrix is `Pass`. A failure stops the release before any Git
   tag is created.
3. Create and push one annotated `vX.Y.Z` tag for the Claude Git plugin only after both npm publishes succeed.

npm versions are immutable. First publication also requires permission to create public packages in the `@sesori`
scope, so package name/version/access and exact tarball contents must be checked before publishing.

## Configuration Installation Contract

No installer writes project monitor configuration. Users may add `.pr-monitor.json`; host fallbacks are:

- OpenCode: project/worktree `.opencode/pr-monitor.json`;
- Claude Code: `.claude/pr-monitor.json`, then `.opencode/pr-monitor.json`;
- trusted Pi/OMP: `${CONFIG_DIR_NAME}/pr-monitor.json`, then `.opencode/pr-monitor.json`.

Pi must not read project-local configuration before project trust. Package installation must not create a daemon,
persistent watch registry, credential file, copied repository skill, or host-specific core package.

## Regression Levels

- **L1 Smoke:** Root stays private; both workspace manifests and the Claude plugin manifest parse; expected source
  entries exist.
- **L2 Routine:** Builds emit typed entries and exact skill copies; version, license, export, dependency, and
  committed-bundle checks pass.
- **L3 Release:** Both npm tarballs install in disposable consumers; every export/manifest imports; Claude MCP starts
  over stdio and hooks parse.
- **L4 Extended:** Actual minimum/current OpenCode, Pi, and OMP loaders discover one tool/skill on required OS rows;
  Claude installs from a checkout.
- **L5 Full:** Registry-equivalent tarballs and the Claude Git root run cross-host monitoring; publish
  ordering/version evidence and cleanup are recorded.

## Required Matrix

- **OpenCode:** actual minimum/current loaders on Linux and macOS; typed package install/import on Windows.
- **Claude Code:** packaged plugin-root discovery and one live release-host session on macOS or Linux; deterministic
  MCP/hook checks on the CI host.
- **Pi:** minimum/current loaders on Linux and macOS plus Windows loader/package smoke.
- **OMP:** minimum/current compatibility loaders on Linux and macOS plus Windows loader/package smoke.
- **Release contents:** both tarballs, the Claude plugin root, lockstep metadata, generated-skill equality, license
  equality, dependency closure, and reproducible bundles from one clean commit.

A loader/source check proves only its named host and platform. npm pack output without a disposable install does not
prove exports or peer closure. A local Claude source run does not prove the committed Git plugin artifact.

## Exploration Guidance

Vary global versus project installation, pinned versus unpinned npm specs, clean versus warm host package caches,
paths containing spaces/shell metacharacters, and host reload after installation. Inspect archives rather than the
working tree. Exercise both Pi entries from one tarball and verify no host discovers both skill mechanisms.

For release rehearsal, vary a deliberately mismatched manifest/lock/MCP version, a missing generated skill, a changed
license, a stale Claude bundle, a missing peer, and an npm publish failure before tag creation.

## Failure Signals

- The private root can publish, an npm archive contains source/private modules or omits a declared entry, or a packed
  consumer requires undeclared local files.
- OpenCode exports anything besides `PrMonitorPlugin`; Pi/OMP entries are untyped or load separate monitor cores.
- A package omits or duplicates `monitor-pr`, OMP receives both manifest and resource-discovered copies, or Claude
  receives the push-host skill without waiter instructions.
- Product versions diverge, unreleased behavior is attributed to an already published version, or a release tag is
  created before both npm artifacts succeed.
- Rebuilding changes the committed Claude bundle unexpectedly, generated npm output is committed, or a plugin path
  works only from the source checkout.

## Known Limitations

- `npm pack` and local loader checks cannot prove registry permissions, registry propagation, host network caches, or
  future host compatibility. Record those rows as partial unless the corresponding external check ran.
- OMP compatibility is intentionally tied to the shared upstream-Pi package and its documented rewrite layer; there
  is no separately versioned OMP npm artifact.
- Watches are not persisted by installation. Restarting any host requires starting monitors again.

## Sources

`package.json`, `package-lock.json`, `opencode/package.json`, `pi/package.json`,
`claude-codex/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `claude-codex/.mcp.json`,
`scripts/build-*.mjs`, `scripts/check-pack.mjs`, `scripts/check-versions.mjs`, `scripts/check-*-loader.mjs`,
`skills/monitor-pr/SKILL.md`, `opencode/index.ts`, `pi/index.ts`, `pi/omp.ts`, and `AGENTS.md`.

## Hermes Git plugin

Install `sesori-ai/pr-monitor-plugin/hermes` with the Hermes plugin installer. The subdirectory contains its own
`plugin.yaml`, Python entry/bridge/Desktop adapter, committed `dist/worker.mjs` and `dist/tool.json`, and the
canonical `skills/monitor-pr/SKILL.md` copy. It requires Node.js and authenticated gh on the backend, but no npm
installation or build at install time. Version metadata participates in `version:check` and `bump-version.mjs`.
See [Hermes acceptance matrix](hermes.md) for host boundaries and current coverage.
