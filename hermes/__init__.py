"""PR Monitor plugin for Hermes Desktop, CLI and messaging gateway."""
from __future__ import annotations

import atexit
from collections import OrderedDict
import json
from pathlib import Path
import threading
import weakref

from .bridge import Bridge
from .desktop import DesktopRoute


MAX_FINALIZED_IDENTITIES = 256


class NativeRoute:
    def __init__(self, ctx, session_id, session_key, cli):
        self.ctx, self.session_id, self.session_key, self.cli = ctx, session_id, session_key, cli

    def owns(self, session_id):
        return self.session_id == session_id

    def alive(self):
        if self.cli is not None:
            return (getattr(self.ctx._manager, "_cli_ref", None) is self.cli
                    and getattr(self.cli, "session_id", None) == self.session_id)
        return (getattr(self.ctx._manager, "_cli_ref", None) is None
                and bool(self.ctx._manager.has_gateway_message_injector))

    def deliver(self, report):
        if not self.alive() or not self.ctx.inject_message(report, session_key=self.session_key):
            raise RuntimeError("Hermes could not accept the report for its owning conversation")


def register(ctx):
    schema = json.loads((Path(__file__).parent / "dist" / "tool.json").read_text())
    bridges = {}
    lock = threading.RLock()
    closed = False
    admissions = {}
    # Recent retired native identities reject late host callbacks. In-flight
    # calls have independent cancellation tokens and never depend on eviction.
    finalized = OrderedDict()
    finalizing = {}

    def native_identity(cli):
        # CLI can resume a durable session in a new agent without emitting a
        # session-start hook. Weak references neither retain retired agents nor
        # confuse a replacement with a collected object's reused memory ID.
        if cli is None:
            return None
        return (weakref.ref(cli), weakref.ref(getattr(cli, "agent", None) or cli))

    def capture(session_id):
        from gateway.session_context import get_session_env
        from agent.runtime_cwd import resolve_agent_cwd
        sid = get_session_env("HERMES_UI_SESSION_ID")
        route = DesktopRoute.capture(session_id, sid)
        if route is not None:
            key = ("desktop", sid)
        else:
            manager = ctx._manager
            cli = getattr(manager, "_cli_ref", None)
            session_key = get_session_env("HERMES_SESSION_KEY")
            if cli is not None:
                if getattr(cli, "session_id", None) != session_id:
                    raise RuntimeError("Cannot prove ownership of the Hermes CLI conversation")
            elif not session_key or not manager.has_gateway_message_injector:
                raise RuntimeError("This Hermes host cannot deliver background reports. Use Desktop, CLI, or a messaging gateway; ACP is not supported.")
            elif not ctx._gateway_injection_allowed():
                raise RuntimeError("Enable plugins.entries.pr-monitor.allow_gateway_injection in Hermes config before starting a monitor")
            route = NativeRoute(ctx, session_id, session_key, cli)
            key = ("native", session_id)
        return key, route, str(resolve_agent_cwd().resolve())

    def handle(args, session_id="", **_):
        admission = None
        try:
            if not session_id:
                raise RuntimeError("Hermes did not provide a conversation identity")
            from agent.delegation_context import is_delegated_child_context
            if is_delegated_child_context():
                raise RuntimeError("Start PR Monitor in the owning conversation, not a delegated child")
            with lock:
                admission = threading.Event()
                admissions.setdefault(session_id, set()).add(admission)
            key, route, cwd = capture(session_id)
            with lock:
                if closed:
                    raise RuntimeError("PR Monitor plugin was unloaded")
                retired_native = (key[0] == "native" and session_id in finalized
                                  and finalized[session_id] == native_identity(route.cli))
                if session_id in finalizing or retired_native or admission.is_set() or not route.alive():
                    raise RuntimeError("Hermes conversation changed during monitor admission; retry in a live conversation")
                finalized.pop(session_id, None)
                bridge = bridges.get(key)
                if bridge is not None and (bridge._closed or not bridge.route.alive()):
                    bridge.close()
                    bridges.pop(key)
                    bridge = None
                if bridge is None:
                    if args.get("action") == "status":
                        return "No active PR monitors in this Hermes conversation."
                    if args.get("action") in ("stop", "flush"):
                        return "No active PR monitors in this Hermes conversation."
                    bridge = Bridge(cwd, route)
                    bridges[key] = bridge
            return bridge.call(args, cwd=cwd)
        except Exception as exc:
            return json.dumps({"error": str(exc)})
        finally:
            if admission is not None:
                with lock:
                    admissions[session_id].discard(admission)
                    if not admissions[session_id]:
                        del admissions[session_id]

    def finalize(session_id="", old_session_id=None, **_):
        # Gateway reset names the replacement in session_id, unlike CLI/TUI.
        retired_id = old_session_id or session_id
        with lock:
            for admission in admissions.get(retired_id, ()):
                admission.set()
            finalizing[retired_id] = finalizing.get(retired_id, 0) + 1
            if retired_id:
                finalized[retired_id] = native_identity(getattr(ctx._manager, "_cli_ref", None))
                finalized.move_to_end(retired_id)
                while len(finalized) > MAX_FINALIZED_IDENTITIES:
                    finalized.popitem(last=False)
            doomed = [key for key, bridge in bridges.items() if bridge.route.owns(retired_id) or not bridge.route.alive()]
            stopped = [bridges.pop(key) for key in doomed]
        try:
            for bridge in stopped:
                bridge.close()
        finally:
            with lock:
                finalizing[retired_id] -= 1
                if not finalizing[retired_id]:
                    del finalizing[retired_id]

    def close_all():
        nonlocal closed
        with lock:
            closed = True
            finalized.clear()
            stopped = list(bridges.values())
            bridges.clear()
        for bridge in stopped:
            bridge.close()

    ctx.register_tool(name="pr_monitor", toolset="pr-monitor", schema=schema, handler=handle,
                      description="Watch GitHub PRs and act on automatically delivered reports", emoji="🔎")
    ctx.register_hook("on_session_finalize", finalize)
    ctx.register_hook("on_session_reset", finalize)
    ctx.on_unload(close_all)
    atexit.register(close_all)
    ctx.on_unload(lambda: atexit.unregister(close_all))
    ctx.register_skill("monitor-pr", Path(__file__).parent / "skills" / "monitor-pr" / "SKILL.md")
    ctx.register_system_prompt_section("pr-monitor.workflow", "After opening a GitHub PR, load pr-monitor:monitor-pr with skill_view and call pr_monitor(action='start', pr='owner/repo#123'). Act on every [PR Monitor] report. The monitor owns waiting; end your turn when nothing needs action.")
