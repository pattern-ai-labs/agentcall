# Changelog

Notable changes to the AgentCall `join-meeting` skill. The version is tracked in
`.claude-plugin/plugin.json`.

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
