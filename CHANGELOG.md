# Changelog

Notable changes to the AgentCall `join-meeting` skill. The version is tracked in
`.claude-plugin/plugin.json`.

## [1.1.25] - 2026-11-12

### Added
- **Realtime voice strategy** (`--voice-strategy realtime`, all four bridges, `join.py` / `join.js`
  and `run.sh`): the bot has its own voice that hears the meeting and answers by itself — greetings,
  simple questions, quick web lookups — and asks you with `agent.request` (`request_id`, `question`,
  `transcript` since the previous request) when it needs facts, tools, a decision or a task done
  (chat posts, messages, your own systems, research, writing). Answer with `inject.natural` + the
  `request_id` (`"final": false` for a status update first). `agent.leave_request` when someone asks
  the bot to leave. Guide: `references/guides/realtime-mode.md`. Direct and collaborative are
  unchanged; the default strategy stays `direct`.
- **Realtime commands:** `inject.natural` (with `request_id` to answer a request, without it to
  say something now), `voice.context_update` and `tasks.set` (the bot can tell people what it is
  working on). The bridges refuse `tts.speak`, `inject.verbatim`, `trigger.speak` and
  `voice.contribute` in realtime with `command.error` (`tts.error` for `tts.speak`).
- **Realtime flags:** `--trigger-words`, `--context` (the realtime voice takes up to 10,000 characters of
  context: facts, tone, and what to hand to you), `--audience auto|one-on-one|team`, `--voice`
  (`female.breezy` default — best performance,
  `female.firm`, `female.bright`, `male.upbeat`, `male.firm`, `male.calm`), `--search on|off`,
  `--languages "Malayalam,English"` (the only languages the bot may speak, the first is its
  default), `--interruption-loudness 0-100` (how much of the first half-second of a sound must be
  loud before it stops the bot; default 55, recommended 30–60), `--transcript-events`,
  `--voice-events`. In realtime the `--output` file is the full meeting transcript.
- SKILL.md: realtime first under Usage and Interaction Patterns (Pattern 6: Realtime Assistant),
  call-loop steps for realtime requests (status update, `tasks.set`, hand the work to a subagent
  with full context, answer, clear the task), and a keyword filter for tasks people mention to each
  other.

### Fixed
- SKILL.md event filters (`tail -f | grep`, PowerShell `Select-String`) now also match the Node
  bridges' compact JSON (`"event":"…"`) — before, agents using the Node bridges matched no events.

## [1.1.24] - 2026-11-10

### Fixed
- **Non-English text from Windows agents:** the Python bridges (`bridge.py`, `bridge-visual.py`),
  `join.py` and the coding-companion example now read stdin commands as UTF-8 on every platform.
  On Windows they used the system code page, so chat messages and `tts.speak` text in other
  languages arrived garbled, some characters (Chinese, Hindi) stopped the command reader for the
  rest of the call, and a leading byte-order mark dropped the first command. `--help` and log lines
  no longer crash on characters the console can't show. Node bridges were not affected.
- SKILL.md / api.md: commands are UTF-8 JSON; `\uXXXX` escapes always work.

## [1.1.23] - 2026-11-10

### Added
- **Reservations (fast join, Pro / Enterprise):** reserve up to 4 bots of one mode for a fixed
  15-minute window, 5 minutes to 7 days ahead; a reserved bot skips the machine start. New scripts
  `scripts/python/reserve.py` and `scripts/node/reserve.js` (`book --mode --count --start <ISO | +10m>`,
  `list`, `get <id>`, `cancel <id>`; standard library only). New optional `--reservation-id res_...`
  on all four bridges, `join.py` / `join.js` (and so `run.sh`): adds `reservation_id` to the
  create-call request only when given. The bridges forward the new `call.reservation` event
  (`result`: `claimed` = fast start; `not_ready` / `exhausted` / `expired` / `unavailable` = normal
  start). Guide: `references/guides/reservations.md`; API: `references/api.md` → Reservations.
  Without the flag nothing changes (same request body, same events).

## [1.1.22] - 2026-11-09

