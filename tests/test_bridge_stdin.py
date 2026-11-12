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
    bridge_path = Path(__file__).resolve().parents[1] / "scripts" / "python" / "bridge.py"
    spec = importlib.util.spec_from_file_location("agentcall_bridge_for_test", bridge_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeClient:
    def __init__(self):
        self.sent = []

    async def send(self, command):
        self.sent.append(command)


async def run_stdin_lines(bridge, lines):
    stdin = io.StringIO("\n".join(json.dumps(line) for line in lines) + "\n")
    old_stdin = sys.stdin
    sys.stdin = stdin
    events = []
    old_emit = bridge.emit
    bridge.emit = events.append
    client = FakeClient()
    done = asyncio.Event()
    try:
        await asyncio.wait_for(
            bridge.read_stdin(
                client,
                done,
                deque(),
                barge_in=None,
                sent_chats=deque(maxlen=5),
                gate_raise_hand=None,
            ),
            timeout=1.0,
        )
        # tts.speak forwards in background tasks; give them one scheduler turn.
        await asyncio.sleep(0.05)
    finally:
        sys.stdin = old_stdin
        bridge.emit = old_emit
    return client.sent, events


def test_bridge_stdin_consumes_multiple_command_and_type_lines():
    bridge = load_bridge()

    sent, events = asyncio.run(
        run_stdin_lines(
            bridge,
            [
                {"type": "tts.speak", "text": "First", "voice": "af_heart", "request_id": "r1"},
                {"command": "tts.speak", "text": "Second", "voice": "bm_lewis", "request_id": "r2"},
                {"type": "meeting.mic", "action": "on", "request_id": "r3"},
                {"type": "meeting.send_chat", "message": "shared in chat", "request_id": "r4"},
                {"command": "raise_hand", "request_id": "r5"},
                {"type": "screenshot.take", "request_id": "r6"},
            ],
        )
    )

    assert {"type": "tts.speak", "text": "First", "voice": "af_heart", "speed": 1.0} in sent
    assert {"type": "tts.speak", "text": "Second", "voice": "bm_lewis", "speed": 1.0} in sent
    assert {"type": "meeting.mic", "action": "on"} in sent
    assert {"type": "meeting.send_chat", "message": "shared in chat"} in sent
    assert {"type": "meeting.raise_hand"} in sent
    assert {"type": "screenshot.take", "request_id": "r6"} in sent

    acked = {(event["command"], event.get("request_id")) for event in events if event["event"] == "command.ack"}
    assert ("tts.speak", "r1") in acked
    assert ("tts.speak", "r2") in acked
    assert ("mic", "r3") in acked
    assert ("send_chat", "r4") in acked
    assert ("raise_hand", "r5") in acked
    assert ("screenshot", "r6") in acked


def test_bridge_stdin_accepts_raw_type_leave():
    bridge = load_bridge()

    sent, events = asyncio.run(
        run_stdin_lines(
            bridge,
            [
                {"type": "meeting.leave", "request_id": "r7"},
            ],
        )
    )

    assert sent == [{"type": "meeting.leave"}]
    assert {"event": "command.ack", "command": "leave", "request_id": "r7"} in events


def test_bridge_stdin_reports_unknown_command_instead_of_silent_drop():
    bridge = load_bridge()

    sent, events = asyncio.run(
        run_stdin_lines(
            bridge,
            [
                {"type": "meeting.not_a_command", "request_id": "bad-1"},
            ],
        )
    )

    assert sent == []
    assert events == [
        {
            "event": "command.error",
            "command": "meeting.not_a_command",
            "message": "unknown bridge stdin command",
            "request_id": "bad-1",
        }
    ]


def test_bridge_stdin_realtime_forwards_only_three_voice_commands():
    """Realtime: inject.natural / voice.context_update / tasks.set go to the backend;
    tts.speak / inject.verbatim / trigger.speak / voice.contribute are refused by the bridge."""
    bridge = load_bridge()

    async def run():
        stdin = io.StringIO("\n".join(json.dumps(l) for l in [
            {"command": "inject.natural", "text": "Done.", "request_id": "req-1"},
            {"command": "voice.context_update", "text": "Launch is on 21 November."},
            {"command": "tasks.set", "tasks": ["Summarise bugs"]},
            {"command": "tts.speak", "text": "Hello"},
            {"command": "inject.verbatim", "text": "Exact"},
            {"command": "trigger.speak", "text": "Ask"},
            {"command": "voice.contribute"},
            {"command": "send_chat", "message": "link"},
        ]) + "\n")
        old_stdin, sys.stdin = sys.stdin, stdin
        events, old_emit = [], bridge.emit
        bridge.emit = events.append
        client, done = FakeClient(), asyncio.Event()
        try:
            await asyncio.wait_for(bridge.read_stdin(client, done, deque(), barge_in=None,
                                                     sent_chats=deque(maxlen=5), gate_raise_hand=None,
                                                     realtime=True), timeout=1.0)
            await asyncio.sleep(0.05)
        finally:
            sys.stdin, bridge.emit = old_stdin, old_emit
        return client.sent, events

    sent, events = asyncio.run(run())
    sent_types = [c.get("type") for c in sent]
    assert sent_types[:3] == ["inject.natural", "voice.context_update", "tasks.set"]
    for refused in ("tts.speak", "inject.verbatim", "trigger.speak", "voice.contribute"):
        assert refused not in sent_types
        assert any(e.get("event") == "command.error" and e.get("command") == refused
                   and "inject.natural" in e.get("message", "") for e in events), refused
    assert any(e.get("event") == "tts.error" and e.get("reason") == "not_in_realtime" for e in events)
    assert "send_chat" in sent_types or any(c.get("type") == "meeting.send_chat" for c in sent)
