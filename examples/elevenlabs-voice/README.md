# Bring Your Own Voice — ElevenLabs

A meeting bot that speaks with an **ElevenLabs** voice instead of AgentCall's built-in TTS.
Your agent generates the audio with your own ElevenLabs API key and sends it into the call
with `audio.inject`. The same pattern works for any voice provider that can return raw PCM.

## What It Does

1. Creates a call in **audio mode** (`audio.inject` works in audio mode only)
2. Greets the meeting when the bot joins
3. On each `transcript.final`, asks `decide_reply()` / `decideReply()` what to say
   (a placeholder that echoes — plug in your LLM there)
4. Streams the reply from ElevenLabs as **PCM 16 kHz** (`output_format=pcm_16000`) — no conversion needed
5. Sends the audio in **200 ms chunks at about real-time pace** as `audio.inject`
6. **Barge-in:** when someone speaks over the bot (2+ words in a `transcript.partial`), it stops
   sending and sends `audio.clear` to flush audio the meeting still has queued

```
transcript.final → your reply → ElevenLabs (PCM 16 kHz) → paced audio.inject → meeting
```

## Setup

You need an AgentCall API key and an [ElevenLabs](https://elevenlabs.io) API key.

### Python

```bash
pip install aiohttp
export AGENTCALL_API_KEY="ak_ac_your_key"
export ELEVENLABS_API_KEY="your_elevenlabs_key"
python agent.py "https://meet.google.com/abc-def-ghi"
```

### Node.js (18+)

```bash
npm install ws
export AGENTCALL_API_KEY="ak_ac_your_key"
export ELEVENLABS_API_KEY="your_elevenlabs_key"
node agent.js "https://meet.google.com/abc-def-ghi"
```

### Options

```bash
--name "Ava"                        # bot name in the meeting (default: Ava)
--voice-id 21m00Tcm4TlvDq8ikWAM     # any ElevenLabs voice ID from your voice library
--model eleven_flash_v2_5           # flash = lowest latency; any ElevenLabs TTS model works
```

## The Two Rules

**1. Format.** `audio.inject` takes raw PCM: signed 16-bit little-endian, **16 kHz, mono**, base64:

```json
{"type": "audio.inject", "data": "<base64 PCM s16le 16 kHz mono>"}
```

**2. Pacing.** Send audio at about real-time speed — e.g. 200 ms of audio (6,400 bytes) per
message, staying no more than ~0.4 s ahead. Sending a whole reply in one burst can exceed the
meeting bot's command rate limit and cut the audio off mid-sentence.

To stop the bot mid-sentence, stop sending and send:

```json
{"type": "audio.clear"}
```

## Billing

- **Meeting bot** and **speech-to-text** — per minute of call, as usual
- **Your own audio is not billed as AgentCall TTS** — you pay ElevenLabs directly

## Limitations

- **Audio mode only** for now. In webpage modes (`webpage-audio`, `webpage-av`,
  `webpage-av-screenshare`) the bot's voice comes from the page, and `audio.inject` is not used.
- The built-in bridges (`bridge.py`, `bridge-visual.py`) don't accept `audio.inject` on stdin —
  use the call WebSocket directly, as this example does.

See also: [Bring Your Own Voice guide](../../references/guides/bring-your-own-voice.md).
