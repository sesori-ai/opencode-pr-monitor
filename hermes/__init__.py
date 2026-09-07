"""Desktop/TUI PR monitoring and host-independent label actions for Hermes."""
from __future__ import annotations

import atexit
import json
from pathlib import Path
import threading

from .bridge import Bridge
from .desktop import DesktopRoute


class ActionRoute:
    """Standalone label actions need lifecycle ownership, but no report route."""
    def __init__(self, session_id):
        self.session_id = session_id

    def owns(self, session_id):
        return self.session_id == session_id

    def alive(self):
        return True

    def deliver(self, report):
        raise RuntimeError("A standalone label action cannot deliver monitor reports")


def register(ctx):
    schema = json.loads((Path(__file__).parent / "dist" / "tool.json").read_text())
    bridges = {}
    lock = threading.RLock()
    closed = False
    admissions = {}
    finalizing = {}

    def capture(session_id):
        from gateway.session_context import get_session_env
        from agent.runtime_cwd import resolve_agent_cwd
        sid = get_session_env("HERMES_UI_SESSION_ID")
        route = DesktopRoute.capture(session_id, sid)
        if route is None:
            raise RuntimeError("Background PR monitoring requires Hermes Desktop/TUI. CLI, messaging gateways and ACP do not provide conversation-bound report delivery; standalone mark_ready/unmark_ready actions remain available.")
        return ("desktop", sid), route, str(resolve_agent_cwd().resolve())

    def capture_action(session_id):
        from agent.runtime_cwd import resolve_agent_cwd
        from gateway.session_context import get_session_env
        cwd = str(resolve_agent_cwd().resolve())
        sid = get_session_env("HERMES_UI_SESSION_ID")
        with lock:
            key = ("desktop", sid)
            bridge = bridges.get(key)
            if bridge is not None and not bridge._closed and bridge.route.owns(session_id) and bridge.route.alive():
                return key, bridge.route, cwd
        return ("action", object()), ActionRoute(session_id), cwd

    def handle(args, session_id="", **_):
        admission = None
        action_bridge = None
        is_ready_action = args.get("action") in ("mark_ready", "unmark_ready")
        try:
            if not session_id and not is_ready_action:
                raise RuntimeError("Hermes did not provide a conversation identity")
            from agent.delegation_context import is_delegated_child_context
            if is_delegated_child_context():
                raise RuntimeError("Start PR Monitor in the owning conversation, not a delegated child")
            with lock:
                admission = threading.Event()
                admissions.setdefault(session_id, set()).add(admission)
            key, route, cwd = capture_action(session_id) if is_ready_action else capture(session_id)
            with lock:
                if closed:
                    raise RuntimeError("PR Monitor plugin was unloaded")
                if session_id in finalizing or admission.is_set() or (not is_ready_action and not route.alive()):
                    raise RuntimeError("Hermes conversation changed during monitor admission; retry in a live conversation")
                bridge = bridges.get(key)
                if bridge is not None and (bridge._closed or (not is_ready_action and not bridge.route.alive())):
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
                    if key[0] == "action":
                        action_bridge = (key, bridge)
            return bridge.call(args, cwd=cwd)
        except Exception as exc:
            return json.dumps({"error": str(exc)})
        finally:
            with lock:
                if admission is not None:
                    admissions[session_id].discard(admission)
                    if not admissions[session_id]:
                        del admissions[session_id]
                if action_bridge is not None:
                    key, bridge = action_bridge
                    if bridges.get(key) is bridge:
                        bridges.pop(key)
            if action_bridge is not None:
                action_bridge[1].close()

    def finalize(session_id="", old_session_id=None, **_):
        # Some reset hooks identify a replacement; prefer an explicit old ID.
        retired_id = old_session_id or session_id
        with lock:
            for admission in admissions.get(retired_id, ()):
                admission.set()
            finalizing[retired_id] = finalizing.get(retired_id, 0) + 1
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
    ctx.register_system_prompt_section("pr-monitor.workflow", "Background monitoring requires Hermes Desktop/TUI; other hosts can use standalone mark_ready/unmark_ready actions. In Desktop/TUI, after opening a GitHub PR, load pr-monitor:monitor-pr with skill_view and call pr_monitor(action='start', pr='owner/repo#123'). Act on every [PR Monitor] report. The monitor owns waiting; end your turn when nothing needs action.")
