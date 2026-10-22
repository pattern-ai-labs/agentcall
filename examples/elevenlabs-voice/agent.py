#!/usr/bin/env python3
"""
AgentCall — Bring Your Own Voice (ElevenLabs)

Joins a meeting in audio mode and speaks with an ElevenLabs voice instead of
AgentCall's built-in TTS. Your agent generates the audio with your own
ElevenLabs API key and sends it into the call with `audio.inject`.

    transcript.final → your reply → ElevenLabs (PCM 16 kHz) → paced audio.inject → meeting

Barge-in: when someone starts talking while the bot speaks, playback stops
and `audio.clear` flushes what the meeting still has queued.

Usage:
    export AGENTCALL_API_KEY="ak_ac_your_key"
    export ELEVENLABS_API_KEY="your_elevenlabs_key"
    python agent.py "https://meet.google.com/abc-def-ghi"

    # Custom bot name and ElevenLabs voice
    python agent.py "https://meet.google.com/abc" --name "Ava" --voice-id 21m00Tcm4TlvDq8ikWAM

Dependencies:
    pip install aiohttp

Notes:
  - `audio.inject` works in audio mode only (mode: "audio").
  - Audio format: raw PCM, signed 16-bit little-endian, 16 kHz, mono, base64.
    ElevenLabs returns exactly this with output_format=pcm_16000.
  - Pace the audio (about real time). Sending a whole reply in one burst can
    exceed the meeting bot's command rate limit and cut the audio off.
  - Your own audio is not billed as AgentCall TTS.

NOTE: decide_reply() is a placeholder — plug in your LLM there.
"""

import argparse
import asyncio
import base64
import json
import os
import sys
import time

import aiohttp

# ── Configuration ────────────────────────────────────────────────────────────

_cfg = {}
_cfg_path = os.path.join(os.path.expanduser("~"), ".agentcall", "config.json")
if os.path.exists(_cfg_path):
    try:
        _cfg = json.loads(open(_cfg_path).read())
    except (json.JSONDecodeError, OSError):
        pass

API_BASE = os.environ.get("AGENTCALL_API_URL", "") or _cfg.get("api_url", "") or "https://api.agentcall.dev"
API_KEY = os.environ.get("AGENTCALL_API_KEY", "") or _cfg.get("api_key", "")
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")

if not API_KEY:
    sys.exit("Error: set AGENTCALL_API_KEY or save it to ~/.agentcall/config.json")
if not ELEVENLABS_API_KEY:
    sys.exit("Error: set ELEVENLABS_API_KEY")

SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2          # 16-bit mono
FRAME_BYTES = BYTES_PER_SECOND // 5          # 200 ms per audio.inject message
FRAME_SECONDS = 0.2
LEAD_SECONDS = 0.4                           # stay at most this far ahead of real time


# ── Your agent logic ─────────────────────────────────────────────────────────

def decide_reply(speaker: str, text: str) -> str:
    """Placeholder: replace with your LLM call. Return "" to stay silent."""
    return f"{speaker}, you said: {text}"


# ── ElevenLabs → audio.inject ────────────────────────────────────────────────

