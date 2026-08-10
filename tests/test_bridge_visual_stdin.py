"""Stdin observability tests for bridge-visual.py.

Mirrors tests/test_bridge_stdin.py (the audio bridge) for the visual bridge:
loads the module, mocks emit + the API client, feeds stdin lines through
read_stdin, and asserts command.ack / command.error behavior and raw `type`
acceptance — without spawning a real meeting.

Run: python3 -m pytest -q tests/test_bridge_visual_stdin.py
"""

import asyncio
import importlib.util
import io
import json
import os
import sys
from collections import deque
from pathlib import Path


def load_bridge():
    os.environ.setdefault("AGENTCALL_API_KEY", "test-key")
    bridge_path = Path(__file__).resolve().parents[1] / "scripts" / "python" / "bridge-visual.py"
    spec = importlib.util.spec_from_file_location("agentcall_bridge_visual_for_test", bridge_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeClient:
    def __init__(self):
        self.sent = []

    async def send(self, command):
        self.sent.append(command)
        return True


async def run_stdin_lines(bridge, lines):
    """Feed lines (dicts -> JSON, or raw strings) through read_stdin.

    Returns (client.sent, emitted_events, done_event). Monkeypatches the
    module-level `emit` to capture events and uses a FakeClient to capture
    backend forwards. Terminates on stdin EOF (or a `leave` command).
    """
    payload = "\n".join(l if isinstance(l, str) else json.dumps(l) for l in lines) + "\n"
    stdin = io.StringIO(payload)
    old_stdin, old_emit = sys.stdin, bridge.emit
    sys.stdin = stdin
    events = []
    bridge.emit = events.append
    client = FakeClient()
    done = asyncio.Event()
    pending_tts = set()
    batch_queue = deque()
    try:
        await asyncio.wait_for(
            bridge.read_stdin(client, done, pending_tts, batch_queue,
                              sent_chats=deque(maxlen=5)),
            timeout=2.0,
        )
        # tts.speak forwards run in background tasks; give them a scheduler turn.
        await asyncio.sleep(0.05)
    finally:
        for t in list(pending_tts):
            t.cancel()
        sys.stdin, bridge.emit = old_stdin, old_emit
    return client.sent, events, done


def acks(events):
    return [e for e in events if e.get("event") == "command.ack"]


def errs(events):
    return [e for e in events if e.get("event") == "command.error"]


def test_recognized_commands_ack_with_resolved_names():
    bridge = load_bridge()
    sent, events, _ = asyncio.run(run_stdin_lines(bridge, [
        {"command": "tts.speak", "text": "Hello there."},
        {"type": "meeting.mic", "action": "on"},   # raw type -> mic
        {"command": "send_chat", "message": "hi"},
        {"type": "screenshot.take"},               # raw type -> screenshot
        {"command": "set_state", "state": "thinking"},
        {"command": "tasks.set", "tasks": ["a", "b"]},
    ]))
    assert [a["command"] for a in acks(events)] == [
        "tts.speak", "mic", "send_chat", "screenshot", "set_state", "tasks.set",
    ]
    sent_types = [s.get("type") for s in sent]
    for t in ("meeting.mic", "meeting.send_chat", "screenshot.take",
              "voice.state_update", "tts.speak"):
        assert t in sent_types, (t, sent_types)


def test_visual_only_commands_ack():
    bridge = load_bridge()
    sent, events, _ = asyncio.run(run_stdin_lines(bridge, [
        {"command": "screenshare.start", "url": "https://example.com/slides"},
        {"command": "screenshare.stop"},
        {"command": "screenshare.swap", "url": "https://example.com/next"},
    ]))
    assert [a["command"] for a in acks(events)] == [
        "screenshare.start", "screenshare.stop", "screenshare.swap",
    ]
    sent_types = [s.get("type") for s in sent]
    assert sent_types.count("screenshare.start") == 2  # start + swap's restart
    assert "screenshare.stop" in sent_types


def test_raw_type_aliases_resolve():
    bridge = load_bridge()
    _, events, _ = asyncio.run(run_stdin_lines(bridge, [
        {"type": "meeting.send_chat", "message": "x"},
        {"type": "meeting.raise_hand"},
        {"type": "meeting.mic"},
        {"type": "meeting.leave"},   # keep last: sets done
    ]))
    assert [a["command"] for a in acks(events)] == [
        "send_chat", "raise_hand", "mic", "leave",
    ]


def test_unknown_and_missing_command_error():
    bridge = load_bridge()
    _, events, _ = asyncio.run(run_stdin_lines(bridge, [
        {"command": "bogus.command"},
        {"type": "meeting.unknown"},
        {"text": "no command or type"},
    ]))
    e = errs(events)
    assert [x["command"] for x in e] == ["bogus.command", "meeting.unknown", "<missing>"]
    assert all(x["message"] == "unknown bridge stdin command" for x in e)
    assert acks(events) == []


def test_malformed_json_is_silently_skipped():
    bridge = load_bridge()
    _, events, _ = asyncio.run(run_stdin_lines(bridge, [
        "{not valid json",
        {"command": "raise_hand"},
    ]))
    assert [x.get("event") for x in events] == ["command.ack"]
    assert acks(events)[0]["command"] == "raise_hand"


def test_request_id_echoed_when_present():
    bridge = load_bridge()
    _, events, _ = asyncio.run(run_stdin_lines(bridge, [
        {"command": "screenshot", "request_id": "req-42"},
    ]))
    a = acks(events)[0]
    assert a["command"] == "screenshot" and a.get("request_id") == "req-42"


def test_ack_precedes_domain_error_for_local_command():
    # webpage.open with no tunnel still acks (received), then emits webpage.error.
    bridge = load_bridge()
    _, events, _ = asyncio.run(run_stdin_lines(bridge, [
        {"command": "webpage.open", "port": 3001},
    ]))
    assert [x.get("event") for x in events] == ["command.ack", "webpage.error"]
    assert acks(events)[0]["command"] == "webpage.open"


def test_leave_sets_done():
    bridge = load_bridge()
    sent, events, done = asyncio.run(run_stdin_lines(bridge, [{"command": "leave"}]))
    assert done.is_set()
    assert acks(events)[0]["command"] == "leave"
    assert any(s.get("type") == "meeting.leave" for s in sent)
