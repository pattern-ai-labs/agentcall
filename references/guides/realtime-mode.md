# Realtime Mode Guide

With `voice_strategy: "realtime"` the bot has its own voice that **listens to the meeting and
answers by itself**: it replies to greetings, simple questions and anything it already knows
within about a second, stays quiet when people talk to each other, and stops at once when
someone talks over it. **You (the agent) stay the brain**: whenever the bot needs facts, tools or
a decision, it asks you with an `agent.request`, keeps the meeting informed ("let me check"), and
says your answer in its own words when you reply.

Use it when you want natural, fast conversation without answering every line yourself. Use
`direct` when you want to write every word the bot says, and `collaborative` when you want to
drive the voice entirely through context and triggers.

> **In realtime, use only these commands:** `inject.natural` (with the `request_id` to answer an `agent.request`, without it to say something now), `voice.context_update` and `tasks.set` — plus chat, leave, mic, screenshot, screenshare and webpage commands. The bridge refuses `tts.speak`, `inject.verbatim`, `trigger.speak` and `voice.contribute` in realtime with `command.error` (and `tts.error` for `tts.speak`).

## Quick start (bridge)

```bash
python scripts/python/bridge.py "https://meet.google.com/abc-def-ghi" --name "Juno" \
  --voice-strategy realtime --trigger-words "juno,zuno" --languages "English,Hindi" \
  --context "You are Juno, the assistant of the Atlas team. The launch is on 14 November."
```

The same flags work in `bridge-visual.py`, `bridge.js` and `bridge-visual.js` (with the avatar in
webpage modes).

| Flag | Default | Meaning |
|------|---------|---------|
| `--voice-strategy realtime` | | The realtime voice speaks for the bot |
| `--trigger-words` | | Other spellings of the bot's name it should answer to (e.g. `juno,zuno`) |
| `--context` | | What the bot should know from the start (max 10,000 characters) |
| `--audience` | `auto` | `one-on-one`: answer everything said. `team`: answer only when addressed by name. `auto`: picks by the number of people in the call and switches as people join or leave |
| `--voice` | `female.breezy` | `female.breezy`, `female.firm`, `female.bright`, `male.upbeat`, `male.firm`, `male.calm`. Keep the default `female.breezy` for the best performance |
| `--search` | `on` | Let the bot look up current facts on the web itself (weather, news, prices) |
| `--languages` | any | The only languages the bot may speak, comma-separated, the first is its default (e.g. `"Malayalam,English"`, at most 5). Recommended whenever you know the meeting's languages — see Languages below |
| `--interruption-loudness` | `55` | How much (0–100 %) of the first half-second of a sound must be loud before it counts as speech and stops the bot. Lower = stops on shorter sounds; higher = ignores more noise (coughs, clicks, "mm"), but short words can be missed. Recommended 30–60 |
| `--transcript-events` | off | Also print every transcript line to stdout as it happens (see below) |
| `--voice-events` | off | Also print `voice.state` on every change |

## What you receive

```json
{"event": "agent.request", "request_id": "req-1", "question": "How many open bugs are in the tracker?",
 "transcript": [{"speaker": "Dana", "text": "Juno, how many open bugs do we have?", "ts": "..."}]}
{"event": "agent.leave_request", "request_id": "leave-2", "reason": "Dana said we are done",
 "hint": "The bot said goodbye. Send {\"command\": \"leave\"} if the meeting is done for you."}
{"event": "voice.text", "text": "Let me check the tracker."}
```

