"""Synchronous Hermes tool calls and asynchronous, acknowledged report delivery."""
from __future__ import annotations

import contextvars
import json
import logging
from pathlib import Path
import queue
import subprocess
import threading

log = logging.getLogger(__name__)


class Bridge:
    def __init__(self, cwd: str, route):
        self.route = route
        self.cwd = cwd
        self._context = contextvars.copy_context()
        # Admission and shutdown share a gate. A delivery already inside the
        # host API drains before close returns; queued deliveries are rejected.
        self._delivery_lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._lock = threading.Lock()
        self._pending = {}
        self._sequence = 0
        self._closed = False
        self._process = subprocess.Popen(
            ["node", str(Path(__file__).parent / "dist" / "worker.mjs")],
            cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1,
        )
        threading.Thread(target=self._read, daemon=True, name="pr-monitor-results").start()
        threading.Thread(target=self._logs, daemon=True, name="pr-monitor-logs").start()

    def _send(self, message):
        with self._write_lock:
            if self._closed:
                raise RuntimeError("PR Monitor worker is stopped; start it again")
            self._process.stdin.write(json.dumps(message) + "\n")
            self._process.stdin.flush()

    def call(self, args, *, cwd=None):
        with self._lock:
            self._sequence += 1
            ident = self._sequence
            result = queue.Queue(maxsize=1)
            self._pending[ident] = result
        try:
            self._send({"type": "command", "id": ident, "action": args.get("action"), "cwd": cwd or self.cwd,
                        **({"pr": args["pr"]} if "pr" in args else {})})
            try:
                response = result.get(timeout=120)
            except queue.Empty:
                # A timed-out mutation must not continue invisibly. Stop this
                # worker; a later explicit start makes a fresh session.
                self.close()
                raise RuntimeError("PR Monitor command timed out; worker stopped") from None
            if "error" in response:
                raise RuntimeError(response["error"])
            return response["text"]
        finally:
            with self._lock:
                self._pending.pop(ident, None)

    def _deliver(self, message):
        try:
            with self._delivery_lock:
                if self._closed:
                    return
                self._context.copy().run(self.route.deliver, message["report"])
            response = {"type": "ack", "id": message["id"], "ok": True}
        except Exception as exc:
            response = {"type": "ack", "id": message["id"], "ok": False, "error": str(exc)}
        try:
            self._send(response)
        except (OSError, RuntimeError):
            pass

    def _read(self):
        try:
            for line in self._process.stdout:
                message = json.loads(line)
                if message.get("type") == "report":
                    # Delivery can submit a new model turn which immediately
                    # calls this tool. Never block the reader on that turn.
                    threading.Thread(target=self._deliver, args=(message,), daemon=True).start()
                elif message.get("type") == "result":
                    with self._lock:
                        pending = self._pending.get(message.get("id"))
                        if pending is not None:
                            pending.put_nowait(message)
        except Exception:
            log.exception("PR Monitor worker protocol failed")
        finally:
            self._process.stdout.close()
            self._closed = True
            with self._lock:
                for pending in self._pending.values():
                    try:
                        pending.put_nowait({"error": "PR Monitor worker exited; monitors stopped"})
                    except queue.Full:
                        pass

    def _logs(self):
        with self._process.stderr:
            for line in self._process.stderr:
                log.warning("%s", line.rstrip())

    def close(self):
        self._closed = True
        with self._delivery_lock:
            close_route = getattr(self.route, "close", None)
            if close_route is not None:
                close_route()
        with self._write_lock:
            try:
                self._process.stdin.close()
            except OSError:
                pass
        try:
            self._process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait(timeout=2)
