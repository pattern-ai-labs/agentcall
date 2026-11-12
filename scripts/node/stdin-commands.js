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

// Realtime voice strategy: the voice commands plus tasks.set, forwarded as-is
// (the backend answers each with command.ack / command.error).
// Realtime voice strategy: only these voice commands are forwarded; the bot talks by itself.
export const REALTIME_COMMANDS = ['inject.natural', 'voice.context_update', 'tasks.set'];
// Refused in realtime by the bridge (they don't fit a bot that talks by itself).
export const REALTIME_REFUSED = ['tts.speak', 'inject.verbatim', 'trigger.speak', 'voice.contribute'];
export const REALTIME_REFUSED_MSG = 'Not available in realtime. Use inject.natural: with request_id to answer an '
  + 'agent.request, without it to say something now.';
export const REALTIME_VOICES = ['female.breezy', 'female.firm', 'female.bright', 'male.upbeat', 'male.firm', 'male.calm'];
export const REALTIME_DEFAULT_VOICE = 'female.breezy';
export const INTERRUPTION_WINDOW_MS = 500;
export const REALTIME_DEGRADED_HINT = "The bot's voice is unavailable; it will not answer on its own. Use "
  + 'send_chat and wait for call.recovered, or leave and rejoin with --voice-strategy direct.';
export const LEAVE_REQUEST_HINT = 'The bot said goodbye. Send {"command": "leave"} if the meeting is done for you.';

// Parse the realtime launch flags into the call's `realtime` config, or null
// when the strategy is not realtime. Returns { realtime, voice, error }.
export function realtimeConfig(opts) {
  if (opts.voiceStrategy !== 'realtime') {
    if (opts.languages) return { realtime: null, voice: opts.voice, error: '--languages needs --voice-strategy realtime' };
    if (opts.interruptionLoudness !== undefined) return { realtime: null, voice: opts.voice, error: '--interruption-loudness needs --voice-strategy realtime' };
    return { realtime: null, voice: opts.voice, error: '' };
  }
  const voice = opts.voice || REALTIME_DEFAULT_VOICE;
  if (!REALTIME_VOICES.includes(voice)) {
    return { realtime: null, voice, error: `--voice ${voice} is not a realtime voice; use one of: ${REALTIME_VOICES.join(', ')}` };
  }
  const audience = opts.audience || 'auto';
  if (!['auto', 'one-on-one', 'team'].includes(audience)) {
    return { realtime: null, voice, error: '--audience must be auto, one-on-one or team' };
  }
  const search = opts.search || 'on';
  if (!['on', 'off'].includes(search)) {
    return { realtime: null, voice, error: '--search must be on or off' };
  }
  const realtime = {
    voice,
    trigger_words: (opts.triggerWords || '').split(',').map(w => w.trim()).filter(Boolean),
    audience,
    search: search === 'on',
  };
  if (opts.context) realtime.context = opts.context;
  const languages = (opts.languages || '').split(',').map(l => l.trim()).filter(Boolean);
  if (languages.length) realtime.languages = languages;
  // Interruption: a new sound counts as speech when this share of its first 500 ms
  // (25 frames of 20 ms) is loud; at least 1 frame (0 would mean the backend default).
  const pct = opts.interruptionLoudness === undefined ? 55 : Number(opts.interruptionLoudness);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    return { realtime: null, voice, error: '--interruption-loudness must be 0-100' };
  }
  realtime.vad_confirm_ms = INTERRUPTION_WINDOW_MS;
  realtime.vad_min_loud_frames = Math.max(1, Math.ceil((INTERRUPTION_WINDOW_MS / 20) * pct / 100));
  return { realtime, voice, error: '' };
}
