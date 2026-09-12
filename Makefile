# Release automation — one command, run on a clean, up-to-date main:
#
#   make publish                 (asks for the new version; `make publish 0.4.1` or VERSION=0.4.1 skips the prompt)
#   make bump [X.Y.Z]            just the version/CHANGELOG step, committed to the current branch
#
# In order, stopping at the first failure: preflight guards → write the version everywhere and cut the
# CHANGELOG section (committed to main as "Release vX.Y.Z" when anything changed) → full check matrix →
# push main → publish all three npm packages → verify the registry → create and push the annotated plugin tag.
# npm versions are immutable, which is why every publish and registry check happens before the tag.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# `make <target> X.Y.Z`: a dotted goal is taken as VERSION and otherwise ignored as a target (no real target has a dot).
VERSION_GOAL := $(strip $(foreach goal,$(MAKECMDGOALS),$(if $(findstring .,$(goal)),$(goal))))
VERSION ?= $(VERSION_GOAL)
TAG := v$(VERSION)
MANIFEST_VERSION := $(shell node -p "require('./opencode/package.json').version")
OPENCODE_CLI ?= $(shell command -v opencode || true)
OMP_VERSION ?= 18.0.4
REPO := sesori-ai/pr-monitor-plugin

# Output helpers: bold step banners, dim detail lines, green ticks, red failures.
B := $(shell tput bold 2>/dev/null || true)
D := $(shell tput dim 2>/dev/null || true)
G := $(shell tput setaf 2 2>/dev/null || true)
R := $(shell tput setaf 1 2>/dev/null || true)
N := $(shell tput sgr0 2>/dev/null || true)
step = printf '\n$(B)▶ %s$(N)\n' "$(1)"
ok   = printf '  $(G)✔$(N) %s\n' "$(1)"
fail = { printf '  $(R)✖ %s$(N)\n' "$(1)"; exit 1; }

.PHONY: help publish bump preflight push-main publish-npm verify-npm tag check \
        _publish _bump _preflight _push-main _publish-npm _verify-npm _tag

ifneq ($(VERSION_GOAL),)
$(VERSION_GOAL): ; @:
endif

## Public targets resolve the version (prompting when none was given) and delegate to the `_`-prefixed
## internal target of the same name in a child make, so every internal recipe sees VERSION set.
define with-version
@v="$(VERSION)"; if [ -z "$$v" ]; then \
  published="$$(npm view @sesori/pr-monitor-opencode version 2>/dev/null || echo none)"; \
  last_tag="$$(git describe --tags --abbrev=0 2>/dev/null || echo none)"; \
  printf '\n$(B)pr-monitor release$(N)\n'; \
  printf '  $(D)last published on npm$(N)  %s\n' "$$published"; \
  printf '  $(D)last plugin tag$(N)        %s\n' "$$last_tag"; \
  printf '  $(D)manifests currently$(N)    %s\n' "$(MANIFEST_VERSION)"; \
  printf '  $(D)branch$(N)                 %s @ %s\n\n' "$$(git branch --show-current)" "$$(git rev-parse --short HEAD)"; \
  read -r -p "$(B)What should the new version be?$(N) [$(MANIFEST_VERSION)] " answer </dev/tty; \
  v="$${answer:-$(MANIFEST_VERSION)}"; \
fi; \
echo "$$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$$' || $(call fail,$$v is not a semantic version); \
exec $(MAKE) --no-print-directory _$@ VERSION="$$v"
endef

publish bump preflight push-main publish-npm verify-npm tag:
	$(with-version)

_publish: _preflight _bump check _push-main _publish-npm _verify-npm _tag
	@printf '\n$(G)$(B)Released $(TAG)$(N)\n'
	@printf '  npm     https://www.npmjs.com/package/@sesori/pr-monitor-opencode/v/$(VERSION)\n'
	@printf '  npm     https://www.npmjs.com/package/@sesori/pr-monitor-pi/v/$(VERSION)\n'
	@printf '  npm     https://www.npmjs.com/package/@sesori/pr-monitor-deepseek/v/$(VERSION)\n'
	@printf '  plugin  https://github.com/$(REPO)/releases/tag/$(TAG)\n\n'