### Changed
- **Bot names on Microsoft Teams** (#30): names with characters other than letters, numbers, spaces
  and `- _ .` never got past "joining" on Teams; AgentCall now removes those characters (and Google
  Meet's dropped `'`) when the call is created. The bridges use the returned name for their own-name
  matching and report it in `call.created` (`bot_name`, `bot_name_requested`) when it differs;
  `join.py` / `join.js` include `bot_name` in their `call.created` line. SKILL.md "Bot Naming" lists
  the allowed characters; `references/api.md` documents the new response fields.

## [1.1.21] - 2026-10-24

### Added
- **Collaborative voice strategy in the bridges** (`bridge.py`, `bridge-visual.py`, `bridge.js`,
  `bridge-visual.js`): `--voice-strategy collaborative` with `--trigger-words`, `--context`,
  `--barge-in-prevention on|off`, `--voice` (`voice.heart` default) and `--voice-events`.
  Voice intelligence speaks for the bot: speak with `inject.verbatim` / `inject.natural`, steer with
  `trigger.speak`, `voice.contribute`, `voice.context_update` — each answered by the backend's
  `command.ack` / `command.error`. New stdout events: `voice.text`, `call.degraded`,
  `call.recovered`, and `voice.state` with `--voice-events`. `tts.speak` is rejected in this mode;
  screenshare, webpage, chat, mic and avatar commands work as before. Direct mode is unchanged.

### Changed
- When voice intelligence is unavailable in collaborative mode, the docs now say to use `send_chat`
  until `call.recovered` (or rejoin in direct mode) instead of falling back to `tts.speak`.

## [1.1.20] - 2026-10-23

### Added
- **Mic result.** The `mic` command now gets a real reply: after the `command.ack`, the bridges
  forward `meeting.mic.result` (`action`, `muted`, `noop`, `warning`), so the agent knows whether
  the bot's mic is actually on in the meeting. If no result arrives within 5 s, the bridge sends
  `command.error` for `mic`. On the WebSocket API, `meeting.mic` is answered with
  `meeting.mic.result` (also carries `label` and `request_id`).

## [1.1.19] - 2026-10-22

### Added
- **Bring your own voice (#3).** New example [`examples/elevenlabs-voice`](examples/elevenlabs-voice/)
  (Python + Node.js): a bot that speaks with an ElevenLabs voice using your own API key —
  ElevenLabs PCM 16 kHz streamed into the call with paced `audio.inject`, with barge-in via
  `audio.clear`. New guide `references/guides/bring-your-own-voice.md` (format, pacing,
  barge-in, billing). Works with any provider that returns raw PCM. Audio mode only.

## [1.1.18] - 2026-10-22

### Fixed
- **Tunnel handles binary and request bodies (#18).** Pages served through the tunnel
  (`--ui-port`, screenshare and webpage ports) can now load images, fonts and other binary
  files, receive compressed responses, and send POST/PUT bodies (binary included). Previously
  binary responses failed (Python: 502; Node: corrupted) and request bodies reached the local
  server still base64-encoded. All four tunnel clients (`tunnel.py`, `bridge-visual.py`,
  `tunnel.js`, `bridge-visual.js`) negotiate the new binary-safe format with the server, so
  mixed versions keep working.
- **Node `tunnel.js`** (used by `join.js --port`) now strips the `/ui` prefix like the other
  clients, so the local server receives `/app.js` instead of `/ui/app.js`.

### Changed
- Docs: use relative paths in pages served through the tunnel (absolute paths miss the
  per-call prefix).

## [1.1.17] - 2026-10-22

### Changed
- **Voice commands are never silently ignored.** `inject.natural`, `inject.verbatim`,
  `trigger.speak`, `voice.contribute` and `voice.context_update` now always get a reply:
  `command.ack` when delivered, or `command.error` with a `reason` (`not_collaborative`,
  `voice_not_ready`, `voice_unavailable`) when not (#15). Meeting commands sent before the bot
  is connected return `command.error` with `reason: "bot_not_connected"`. Replies echo
  `request_id` and respect `event_filter`.
- `call.state` includes `voice` (`starting` / `connected` / `reconnecting` / `unavailable`) on
  collaborative calls.
- Docs: `tts.speak` / `tts.generate` work in both voice strategies.

These are additive server-side changes; existing bridges and older skill versions are unaffected.

## [1.1.16] - 2026-10-22

### Fixed
- **websockets ≥ 14 compatibility.** `bridge-visual.py` and `tunnel.py` no longer
  crash with `AttributeError: 'ClientConnection' object has no attribute 'closed'`
  on websockets 14 and later (#17). Works with websockets 12 through 17.

### Added
- **Bridge stdin `type` / `command` compatibility + observability.** All four
  bridges (`bridge.py`, `bridge-visual.py`, `bridge.js`, `bridge-visual.js`) now
  accept raw API `type` names on stdin (e.g. `{"type": "meeting.mic",
  "action": "on"}`) alongside the existing `command` shorthand, and emit
  `command.ack` / `command.error` events so a stdin line that never reaches the
  bridge surfaces explicitly instead of failing as a silent no-op. Existing
  `{"command": ...}` inputs are unchanged. Thanks to
  [@keithballinger](https://github.com/keithballinger) (#2, with #7–#9).

## [1.1.15] - 2026-07-01

### Added
- **Self-service registration.** Agents without an API key can now register via
  email — no dashboard visit required. New `scripts/python/register.py` and
  `scripts/node/register.js` (`send` / `verify` subcommands) email a 6-digit code,
  verify it, mint an API key named `AgentCall Skill on <hostname>`, and save it to
  `~/.agentcall/config.json`. Agents that can read their own mailbox complete this
  autonomously; otherwise the agent asks you to paste the code. New accounts
  include free trial credits, so the first call works immediately.

### Changed
- `SKILL.md` "API Key Setup" rewritten to a two-option flow (self-register, or
  paste an existing key). Both scripts use only the language standard library, so
  they run before `pip install` / `npm install`.

## [1.1.14] - 2026-05-19

- First tagged public release: multi-ecosystem install (Claude Code, Cursor, Codex,
  Gemini, Windsurf, Copilot, OpenClaw, Junie), the `pattern` avatar template, TTS
  ordering + drain-on-interrupt fixes, the conversational-style TTS rule,
  multi-sentence batching, and `SKILL.md` refinements.
