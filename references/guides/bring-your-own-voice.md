# Bring Your Own Voice (audio mode)

Use your own TTS provider (ElevenLabs, or any service that returns raw audio) instead of
AgentCall's built-in voices. Your agent generates the audio and sends it into the call with
`audio.inject`; AgentCall plays it in the meeting as the bot's voice.

Full working example (Python + Node.js): [examples/elevenlabs-voice](../../examples/elevenlabs-voice/).

## When to use it

- You want a specific voice (a cloned voice, a brand voice, a provider's premium voices).
- You already pay for a TTS provider and want to use it in meetings.

For most agents the built-in `tts.speak` is simpler: it handles pacing, interruption and the
avatar for you. Bring your own voice when the voice itself matters.

**Supported in audio mode only** (`mode: "audio"`). In webpage modes the bot's voice comes from
the page, and `audio.inject` is not used.

## Protocol

| Command | Fields | Effect |
|---|---|---|
| `audio.inject` | `data` — base64 PCM, **signed 16-bit little-endian, 16 kHz, mono** | Plays the audio in the meeting |
| `audio.clear` | — | Drops audio the meeting has queued (barge-in) |

```json
{"type": "audio.inject", "data": "<base64 PCM s16le 16 kHz mono>"}
{"type": "audio.clear"}
```

Send these on the call WebSocket (`wss://api.agentcall.dev/v1/calls/{call_id}/ws?api_key=...`).
The bridges (`bridge.py`, `bridge-visual.py`) don't accept them on stdin.

## Getting the right format

| Provider | How to get PCM 16 kHz |
|---|---|
| ElevenLabs | `POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm_16000` — exact match |
| Others | Request raw PCM (often called `pcm` / `pcm_s16le`) at 16 kHz; if the provider only offers another rate (e.g. 24 kHz), resample to 16 kHz before sending |

Don't send MP3, WAV headers or other containers — only raw samples.

## Pacing (important)

Send audio at **about real-time speed**: for example 200 ms of audio (6,400 bytes) per
`audio.inject`, never more than ~0.4 s ahead of what has played. A whole reply sent in one burst
can exceed the meeting bot's command rate limit and cut the audio off mid-sentence.

```python
FRAME = 6400          # 200 ms at 16 kHz, 16-bit mono
LEAD = 0.4            # max seconds ahead of real time

start, sent = time.monotonic(), 0.0
for frame in frames(pcm_stream, FRAME):           # split the provider's stream into 200 ms frames
    ahead = sent - (time.monotonic() - start)
    if ahead > LEAD:
        await asyncio.sleep(ahead - LEAD)
    await ws.send(json.dumps({"type": "audio.inject", "data": base64.b64encode(frame).decode()}))
    sent += len(frame) / 32000
```

Stream the provider's response and start sending as soon as the first frame is ready — the
first audio then plays well before the whole reply is generated.

## Barge-in

When someone starts talking over the bot (e.g. a `transcript.partial` with 2+ words while you
are sending audio): stop sending, drop any queued replies, and send `audio.clear`.

## Mixing with `tts.speak`

Both play through the same audio path. Don't send `tts.speak` and `audio.inject` at the same
time — finish (or `audio.clear`) one before starting the other.

## Billing

Your own audio is **not billed as AgentCall TTS** — you pay your provider directly. The meeting
bot and speech-to-text are billed per minute as usual.
