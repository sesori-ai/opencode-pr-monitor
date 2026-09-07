# Hermes monitoring and installation

The `hermes/` Git plugin contains a Python adapter and committed Node bundle using the shared
`runtime/MonitorSession` and `core/PrWatch`. Desktop/TUI compatibility is isolated in `hermes/desktop.py`.
Highest level: L5. Result vocabulary and proof boundaries follow [README.md](README.md).

| Level | Boundary | Requirement | Evidence / status |
|---|---|---|---|
| L1 | Adapter contract | Register all six actions, one workflow skill, and unload/finalize/reset cleanup; do not stop on ordinary turn completion. | `test/hermes_adapter_test.py` |
| L2 | Adapter contract | Two conversations and profiles keep separate workers, config, and delivery; reject absent identity, delegated children, ACP, stale/replaced records, and disconnected transports. | `test/hermes_adapter_test.py` |
| L2 | Packaged worker | Start, report acknowledgement/failure, retry, merge/close, stop, invalid input and worker exit pass through `hermes/dist/worker.mjs`. No live GitHub mutations. | `test/hermes_adapter_test.py` with a controlled `gh` executable on macOS/Linux |
| L3 | Actual host loader | Installed Hermes discovers the copied Git plugin, tool, namespaced skill and prompt section; unload removes registrations. | Pass: 2026-09-07, Hermes 9a84bee265da, macOS / Python 3.11.16 |
| L3 | Model-driven Desktop gateway | A real model starts a monitor, ends its turn, and wakes for a later simulated merge report. | Pass: 2026-09-07, Hermes 9a84bee265da, macOS / Python 3.11.16 / Node 26.8.1 |
| L3 | Actual host | Real model-driven CLI and messaging-gateway idle delivery, including injection consent. | Not run |
| L3 | Actual host / external | Merge a disposable PR after readiness handoff; the original idle Desktop conversation gets one terminal report and monitoring stops. | Not run |
| L4 | Actual host | Switching tabs/profiles, compression, finalize/reset, plugin unload, host restart, transport reconnect and two concurrent conversations preserve ownership and stop fences. | Not run |
| L4 | Actual host | Test Desktop process-isolation settings. A worker without the live gateway must reject start rather than claim delivery. | Not run |
| L5 | Packaged / external | Install the Hermes subdirectory from the release tag with no repository dependencies/build; exercise all supported hosts on macOS/Linux and version-update compatibility. | Not run |

Desktop API admission is narrower than a completed model turn: a successful background-turn admission schedules or
starts work, while provider failures remain the host's responsibility. The public Python plugin injection API
currently omits Desktop; its private gateway compatibility seam must be rechecked against changed Hermes builds.
No source import or fake host test satisfies an actual-host row.

## 2026-09-07 evidence

- `npm test`: 73 Node test cases, including 22 Python adapter/worker cases. Fake GitHub execution is isolated
  to temporary test directories. Unit contracts cover idle/busy delivery, attachment preservation, profile/cwd
  isolation, a failed startup report retry, terminal cleanup, closed/reused records and worker exit. Lifecycle
  race cases also cover capture during finalization, late calls during unload/cleanup, CLI resume, gateway reset
  identities, report draining on close, and a busy Desktop route closing before admission. Unrelated finalization
  does not cancel another conversation's admission, and cache eviction cannot revive an in-flight retired call.
- Hermes's own `PluginManager.discover_and_load()` loaded a copied `hermes/` artifact from an isolated enabled
  profile; the tool, namespaced skill and prompt section were discovered and removed on unload. No build or
  repository dependencies were available inside the copied plugin.
- A real Hermes TUI/Desktop gateway process loaded that copied plugin in an isolated profile with the existing
  model login. The model called `pr_monitor(start)` against a simulated `gh`; after its first completed turn the
  fixture changed to `MERGED`. A second model turn acknowledged the terminal report without a user prompt or
  additional tool call. The host process, temporary profile, fixture and child monitors were cleaned up.
- This proves the model-driven gateway path, not Electron rendering, a real GitHub merge, or all lifecycle
  variants. The unrun rows above remain unrun. No credentials or transcripts are retained in the repository.
