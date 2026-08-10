// Shared stdin command-name resolution for the Node bridges (bridge.js,
// bridge-visual.js). Mirrors _stdin_command_name / _STDIN_TYPE_ALIASES in the
// Python bridges so all four bridge scripts accept the same stdin forms.
//
// Bridges accept BOTH the shorthand form (`{"command": "tts.speak", ...}`) and
// the raw API/WebSocket form (`{"type": "tts.speak", ...}`). For meeting
// actions the raw API name differs from the shorthand and is mapped here.
//
// Kept in its own import-safe module (no side effects on import) so it can be
// unit-tested without spawning a real bridge / meeting.

export const STDIN_TYPE_ALIASES = {
  'meeting.send_chat': 'send_chat',
  'meeting.raise_hand': 'raise_hand',
  'meeting.mic': 'mic',
  'meeting.leave': 'leave',
  'screenshot.take': 'screenshot',
};

// Resolve the bridge command name from a parsed stdin object. Prefers the
// `command` shorthand, falls back to the raw API `type`, then maps any raw API
// alias to its shorthand. Returns '' when neither field is present.
export function stdinCommandName(cmd) {
  const name = (cmd && (cmd.command || cmd.type)) || '';
  return Object.prototype.hasOwnProperty.call(STDIN_TYPE_ALIASES, name)
    ? STDIN_TYPE_ALIASES[name]
    : name;
}