class Voice:
    """Speaks queued replies through ElevenLabs, paced, with barge-in."""

    def __init__(self, http: aiohttp.ClientSession, ws, voice_id: str, model_id: str):
        self.http = http
        self.ws = ws
        self.voice_id = voice_id
        self.model_id = model_id
        self.queue: asyncio.Queue = asyncio.Queue()
        self.current = None                     # task speaking right now
        self.worker = asyncio.create_task(self._work())

    @property
    def speaking(self) -> bool:
        return self.current is not None and not self.current.done()

    def say(self, text: str):
        """Queue text; replies play one after another."""
        self.queue.put_nowait(text)

    async def interrupt(self):
        """Barge-in: drop queued replies, stop sending, flush the meeting's buffer."""
        while not self.queue.empty():
            self.queue.get_nowait()
        if self.speaking:
            self.current.cancel()
            await self.ws.send_str(json.dumps({"type": "audio.clear"}))
            print("  (interrupted)")

    async def close(self):
        self.worker.cancel()
        if self.speaking:
            self.current.cancel()

    async def _work(self):
        while True:
            text = await self.queue.get()
            self.current = asyncio.create_task(self._speak(text))
            try:
                await self.current
            except asyncio.CancelledError:
                if not self.current.cancelled():   # the worker itself was cancelled
                    raise
            except Exception as e:
                print(f"  speak failed: {e}")
            finally:
                self.current = None

    async def _speak(self, text: str):
        url = (f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream"
               f"?output_format=pcm_{SAMPLE_RATE}")
        body = {"text": text, "model_id": self.model_id}
        headers = {"xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json"}

        print(f"  [bot] {text}")
        async with self.http.post(url, json=body, headers=headers) as resp:
            if resp.status != 200:
                print(f"  ElevenLabs error {resp.status}: {(await resp.text())[:200]}")
                return

            buf = b""
            sent_seconds = 0.0
            start = time.monotonic()
            async for chunk in resp.content.iter_any():   # first audio starts before the reply is fully generated
                buf += chunk
                while len(buf) >= FRAME_BYTES:
                    frame, buf = buf[:FRAME_BYTES], buf[FRAME_BYTES:]
                    sent_seconds = await self._send_paced(frame, sent_seconds, start)
            if buf:
                if len(buf) % 2:                          # keep whole 16-bit samples
                    buf = buf[:-1]
                await self._send_paced(buf, sent_seconds, start)

    async def _send_paced(self, frame: bytes, sent_seconds: float, start: float) -> float:
        """Send one frame, never getting more than LEAD_SECONDS ahead of real time."""
        ahead = sent_seconds - (time.monotonic() - start)
        if ahead > LEAD_SECONDS:
            await asyncio.sleep(ahead - LEAD_SECONDS)
        await self.ws.send_str(json.dumps({
            "type": "audio.inject",
            "data": base64.b64encode(frame).decode(),
        }))
        return sent_seconds + len(frame) / BYTES_PER_SECOND


# ── Call lifecycle ───────────────────────────────────────────────────────────

async def run(meet_url: str, bot_name: str, voice_id: str, model_id: str):
    auth = {"Authorization": f"Bearer {API_KEY}"}
    async with aiohttp.ClientSession() as http:
        async with http.post(f"{API_BASE}/v1/calls", headers=auth, json={
            "meet_url": meet_url,
            "bot_name": bot_name,
            "mode": "audio",              # audio.inject works in audio mode only
            "voice_strategy": "direct",
            "transcription": True,
        }) as resp:
            if resp.status >= 300:
                sys.exit(f"Create call failed ({resp.status}): {await resp.text()}")
            call = await resp.json()
        call_id = call["call_id"]
        print(f"Call created: {call_id} — admit '{bot_name}' if the meeting has a waiting room.")

        try:
            async with http.ws_connect(f"{call['ws_url']}?api_key={API_KEY}", heartbeat=30) as ws:
                voice = Voice(http, ws, voice_id, model_id)
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        break
                    event = json.loads(msg.data)
                    kind = event.get("event") or event.get("type")

                    if kind == "call.bot_ready":
                        print("Bot is in the meeting.")
                        voice.say(f"Hi, I'm {bot_name}. I'm speaking with an ElevenLabs voice.")

                    elif kind == "transcript.partial":
                        # Barge-in on real speech, not a one-word "mm-hm".
                        if voice.speaking and len(event.get("text", "").split()) >= 2:
                            await voice.interrupt()

                    elif kind == "transcript.final":
                        speaker = (event.get("speaker") or {}).get("name", "Someone")
                        text = event.get("text", "").strip()
                        if not text:
                            continue
                        print(f"  [{speaker}] {text}")
                        reply = decide_reply(speaker, text)
                        if reply:
                            voice.say(reply)

                    elif kind == "command.error":
                        print(f"  command.error: {event.get('command')} — {event.get('message')}")

                    elif kind == "call.ended":
                        print(f"Call ended: {event.get('reason', 'unknown')}")
                        break
                await voice.close()
        finally:
            await http.delete(f"{API_BASE}/v1/calls/{call_id}", headers=auth)


def main():
    p = argparse.ArgumentParser(description="AgentCall bot that speaks with an ElevenLabs voice")
    p.add_argument("meet_url", help="Google Meet, Zoom or Teams URL")
    p.add_argument("--name", default="Ava", help="Bot name in the meeting (default: Ava)")
    p.add_argument("--voice-id", default="21m00Tcm4TlvDq8ikWAM", help="ElevenLabs voice ID")
    p.add_argument("--model", default="eleven_flash_v2_5", help="ElevenLabs model (flash = lowest latency)")
    a = p.parse_args()
    try:
        asyncio.run(run(a.meet_url, a.name, a.voice_id, a.model))
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
