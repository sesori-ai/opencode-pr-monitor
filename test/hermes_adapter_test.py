"""Hermes adapter contracts; no installed host or network needed."""
from __future__ import annotations

import contextvars
import json
import os
from pathlib import Path
import queue
import shutil
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hermes import NativeRoute, register
from hermes.bridge import Bridge
from hermes.desktop import DesktopRoute


class DesktopTests(unittest.TestCase):
    def setUp(self):
        self.bound = contextvars.ContextVar("test_transport", default=None)
        self.messages = []
        self.record = {"session_key": "stored-a", "agent": types.SimpleNamespace(session_id="stored-a", _supports_active_turn_redirect=True),
                       "transport": object(), "running": False, "history_lock": threading.Lock(), "attached_images": ["unsent.png"]}
        self.other = {"session_key": "stored-b", "transport": object()}
        self.server = types.SimpleNamespace(
            _sessions={"ui-a": self.record, "ui-b": self.other}, _sessions_lock=threading.RLock(),
            _session_uses_compute_host=lambda r: False, _transport_is_dead=lambda t: getattr(t, "_closed", False),
            _run_prompt_submit=self.handle, _ac_try_correction=self.correct,
        )
        transport = types.SimpleNamespace(bind_transport=self.bound.set, reset_transport=self.bound.reset)
        self.modules = patch.dict(sys.modules, {"tui_gateway": types.ModuleType("tui_gateway"),
            "tui_gateway.server": self.server, "tui_gateway.transport": transport})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def handle(self, rid, sid, record, report, *, image_paths):
        self.messages.append((sid, report, self.bound.get(), image_paths))
        self.assertIs(record, self.record)
        self.assertTrue(record["running"])
        record["running"] = False  # model execution is outside this contract fixture
        return True

    def correct(self, rid, record, agent, method, text, status):
        self.assertEqual(method, "redirect")
        self.assertIs(record, self.record)
        self.messages.append(("ui-a", text, self.bound.get(), []))
        return {"result": {"status": status}}

    def test_idle_and_busy_delivery_keeps_original_session_and_transport(self):
        route = DesktopRoute.capture("stored-a", "ui-a")
        route.deliver("[PR Monitor] merged")
        replacement_transport = object()
        self.record["transport"] = replacement_transport
        self.record["running"] = True
        route.deliver("[PR Monitor] second PR")
        self.assertTrue(self.record["running"])
        self.assertEqual([m[0] for m in self.messages], ["ui-a", "ui-a"])
        self.assertIs(self.messages[-1][2], replacement_transport)
        self.assertTrue(all(m[3] == [] for m in self.messages))
        self.assertEqual(self.record["attached_images"], ["unsent.png"])
        self.assertIsNone(self.bound.get())

    def test_busy_transition_failure_never_releases_the_users_turn(self):
        route = DesktopRoute.capture("stored-a", "ui-a")
        self.record["running"] = True
        self.server._ac_try_correction = lambda *a: None
        with self.assertRaisesRegex(RuntimeError, "between turns"):
            route.deliver("retry")
        self.assertTrue(self.record["running"])
        route.close()
        with self.assertRaises(RuntimeError):
            route.deliver("cancelled")
        self.assertFalse(self.messages)

    def test_foreign_subagent_and_reused_runtime_id_are_refused(self):
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            DesktopRoute.capture("stored-b", "ui-a")
        route = DesktopRoute.capture("stored-a", "ui-a")
        self.server._sessions["ui-a"] = dict(self.record)
        with self.assertRaisesRegex(RuntimeError, "replaced"):
            route.deliver("must not arrive")
        self.assertFalse(self.messages)

    def test_closed_disconnected_and_rejected_deliveries_fail(self):
        route = DesktopRoute.capture("stored-a", "ui-a")
        self.record["_finalized"] = True
        with self.assertRaises(RuntimeError):
            route.deliver("closed")
        self.record["_finalized"] = False
        self.record["transport"] = types.SimpleNamespace(_closed=True)
        with self.assertRaisesRegex(RuntimeError, "disconnected"):
            route.deliver("disconnected")
        self.record["transport"] = object()
        self.server._run_prompt_submit = lambda *a, **k: False
        with self.assertRaisesRegex(RuntimeError, "rejected"):
            route.deliver("rejected")
        self.assertIsNone(self.bound.get())

    def test_compression_tracks_live_record_and_finalization_identity(self):
        route = DesktopRoute.capture("stored-a", "ui-a")
        self.record["agent"].session_id = "continuation-a"
        self.assertTrue(route.owns("continuation-a"))
        route.deliver("after compression")
        self.assertEqual(len(self.messages), 1)

    def test_acp_never_imports_a_desktop_server(self):
        with patch.dict(sys.modules, {"tui_gateway.server": None}):
            self.assertIsNone(DesktopRoute.capture("stored-a", "ui-a"))


