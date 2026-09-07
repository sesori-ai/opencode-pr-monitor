"""Compatibility seam for the already-running Hermes Desktop/TUI gateway.

Use its background-turn entry point with explicit empty attachments. The user
prompt RPC consumes staged attachments, so it is unsuitable for notifications.
Never start a gateway or resume a closed conversation to deliver a report.
"""
from __future__ import annotations

import sys
import threading
import time
import uuid


class DesktopRoute:
    def __init__(self, server, sid: str, record: dict):
        self.server, self.sid, self.record = server, sid, record
        self._cancel = threading.Event()

    @classmethod
    def capture(cls, session_id: str, ui_session_id: str):
        server = sys.modules.get("tui_gateway.server")
        if server is None or not ui_session_id:
            return None
        required = ("_run_prompt_submit", "_ac_try_correction", "_transport_is_dead", "_session_uses_compute_host")
        if any(not callable(getattr(server, name, None)) for name in required):
            raise RuntimeError("This Hermes Desktop build lacks the background-turn delivery interface")
        with server._sessions_lock:
            record = server._sessions.get(ui_session_id)
            if not record or record.get("_finalized") or record.get("_closing"):
                raise RuntimeError("The owning Hermes Desktop conversation is no longer live")
            owner = getattr(record.get("agent"), "session_id", None) or record.get("session_key")
            if not session_id or owner != session_id:
                raise RuntimeError("Cannot prove ownership of the Hermes Desktop conversation")
            if record.get("transport") is None:
                raise RuntimeError("The Hermes Desktop conversation has no delivery transport")
            if server._session_uses_compute_host(record):
                raise RuntimeError("PR Monitor requires Hermes Desktop dashboard.turn_isolation: false")
        return cls(server, ui_session_id, record)

    def alive(self) -> bool:
        with self.server._sessions_lock:
            return (not self._cancel.is_set() and self.server._sessions.get(self.sid) is self.record
                    and not self.record.get("_finalized") and not self.record.get("_closing"))

    def owns(self, session_id: str) -> bool:
        return session_id in (self.record.get("session_key"),
                              getattr(self.record.get("agent"), "session_id", None))

    def close(self):
        self._cancel.set()

    def deliver(self, report: str) -> None:
        from tui_gateway.transport import bind_transport, reset_transport
        claimed = False
        with self.server._sessions_lock:
            if not self.alive():
                raise RuntimeError("The owning Hermes Desktop conversation closed or was replaced")
            if self.server._session_uses_compute_host(self.record):
                raise RuntimeError("Hermes Desktop turn isolation changed; restart monitoring in a supported host")
            transport = self.record.get("transport")
            if transport is None or self.server._transport_is_dead(transport):
                raise RuntimeError("The Hermes Desktop delivery transport is disconnected")
            with self.record["history_lock"]:
                busy = bool(self.record.get("running"))
                if not busy:
                    if self.record.get("queued_prompt"):
                        raise RuntimeError("Hermes has queued user input; retry this report after it is admitted")
                    self.record["running"] = True
                    self.record["_turn_cancel_requested"] = False
                    self.record["last_active"] = time.time()
                    claimed = True
        token = bind_transport(transport)
        rid = "pr-monitor-" + uuid.uuid4().hex
        try:
            if busy:
                # Native redirect admits a correction during model I/O, or a
                # steer during tool execution. Never hold history_lock around
                # provider cancellation, and never await the current turn: a
                # monitor tool call in that turn could otherwise deadlock.
                agent = self.record.get("agent")
                if getattr(agent, "_supports_active_turn_redirect", False) is not True:
                    raise RuntimeError("This Hermes agent cannot accept active-turn reports")
                result = self.server._ac_try_correction(rid, self.record, agent, "redirect", report, "redirected")
                if result is None:
                    raise RuntimeError("Hermes is between turns; retry report delivery")
                return
            with self.server._sessions_lock:
                if not self.alive():
                    raise RuntimeError("The owning Hermes Desktop conversation closed or was replaced")
                # The host admits synchronously, schedules its model thread and
                # returns True. Empty image_paths preserves staged attachments.
                accepted = self.server._run_prompt_submit(rid, self.sid, self.record, report, image_paths=[])
                if accepted is not True:
                    raise RuntimeError("Hermes Desktop rejected the background report turn")
        except Exception:
            if claimed:
                with self.record["history_lock"]:
                    self.record["running"] = False
            raise
        finally:
            reset_transport(token)
