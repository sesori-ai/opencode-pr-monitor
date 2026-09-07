"""PR Monitor plugin for Hermes Desktop, CLI and messaging gateway."""
from __future__ import annotations

import atexit
import json
from pathlib import Path
import threading

from .bridge import Bridge
from .desktop import DesktopRoute


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
        try:
            if not session_id:
                raise RuntimeError("Hermes did not provide a conversation identity")
            from agent.delegation_context import is_delegated_child_context
            if is_delegated_child_context():
                raise RuntimeError("Start PR Monitor in the owning conversation, not a delegated child")
            key, route, cwd = capture(session_id)
            with lock:
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

    def finalize(session_id="", **_):
        with lock:
            doomed = [key for key, bridge in bridges.items() if bridge.route.owns(session_id) or not bridge.route.alive()]
            stopped = [bridges.pop(key) for key in doomed]
        for bridge in stopped:
            bridge.close()

    def close_all():
        with lock:
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