class NativeTests(unittest.TestCase):
    def test_cli_does_not_inject_into_replacement_conversation(self):
        cli = types.SimpleNamespace(session_id="a")
        sent = []
        ctx = types.SimpleNamespace(_manager=types.SimpleNamespace(_cli_ref=cli),
            inject_message=lambda text, **_: sent.append(text) or True)
        route = NativeRoute(ctx, "a", "", cli)
        route.deliver("first")
        cli.session_id = "b"
        with self.assertRaises(RuntimeError):
            route.deliver("foreign")
        self.assertEqual(sent, ["first"])

    def test_gateway_rejection_propagates(self):
        ctx = types.SimpleNamespace(_manager=types.SimpleNamespace(has_gateway_message_injector=True),
            inject_message=lambda *a, **k: False)
        with self.assertRaises(RuntimeError):
            NativeRoute(ctx, "a", "gateway-a", None).deliver("retry me")


class RegistrationTests(unittest.TestCase):
    def test_tool_skill_and_cleanup_are_registered_and_unsupported_hosts_fail(self):
        calls, hooks, unload = {}, {}, []
        ctx = types.SimpleNamespace(
            _manager=types.SimpleNamespace(_cli_ref=None, has_gateway_message_injector=False),
            register_tool=lambda **kw: calls.update(kw),
            register_hook=lambda name, fn: hooks.update({name: fn}), on_unload=unload.append,
            register_skill=lambda name, path: self.assertTrue(path.is_file()),
            register_system_prompt_section=lambda name, text: self.assertIn("skill_view", text),
        )
        register(ctx)
        self.addCleanup(lambda: [fn() for fn in reversed(unload)])
        self.assertEqual(calls["name"], "pr_monitor")
        self.assertEqual(set(hooks), {"on_session_finalize", "on_session_reset"})
        self.assertNotIn("on_session_end", hooks)  # this fires at the end of every turn
        self.assertIn("conversation identity", calls["handler"]({"action": "start"}))
        modules = {"agent": types.ModuleType("agent"), "gateway": types.ModuleType("gateway"),
            "agent.delegation_context": types.SimpleNamespace(is_delegated_child_context=lambda: False),
            "agent.runtime_cwd": types.SimpleNamespace(resolve_agent_cwd=lambda: ROOT),
            "gateway.session_context": types.SimpleNamespace(get_session_env=lambda _: "")}
        with patch.dict(sys.modules, modules):
            self.assertIn("ACP is not supported", calls["handler"]({"action": "start"}, session_id="a"))
            modules["agent.delegation_context"].is_delegated_child_context = lambda: True
            self.assertIn("delegated child", calls["handler"]({"action": "start"}, session_id="a"))


