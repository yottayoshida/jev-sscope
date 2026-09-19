#!/usr/bin/env python3
"""Claude Code hook: send one step of a watched session to the jev-sscope Worker.

Registered as an async command hook for UserPromptSubmit, PostToolBatch,
PostCompact, Stop and SessionEnd (see settings.example.json). Reads the hook
JSON on stdin, redacts and trims it, posts it, and says nothing: whatever an
async hook prints reaches Claude on the next turn, and this is an instrument,
not a voice.

Every failure is swallowed. A watched session must never wait for, or break
because of, the thing watching it.

    python3 hook.py --write-settings   # writes settings.json next to this file

Configuration lives outside the repository in ~/.config/jev-sscope/client.env:
    WORKER_URL=http://localhost:8787
    INGEST_TOKEN=<the same value as INGEST_TOKEN in the Worker's .dev.vars>

Environment variables, all optional:
    JEV_SSCOPE_LOG=<file>         one line per event appended there (timing)
    JEV_SSCOPE_WORKER_URL=<url>   override WORKER_URL for one session; only
                                  localhost, 127.0.0.1 and 192.0.2.x (TEST-NET,
                                  unroutable) are accepted, for measurements
    JEV_SSCOPE_RELAX_TLS=1        drop only the strict-RFC-5280 flag when
                                  verifying HTTPS, for hosts behind a TLS-
                                  intercepting proxy. Chain and host name are
                                  still verified. Off by default.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG = Path.home() / ".config/jev-sscope/client.env"
EVENTS = ("UserPromptSubmit", "PostToolBatch", "PostCompact", "Stop", "SessionEnd")
INPUT_MAX = 300
RESULT_MAX = 600
RESULT_BUDGET = 2400
PROMPT_MAX = 400
COMPACT_MAX = 500
TIMEOUT_S = 3
# Hosts an override may point at: this machine, or TEST-NET-1 (never routed).
OVERRIDE_HOSTS = re.compile(r"^(localhost|127\.0\.0\.1|192\.0\.2\.\d{1,3})$")

# Shapes of secrets. Detection is a second line; the first is that only sessions
# started with this hook's settings file are watched at all.
SECRET = re.compile(
    r"sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{16,}"
    r"|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}"
    r"|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)"
    r"|Bearer [A-Za-z0-9_.~+/=-]{16,}"
)


def redact(text: str) -> str:
    return SECRET.sub("[redacted]", text)


def shorten(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    tail = limit - head
    return f"{text[:head]}\n...[{len(text) - limit} chars cut]...\n{text[-tail:]}"


def flatten(response) -> str:
    """The text the model saw: a string, or content blocks."""
    if isinstance(response, str):
        return response
    if isinstance(response, list):
        parts = []
        for block in response:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
            elif isinstance(block, dict) and block.get("type") == "image":
                parts.append("[image]")
        return "\n".join(parts)
    if isinstance(response, dict):
        return json.dumps(response, ensure_ascii=False)
    return ""


def cut(text: str, limit: int) -> str:
    """Redact, then cut. The other order leaves the head of a long secret in place
    once the tail that completes the pattern has been cut away."""
    return redact(text)[:limit]


def trim(value, limit: int):
    """Cut every string inside the arguments; leave the shape alone."""
    if isinstance(value, str):
        return cut(value, limit)
    if isinstance(value, dict):
        return {k: trim(v, limit) for k, v in list(value.items())[:40]}
    if isinstance(value, list):
        return [trim(v, limit) for v in value[:40]]
    return value


def payload_for(data: dict) -> dict | None:
    event = data.get("hook_event_name")
    if event not in EVENTS or data.get("agent_id"):
        return None
    out = {
        "event": event,
        "session_id": str(data.get("session_id", "")),
        "cwd": str(data.get("cwd", "")),
        "sent_at": int(time.time() * 1000),
    }
    if event == "UserPromptSubmit":
        out["prompt"] = cut(str(data.get("prompt", "")), PROMPT_MAX)
    elif event == "PostCompact":
        out["compact_summary"] = cut(str(data.get("compact_summary", "")), COMPACT_MAX)
    elif event == "PostToolBatch":
        calls = data.get("tool_calls") or []
        per_tool = max(200, min(RESULT_MAX, RESULT_BUDGET // max(1, len(calls))))
        out["tool_calls"] = [
            {
                "tool_name": str(call.get("tool_name", "")),
                "tool_input": trim(call.get("tool_input"), INPUT_MAX),
                "tool_response": shorten(redact(flatten(call.get("tool_response"))), per_tool),
            }
            for call in calls
            if isinstance(call, dict)
        ]
    return out


def config() -> dict[str, str]:
    values = {}
    for line in CONFIG.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip("\"'")
    return values


def worker_url(cfg: dict[str, str]) -> str:
    """The override is honoured only for a plain http URL whose host, as a URL
    parser reads it, is this machine or TEST-NET. A prefix match would let
    `http://localhost@evil.example/` or `http://localhost.evil.example/` through
    with the ingest token attached."""
    override = os.environ.get("JEV_SSCOPE_WORKER_URL")
    if override:
        parts = urllib.parse.urlsplit(override)
        if parts.scheme == "http" and not parts.username and OVERRIDE_HOSTS.match(parts.hostname or ""):
            return override
    return cfg["WORKER_URL"]


def tls_context(url: str):
    if not url.startswith("https://"):
        return None
    context = ssl.create_default_context(cafile=os.environ.get("REQUESTS_CA_BUNDLE") or None)
    if os.environ.get("JEV_SSCOPE_RELAX_TLS") == "1":
        # A TLS-intercepting proxy's CA can fail Python 3.13+'s strict RFC 5280
        # check. Only that flag goes; the chain and the host name are still verified.
        context.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return context


def post(url: str, token: str, payload: dict) -> int:
    body = json.dumps(payload, ensure_ascii=False).encode()
    request = urllib.request.Request(
        url.rstrip("/") + "/ingest",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_S, context=tls_context(url)) as response:
        return response.status


def write_settings() -> None:
    """settings.json with this file's absolute path and this interpreter, so that a
    session started in another repository still finds both."""
    here = Path(__file__).resolve()
    command = f'"{sys.executable}" "{here}"'
    hooks = {
        event: [{"hooks": [{"type": "command", "command": command, "async": True, "timeout": 10}]}]
        for event in EVENTS
    }
    target = here.with_name("settings.json")
    target.write_text(json.dumps({"hooks": hooks}, indent=2) + "\n")
    print(f"wrote {target}\nstart a watched session with:\n  claude --settings {target}")


def main() -> int:
    if "--write-settings" in sys.argv[1:]:
        write_settings()
        return 0
    started = time.monotonic()
    event = status = "?"
    try:
        data = json.load(sys.stdin)
        event = str(data.get("hook_event_name"))
        payload = payload_for(data)
        if payload is None:
            status = "skipped"
        else:
            cfg = config()
            status = str(post(worker_url(cfg), cfg["INGEST_TOKEN"], payload))
    except Exception as error:  # noqa: BLE001 - the session must never see this
        status = f"error {type(error).__name__}"
    log = os.environ.get("JEV_SSCOPE_LOG")
    if log:
        try:
            with open(log, "a") as f:
                f.write(f"{int(time.time() * 1000)} {event} {status} {time.monotonic() - started:.3f}s\n")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
