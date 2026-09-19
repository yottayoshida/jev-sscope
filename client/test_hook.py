"""python3 -m unittest client.test_hook  (or: npm test)

What the hook sends, what it redacts, and that it says nothing whatever happens.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hook  # noqa: E402


def batch(n_tools: int, response: str) -> dict:
    return {
        "hook_event_name": "PostToolBatch",
        "session_id": "s1",
        "cwd": "/w",
        "tool_calls": [
            {"tool_name": "Bash", "tool_input": {"command": "ls " + "x" * 1000}, "tool_response": response}
            for _ in range(n_tools)
        ],
    }


class Payload(unittest.TestCase):
    def test_cuts_results_within_the_step_budget(self):
        out = hook.payload_for(batch(1, "r" * 5000))
        self.assertLessEqual(len(out["tool_calls"][0]["tool_response"]), hook.RESULT_MAX + 40)
        out = hook.payload_for(batch(5, "r" * 5000))
        self.assertEqual(len(out["tool_calls"]), 5)
        self.assertLessEqual(len(out["tool_calls"][0]["tool_response"]), hook.RESULT_BUDGET // 5 + 40)

    def test_cuts_every_string_in_the_arguments(self):
        out = hook.payload_for(batch(1, "ok"))
        self.assertEqual(len(out["tool_calls"][0]["tool_input"]["command"]), hook.INPUT_MAX)

    def test_flattens_content_blocks(self):
        data = batch(1, "")
        data["tool_calls"][0]["tool_response"] = [{"type": "text", "text": "line"}, {"type": "image"}]
        self.assertEqual(hook.payload_for(data)["tool_calls"][0]["tool_response"], "line\n[image]")

    def test_prompt_and_compact_are_cut(self):
        out = hook.payload_for({"hook_event_name": "UserPromptSubmit", "session_id": "s", "prompt": "p" * 1000})
        self.assertEqual(len(out["prompt"]), hook.PROMPT_MAX)
        out = hook.payload_for({"hook_event_name": "PostCompact", "session_id": "s", "compact_summary": "c" * 1000})
        self.assertEqual(len(out["compact_summary"]), hook.COMPACT_MAX)

    def test_skips_subagents_and_unknown_events(self):
        data = batch(1, "ok")
        data["agent_id"] = "sub-1"
        self.assertIsNone(hook.payload_for(data))
        self.assertIsNone(hook.payload_for({"hook_event_name": "PreToolUse", "session_id": "s"}))

    def test_session_end_is_forwarded(self):
        out = hook.payload_for({"hook_event_name": "SessionEnd", "session_id": "s"})
        self.assertEqual(out["event"], "SessionEnd")

    def test_stamps_the_time_it_was_sent(self):
        before = int(time.time() * 1000)
        out = hook.payload_for({"hook_event_name": "Stop", "session_id": "s"})
        self.assertGreaterEqual(out["sent_at"], before)


class Redaction(unittest.TestCase):
    # Built at run time so that nothing shaped like a real credential sits in the file.
    def test_known_shapes_are_replaced(self):
        samples = [
            "sk-" + "a" * 40,
            "ghp_" + "b" * 36,
            "github_pat_" + "c" * 30,
            "AKIA" + "D" * 16,
            "eyJ" + "e" * 20 + "." + "f" * 20 + "." + "g" * 20,
            "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
            "Authorization: Bearer " + "h" * 30,
        ]
        for sample in samples:
            self.assertNotIn(sample, hook.redact(f"before {sample} after"), sample[:12])
            self.assertIn("[redacted]", hook.redact(sample))

    def test_redacts_before_cutting_so_a_long_key_does_not_survive_the_cut(self):
        # A key body longer than the cut: cutting first would remove the END line the
        # pattern needs and let the head of the key through.
        body = "k" * (hook.INPUT_MAX * 3)
        key = f"-----BEGIN RSA PRIVATE KEY-----\n{body}\n-----END RSA PRIVATE KEY-----"
        data = batch(1, "ok")
        data["tool_calls"][0]["tool_input"] = {"file_path": "id_rsa", "content": key}
        sent = hook.payload_for(data)["tool_calls"][0]["tool_input"]["content"]
        self.assertNotIn("kkkkkkkk", sent)
        self.assertIn("[redacted]", sent)
        # The same key in a result, which is cut head-and-tail.
        data["tool_calls"][0]["tool_response"] = key
        self.assertNotIn("kkkkkkkk", hook.payload_for(data)["tool_calls"][0]["tool_response"])
        # A BEGIN with no END in sight (the END was never in the text) is still hidden.
        self.assertNotIn("kkkkkkkk", hook.redact(f"-----BEGIN RSA PRIVATE KEY-----\n{body}"))

    def test_ordinary_text_is_left_alone(self):
        text = "zig build test 2>&1 | tail -5\nAll 42 tests passed. Bearer of bad news: none."
        self.assertEqual(hook.redact(text), text)


class Configuration(unittest.TestCase):
    def test_worker_url_override_is_limited_to_local_and_test_addresses(self):
        cfg = {"WORKER_URL": "http://a", "INGEST_TOKEN": "t"}
        self.assertEqual(hook.worker_url(cfg), "http://a")
        for allowed in ("http://localhost:8787", "http://127.0.0.1:9", "http://192.0.2.1:9"):
            with unittest.mock.patch.dict("os.environ", {"JEV_SSCOPE_WORKER_URL": allowed}):
                self.assertEqual(hook.worker_url(cfg), allowed)
        # Anything a URL parser would send elsewhere is refused, however it starts.
        for refused in (
            "https://evil.example",
            "http://localhost@evil.example/x",
            "http://localhost.evil.example/x",
            "http://127.0.0.1.evil.example/x",
            "http://192.0.2.evil.example/x",
            "http://192.0.2.1:9@evil.example/",
            "ftp://localhost/",
        ):
            with unittest.mock.patch.dict("os.environ", {"JEV_SSCOPE_WORKER_URL": refused}):
                self.assertEqual(hook.worker_url(cfg), "http://a", refused)

    def test_tls_strictness_is_relaxed_only_when_asked(self):
        import ssl

        self.assertIsNone(hook.tls_context("http://localhost:8787"))
        with unittest.mock.patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop("JEV_SSCOPE_RELAX_TLS", None)
            strict = hook.tls_context("https://example.invalid")
            self.assertTrue(strict.verify_flags & ssl.VERIFY_X509_STRICT)
        with unittest.mock.patch.dict("os.environ", {"JEV_SSCOPE_RELAX_TLS": "1"}):
            relaxed = hook.tls_context("https://example.invalid")
            self.assertFalse(relaxed.verify_flags & ssl.VERIFY_X509_STRICT)
            self.assertEqual(relaxed.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(relaxed.check_hostname)


class Silence(unittest.TestCase):
    def run_main(self, stdin_text: str) -> tuple[int, str, str, float]:
        out, err = io.StringIO(), io.StringIO()
        started = time.monotonic()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            sys.stdin = io.StringIO(stdin_text)
            try:
                code = hook.main()
            finally:
                sys.stdin = sys.__stdin__
        return code, out.getvalue(), err.getvalue(), time.monotonic() - started

    def test_says_nothing_when_the_worker_is_down(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "client.env"
            cfg.write_text("WORKER_URL=http://127.0.0.1:9\nINGEST_TOKEN=t\n")  # port 9: nothing listens
            original = hook.CONFIG
            hook.CONFIG = cfg
            try:
                code, out, err, took = self.run_main(json.dumps(batch(1, "ok")))
            finally:
                hook.CONFIG = original
        self.assertEqual((code, out, err), (0, "", ""))
        self.assertLess(took, 3)

    def test_says_nothing_on_garbage(self):
        code, out, err, _ = self.run_main("not json at all")
        self.assertEqual((code, out, err), (0, "", ""))


if __name__ == "__main__":
    unittest.main()
