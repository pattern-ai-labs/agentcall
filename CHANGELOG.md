# Changelog

Notable changes to the AgentCall `join-meeting` skill. The version is tracked in
`.claude-plugin/plugin.json`.

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
