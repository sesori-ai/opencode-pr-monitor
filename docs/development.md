# Development and releases

[← README](../README.md)

Repository root is a private npm workspace coordinator. Each host adapter depends on shared runtime and core layers:

```text
adapter → runtime/ → core/
```

`core/` imports no host SDK. Adapters own host delivery, lifecycle, and configuration paths; `runtime/` owns shared
session orchestration.

## Repository map

| Path | Purpose |
|---|---|
| `core/` | PR state machine, GitHub normalization, activity, readiness, merge, reports, config |
| `runtime/` | Session registry, actions, timers, shared Node `gh` runner, tool contract |
| `skills/` | Canonical `monitor-pr` skill copied into push-host npm packages |
| `opencode/` | OpenCode adapter and `@sesori/pr-monitor-opencode` workspace |
| `pi/` | Shared Pi/OMP adapter and `@sesori/pr-monitor-pi` workspace |
| `claude-codex/` | Shared Claude Code/Codex Git-plugin root, hooks, commands, and MCP server |
| `hermes/` | Hermes Python plugin, Desktop compatibility seam, bundled Node worker, and skill |
| `.claude-plugin/` | Root Claude marketplace pointing to `claude-codex/` |
| `.agents/plugins/` | Root Codex marketplace pointing to `claude-codex/` |
| `docs/regression/` | Durable behavior, packaging, compatibility, and host acceptance matrices |
| `test/` | Core, runtime, and adapter regression tests |

Read [`AGENTS.md`](../AGENTS.md) before architecture changes. Every change—including documentation and agent
instructions—needs a concise entry under `[Unreleased]` in [`CHANGELOG.md`](../CHANGELOG.md).

## Setup and commands

```sh
npm ci
npm test             # core, runtime, and adapter regression tests
npm run typecheck    # core + runtime + all TypeScript adapters
npm run build        # all host artifacts
npm run version:check
npm run pack:check   # inspect, install, and import both npm tarballs
npm run host:check   # Pi and OMP real-loader checks
npm run clean        # remove ephemeral OpenCode/Pi output
npm run release:check
```

Current-host checks can also run independently:

```sh
OPENCODE_CLI="$(command -v opencode)" npm run host:check:opencode
OMP_VERSION=18.0.4 npm run host:check:omp
```

Use the current supported OMP version when it changes.

## Build artifacts

- OpenCode and Pi/OMP publish bundles in `opencode/dist/` and `pi/dist/`. They embed private `core/` and `runtime/`
  code and remain uncommitted.
- `claude-codex/dist/mcp-server.mjs` is committed because Git-plugin installation runs no build step. Rebuild and
  commit it after changing `claude-codex/src/`, `runtime/`, or `core/`.
- `hermes/dist/worker.mjs`, `hermes/dist/tool.json`, and copied Hermes skill output are committed. Run
  `npm run build:hermes` after changing Hermes, runtime, core, tool schema, or canonical skill behavior.
- `claude-codex/hooks/drain-spool.mjs` and `await-activity.mjs` ship as dependency-free source files. Keep their
  routing and state formats aligned with `claude-codex/src/spool.ts` and `session-state.ts`.
- Never commit generated OpenCode/Pi distribution or copied package skill output.

The OpenCode entry must keep one export because its loader invokes every export. Pi host imports remain external;
the package manifest owns skill discovery. Claude Code and Codex share one plugin root but use separate manifests.
Hermes Python owns conversation binding while its bundled Node worker owns monitor behavior.

## Local plugin checks

Use a checkout as a temporary Claude marketplace:

```text
/plugin marketplace add /path/to/pr-monitor-plugin
```

Use the same checkout as a Codex marketplace:

```sh
codex plugin marketplace add /path/to/pr-monitor-plugin
```

Package and host tests do not replace actual-host evidence. Follow the relevant regression rows when behavior,
delivery, packaging, or host compatibility changes.

## Regression catalog

[`docs/regression/`](regression/README.md) is the durable acceptance source:

- [`pull-request-monitoring.md`](regression/pull-request-monitoring.md) covers shared watch semantics, readiness,
  autonomous delivery, lifecycle, and configuration.
- [`plugin-installation.md`](regression/plugin-installation.md) covers npm/Git artifacts, host floors, skill
  discovery, loader compatibility, and lockstep release metadata.
- [`hermes.md`](regression/hermes.md) covers Hermes delivery, lifecycle, worker packaging, and actual-host evidence.

The catalogs distinguish automated, adapter, actual-host, and packaged/external proof. A source import does not prove
a packed artifact; a fake adapter does not prove host compatibility.

## Release model

One version spans:

- `@sesori/pr-monitor-opencode` on npm;
- `@sesori/pr-monitor-pi` on npm;
- Claude Code and Codex plugin manifests;
- Hermes plugin metadata and worker; and
- annotated Git tag `vX.Y.Z` for Git-plugin distribution.

Root workspace is private. No separate GitHub Release step is required.

### Before publishing

Complete required live-host rows—especially the live Claude release-host check in
[`plugin-installation.md`](regression/plugin-installation.md)—before release. Then use a clean checkout where local
`main` exactly matches `origin/main` and npm authentication can publish in the `@sesori` scope.

```sh
git fetch origin --tags
git pull --ff-only
npm whoami
```

### Publish

```sh
make publish X.Y.Z
```

Without a version, `make publish` prompts. The target stops at the first failure and performs:

1. clean/current-`main`, tag, npm login, and registry preflight checks;
2. version updates, CHANGELOG cut, committed bundles, and `Release vX.Y.Z` commit;
3. full tests, types, builds, packs, and host-loader checks;
4. push of `main`;
5. publication of both npm packages;
6. registry propagation verification; then
7. annotated tag creation and push.

Both npm packages are published and verified before the Git tag. npm versions are immutable, so never retry a
changed tarball under the same version.

`make bump X.Y.Z` performs only the version, changelog, build, and release-commit step on the current branch.

### Manual reference

If release automation itself needs diagnosis, reproduce its candidate checks before publishing:

```sh
npm ci
npm run release:check
OPENCODE_CLI="$(command -v opencode)" npm run host:check:opencode
OMP_VERSION=18.0.4 npm run host:check:omp
git diff --exit-code -- claude-codex/dist/mcp-server.mjs hermes/dist hermes/skills
```

Then preserve publish order:

```sh
npm publish --workspace @sesori/pr-monitor-opencode --access public
npm publish --workspace @sesori/pr-monitor-pi --access public
npm view @sesori/pr-monitor-opencode@X.Y.Z version
npm view @sesori/pr-monitor-pi@X.Y.Z version
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```