@unittest.skipIf(os.name == "nt", "fake gh uses a POSIX shebang; Python route contracts still run on Windows")
class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.reports = queue.Queue()
        self.fail = False
        self.profile = contextvars.ContextVar("test_profile", default="wrong-profile")
        self.profile.set("profile-a")
        self.seen_profiles = []
        self.payload("OPEN")
        gh = self.root / "gh"
        gh.write_text("#!" + sys.executable + "\n" +
            "import pathlib, sys\n" +
            "print('local-user' if sys.argv[1:3] == ['api', 'user'] else pathlib.Path('snapshot.json').read_text())\n")
        gh.chmod(0o755)
        env = patch.dict(os.environ, {"PATH": str(self.root) + os.pathsep + os.environ["PATH"]})
        env.start()
        self.addCleanup(env.stop)
        clock = self.root / "clock.mjs"
        clock.write_text("const interval = globalThis.setInterval; globalThis.setInterval = (fn, ms, ...args) => interval(fn, Math.min(ms, 50), ...args);\n")
        node_env = patch.dict(os.environ, {"NODE_OPTIONS": "--import=" + clock.as_uri()})
        node_env.start()
        self.addCleanup(node_env.stop)
        self.bridge = Bridge(str(self.root), self)
        self.addCleanup(self.bridge.close)
        self.profile.set("profile-b")

    def payload(self, state, title="fixture PR"):
        pr = dict(title=title, url="https://github.com/example/repo/pull/1", state=state,
            mergeable="MERGEABLE", headRefOid="head-1", commits={"nodes": []},
            reviewRequests={"nodes": []}, latestReviews={"nodes": []}, reviewThreads={"nodes": []},
            comments={"totalCount": 0, "nodes": []}, labels={"nodes": []})
        (self.root / "snapshot.json").write_text(json.dumps({"data": {"repository": {"pullRequest": pr}}}))

    def deliver(self, report):
        self.seen_profiles.append(self.profile.get())
        self.reports.put(report)
        if self.fail:
            self.fail = False
            raise RuntimeError("temporary delivery failure")

    def test_start_merge_and_terminal_stop_use_bundled_shared_runtime(self):
        result = self.bridge.call({"action": "start", "pr": "example/repo#1"})
        self.assertIn("Started monitoring", result)
        self.assertIn("<!-- pr-monitor:reply -->", result)
        self.assertIn("[PR Monitor]", self.reports.get(timeout=5))
        self.payload("MERGED")
        self.assertIn("MERGED", self.reports.get(timeout=5))
        # Flush queues behind an in-flight delivery acknowledgement, providing a
        # deterministic barrier before inspecting terminal cleanup.
        self.bridge.call({"action": "flush", "pr": "example/repo#1"})
        self.assertIn("No active", self.bridge.call({"action": "status"}))
        self.assertEqual(set(self.seen_profiles), {"profile-a"})

    def test_failed_announcement_retries_and_config_is_session_scoped(self):
        (self.root / ".pr-monitor.json").write_text(json.dumps({"ignoreCommentTag": "[local]"}))
        self.fail = True
        result = self.bridge.call({"action": "start", "pr": "example/repo#1"})
        self.assertIn("[local]", result)
        first = self.reports.get(timeout=5)
        retry = self.reports.get(timeout=5)
        self.assertIn("[PR Monitor]", first)
        self.assertIn("[PR Monitor]", retry)
        self.assertIn("example/repo#1", self.bridge.call({"action": "status"}))

    def test_new_starts_use_updated_cwd_but_other_conversations_stay_isolated(self):
        first = self.bridge.call({"action": "start", "pr": "example/repo#1"})
        self.reports.get(timeout=5)
        second_dir = self.root / "other"
        second_dir.mkdir()
        (second_dir / ".pr-monitor.json").write_text(json.dumps({"ignoreCommentTag": "[other]", "announceOnStart": False}))
        result = self.bridge.call({"action": "start", "pr": "example/repo#2"}, cwd=str(second_dir))
        self.assertIn("[other]", result)
        self.assertIn("<!-- pr-monitor:reply -->", first)
        sibling = Bridge(str(self.root), self)
        try:
            self.assertIn("No active", sibling.call({"action": "status"}))
            sibling.close()
            self.assertIn("example/repo#1", self.bridge.call({"action": "status"}))
        finally:
            sibling.close()

    def test_invalid_action_and_worker_exit_are_reported(self):
        with self.assertRaisesRegex(RuntimeError, "Invalid monitor action"):
            self.bridge.call({"action": "delete"})
        self.bridge.close()
        with self.assertRaisesRegex(RuntimeError, "stopped"):
            self.bridge.call({"action": "status"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