## Refuse to release anything that is not a clean, current main.
_preflight:
	@$(call step,1/7 Preflight for $(TAG))
	@test -z "$$(git status --porcelain)" || $(call fail,working tree is not clean — commit or stash first)
	@test "$$(git branch --show-current)" = main || $(call fail,run from main (currently on $$(git branch --show-current)))
	@git fetch -q origin main
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" || $(call fail,local main is not the latest origin/main — git pull first)
	@$(call ok,clean tree on main @ $$(git rev-parse --short HEAD) — matches origin/main)
	@! git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null || $(call fail,$(TAG) already exists locally)
	@! git ls-remote --exit-code --tags origin "refs/tags/$(TAG)" >/dev/null || $(call fail,$(TAG) already exists on origin)
	@$(call ok,tag $(TAG) is free)
	@user="$$(npm whoami 2>/dev/null)" || $(call fail,not logged in to npm — run npm login); $(call ok,npm login: $$user)
	@! npm view @sesori/pr-monitor-opencode@$(VERSION) version >/dev/null 2>&1 || $(call fail,@sesori/pr-monitor-opencode@$(VERSION) is already published)
	@! npm view @sesori/pr-monitor-pi@$(VERSION) version >/dev/null 2>&1 || $(call fail,@sesori/pr-monitor-pi@$(VERSION) is already published)
	@! npm view @sesori/pr-monitor-deepseek@$(VERSION) version >/dev/null 2>&1 || $(call fail,@sesori/pr-monitor-deepseek@$(VERSION) is already published)
	@$(call ok,$(VERSION) is not on the registry yet)

## One version across all three npm workspaces, the lockfile, both plugin manifests, the MCP server (and its committed
## bundle), and CHANGELOG.md — committed to main only if anything actually changed.
_bump:
	@$(call step,2/7 Version $(VERSION) everywhere)
	@node scripts/bump-version.mjs $(VERSION)
	@npm install --package-lock-only --ignore-scripts --no-audit --no-fund --silent
	@npm run --silent build:claude
	@npm run --silent build:hermes
	@npm run --silent version:check
	@grep -q '^## \[$(VERSION)\]' CHANGELOG.md || $(call fail,CHANGELOG.md has no [$(VERSION)] section)
	@if [ -n "$$(git status --porcelain)" ]; then \
	  git add -A && git commit -q -m "Release $(TAG)"; \
	  $(call ok,committed Release $(TAG): $$(git diff --stat HEAD~1 | tail -1 | sed 's/^ *//')); \
	else $(call ok,manifests already at $(VERSION); nothing to commit); fi

## The complete pre-publish matrix from the README, on a fresh install.
check:
	@$(call step,3/7 Checks (tests, types, builds, packs, host loaders))
	@npm ci --no-audit --no-fund --silent
	@npm run --silent release:check
	@if [ -n "$(OPENCODE_CLI)" ]; then OPENCODE_CLI="$(OPENCODE_CLI)" npm run --silent host:check:opencode; \
	  else printf '  $(D)opencode not on PATH; skipping current OpenCode host check$(N)\n'; fi
	@OMP_VERSION=$(OMP_VERSION) npm run --silent host:check:omp
	@git diff --exit-code --quiet -- claude-codex/dist/mcp-server.mjs hermes/dist hermes/skills || $(call fail,committed plugin artifacts are stale)
	@$(call ok,all checks passed)

## The release commit reaches origin before anything immutable is published.
_push-main:
	@$(call step,4/7 Push main)
	@git push -q origin main
	@$(call ok,origin/main @ $$(git rev-parse --short HEAD))

_publish-npm:
	@$(call step,5/7 Publish npm packages)
	@npm publish --workspace @sesori/pr-monitor-opencode --access public
	@$(call ok,@sesori/pr-monitor-opencode@$(VERSION))
	@npm publish --workspace @sesori/pr-monitor-pi --access public
	@$(call ok,@sesori/pr-monitor-pi@$(VERSION))
	@npm publish --workspace @sesori/pr-monitor-deepseek --access public
	@$(call ok,@sesori/pr-monitor-deepseek@$(VERSION))

## The registry's read replicas lag a publish by up to a few minutes, so poll rather than fail on first sight.
NPM_VERIFY_ATTEMPTS ?= 30   # x 10s = 5 minutes
_verify-npm:
	@$(call step,6/7 Verify registry)
	@for pkg in @sesori/pr-monitor-opencode @sesori/pr-monitor-pi @sesori/pr-monitor-deepseek; do \
	  n=0; until [ "$$(npm view $$pkg@$(VERSION) version 2>/dev/null)" = "$(VERSION)" ]; do \
	    n=$$((n + 1)); [ $$n -lt $(NPM_VERIFY_ATTEMPTS) ] || $(call fail,$$pkg@$(VERSION) not served after $(NPM_VERIFY_ATTEMPTS) attempts); \
	    printf '  $(D)waiting for %s@%s to replicate (%d/%d)$(N)\n' "$$pkg" "$(VERSION)" "$$n" "$(NPM_VERIFY_ATTEMPTS)"; sleep 10; \
	  done; $(call ok,$$pkg@$(VERSION)); \
	done

_tag:
	@$(call step,7/7 Tag $(TAG))
	@git tag -a $(TAG) -m "$(TAG)"
	@git push -q origin $(TAG)
	@$(call ok,$(TAG) pushed)
