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

// Collaborative voice strategy: commands handled by voice intelligence. The
// bridges forward them as-is and stay silent; the backend replies with
// command.ack (delivered) or command.error with a reason.
export const VOICE_COMMANDS = [
  'inject.verbatim', 'inject.natural', 'trigger.speak',
  'voice.contribute', 'voice.context_update',
];
export const COLLABORATIVE_VOICES = ['voice.heart', 'voice.bella', 'voice.echo', 'voice.eric'];

export const DEGRADED_HINT = 'Voice intelligence is unavailable. Use send_chat and wait for '
  + 'call.recovered, or leave and rejoin with --voice-strategy direct.';

// The backend payload for a voice command read from stdin: the same fields,
// with `type` set to the command name (the `command` shorthand is dropped).
export function voiceCommandPayload(cmd, command) {
  const { command: _shorthand, ...rest } = cmd;
  return { ...rest, type: command };
}

// The agent-facing copy of the backend's command.ack / command.error.
export function backendReply(event) {
  const out = { event: event.event || event.type, command: event.command || '' };
  for (const key of ['reason', 'message', 'request_id']) {
    if (event[key]) out[key] = event[key];
  }
  return out;
}

// Parse the collaborative launch flags into the call's `collaborative` config,
// or null for direct. Returns { collaborative, voice, error }.
export function collaborativeConfig(opts) {
  if (opts.voiceStrategy !== 'collaborative') {
    return { collaborative: null, voice: opts.voice || 'af_heart', error: '' };
  }
  const voice = opts.voice || 'voice.heart';
  if (!COLLABORATIVE_VOICES.includes(voice)) {
    return { collaborative: null, voice, error: `--voice ${voice} is not a collaborative voice; use one of: ${COLLABORATIVE_VOICES.join(', ')}` };
  }
  const collaborative = {
    trigger_words: (opts.triggerWords || '').split(',').map(w => w.trim()).filter(Boolean),
    barge_in_prevention: opts.bargeInPrevention !== 'off',
    voice,
  };
  if (opts.context) collaborative.context = opts.context;
  return { collaborative, voice, error: '' };
}
