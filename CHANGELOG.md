# Changelog

Notable changes to the AgentCall `join-meeting` skill. The version is tracked in
`.claude-plugin/plugin.json`.

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