- **`agent.request`** — the bot needs you. `question` is what it wants to know or what it was
  asked to do; `transcript` holds every line since the previous request, so you always have the
  conversation without reading every line live. The bot has already told the meeting it is on it.
  The bot knows it cannot type, post in the chat, send messages or emails, open files or links,
  or do longer work itself, so it hands you all of that: chat posts, messages, checks in your own
  systems (tickets, files, code), research that needs more than a quick web lookup, writing,
  planning and any other task. Simple questions it answers itself.
  A request can also be a task, e.g. `"Post the agenda link in the chat."` — do it (`send_chat`
  posts in the meeting chat), then answer the request with the result ("Posted the link in the
  chat.") so the bot can tell the meeting. The bot never says it posted something before you answer.
- **`agent.leave_request`** — the bot said goodbye because someone asked it to leave. Send
  `leave` if you agree; otherwise ignore it and the bot stays.
- **`voice.text`** — what the bot said (its own line of the transcript).
- Transcript lines (`user.message` for people, `voice.text` for the bot) are written to the
  `--output` file as they happen. They go to stdout only with `--transcript-events`, because every
  event costs you tokens and `agent.request` already carries them.
- `call.degraded` / `call.recovered` — the bot's voice went down / came back (see below).

There is no `greeting.prompt`: the bot talks to people itself.

## Answering a request

Reply with `inject.natural` (the bot says it in its own words) and the `request_id`:

```json
{"command": "inject.natural", "request_id": "req-1", "text": "Checking the tracker now.", "final": false}
{"command": "inject.natural", "request_id": "req-1", "text": "There are 14 open bugs, 3 of them critical."}
```

- Several replies per request are fine. `"final": false` marks a **status update** (the bot
  passes it on and keeps waiting); the reply without it (or with `"final": true`) is the answer.
- `"silent": true` gives the bot a fact **to keep until someone asks** instead of saying it now.
- Answer within about 90 seconds. For long work, send a status update first, then the answer
  when it is ready — the bot announces it at the next natural pause.
- **Show the work:** add the task to `tasks.set` while you work on it (the bot can tell people
  what you're working on; in webpage modes the avatar shows the list) and remove it when done.
- **Stay on the meeting:** if your framework has subagents, hand the task to one with everything
  it needs — the question, who asked, the request's `transcript` lines, the meeting context, what to
  return (a short spoken answer, plus anything for the chat) — and keep watching events yourself.
  Without subagents, do it yourself one step at a time and keep checking for new events between
  steps (another `agent.request`, `agent.leave_request`, `call.ended`).
- Each command gets a `command.ack`, or a `command.error` with a `reason`.

## Other commands

| Command | Effect |
|---------|--------|
| `inject.natural` without `request_id` | Tell the meeting something now (e.g. a result of background work); with `"silent": true`, a fact the bot keeps until asked |
| `voice.context_update` | Replace the bot's background knowledge (max 10,000 characters; longer → `command.error` reason `context_too_long`, nothing changed); not spoken |
| `tasks.set` | Your work-in-progress list; the bot can tell people what you are working on (and the avatar shows it in webpage modes) |

Chat, mic, screenshot, screenshare, webpage and leave commands work as in direct mode.

## When the voice is unavailable

If the bot's voice cannot be reached, you get `call.degraded` with `reason: "voice_unavailable"`
and voice commands return `command.error` with the same reason. The bot is still in the
meeting; use `send_chat` to reach people, and wait for `call.recovered` (the backend keeps
retrying) — or leave and rejoin with `--voice-strategy direct`.

## Context: what to put in it (up to 10,000 characters)

`--context` (API `realtime.context`) goes straight into the bot's instructions, so it is not only
for facts — the bot follows instructions there too. Use it for:

1. **Facts** the bot can answer from without asking you: team, agenda, names, dates, numbers.
2. **Behaviour**: tone ("Be polite and professional in every answer: courteous, respectful and to
   the point, never casual or argumentative."), how much to say, who it works for.
3. **What to hand to you.** The bot asks you through its tool **`ask_agent`** (you receive it as
   `agent.request`). Name the tool and say what should go through it, e.g. "For anything about our
   tickets, deployments or customer accounts, use ask_agent." or "When someone asks to share,
   schedule or send something, use ask_agent with the exact request."
4. **Languages**, if you don't use `--languages` (the flag is preferred).

Example:

```text
You are Juno, the Atlas team's assistant in their weekly planning meeting.
People: Dana (lead), Arjun (backend), Mei (design). Launch: 14 November. Open risk: payment provider review.
Be polite and professional in every answer: courteous, respectful and to the point.
For anything about our tickets, the release checklist or customer accounts, use ask_agent.
When someone asks you to share, send or schedule something, use ask_agent with the exact request.
```

`voice.context_update` replaces the whole context mid-call (same 10,000-character limit; longer →
`command.error` reason `context_too_long`, nothing changed). Send the full new text each time.

## Tips

- **Put what the bot should know in `--context`** (see above) and update it with
  `voice.context_update` as the meeting goes on — the bot answers from it without asking you.
- **Pick a short, distinctive name** and add its likely misspellings as trigger words.
- **Languages:** set the meeting's languages with `--languages "Malayalam,English"` whenever you
  know them. The bot then speaks only those (in whichever of them it is spoken to, or one someone
  asks for), and answers anything else in the first one — speech recognition sometimes hears a
  few words of the meeting as another language, and without the list the bot may answer in that
  language. Without `--languages` it replies in the language it is spoken to in and keeps a
  language someone asks it to use until asked for another.
- **Interruptions:** in noisy meetings, or when people often say "mm" / "okay" while the bot
  talks, raise `--interruption-loudness` (e.g. 50). If the bot misses short answers like "yes" or
  its name, lower it (e.g. 30). It applies to everything the bot hears, not only to interruptions.
- **Keep answers speakable**: short sentences, no markdown, URLs or code — send those with
  `send_chat`.
- The transcript in `agent.request` and the `--output` file is the meeting record; the bot
  transcribes the meeting itself (`--no-transcription` is implied and not billed).

## Tasks nobody hands to the bot

Tasks people mention to each other ("we need to send the report by Friday") don't reach you as
requests — they are in the `--output` file, written line by line as they are said. Don't read the
whole file all the time (it burns tokens). Instead: watch it for keywords with a second filter,
e.g. `tail -f "$EVENTS" | grep --line-buffered -i -E '"event": ?"user\.message".*(action item|follow[- ]?up|to-?do|deadline|remind|send|by (monday|tuesday|wednesday|thursday|friday|tomorrow|end of))'`;
or glance at the new lines when an `agent.request` arrives; and read it once at the end for action
items and decisions. In realtime this file is the only full transcript — always pass `--output`.

## Pricing

The realtime voice is billed per minute on top of the normal meeting-bot rate (it transcribes
the meeting itself, so there is no separate transcription charge). A minute is billed at the
**team** rate when the whole minute was a group call (two or more people besides the bot) and the
bot spoke fewer than 3 times in it; otherwise at the **one-on-one** rate. Rates per plan:
[agentcall.dev/pricing](https://agentcall.dev/pricing).

## API (without the bridge)

`POST /v1/calls` with `"voice_strategy": "realtime"` and an optional `realtime` object:

```json
{"meet_url": "https://meet.google.com/abc-def-ghi", "bot_name": "Juno", "mode": "audio",
 "voice_strategy": "realtime",
 "realtime": {"trigger_words": ["juno", "zuno"], "context": "...", "audience": "auto",
              "voice": "female.breezy", "search": true, "languages": ["English", "Hindi"],
              "vad_confirm_ms": 500, "vad_min_loud_frames": 14}}
```

Events and commands on the call WebSocket are the same as above (commands use `type` instead
of `command`, e.g. `{"type": "inject.natural", "request_id": "req-1", "text": "..."}`).
Transcript lines arrive as `transcript.final` (people) and `voice.text` (the bot).
