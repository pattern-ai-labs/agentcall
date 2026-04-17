#!/usr/bin/env node
/**
 * AgentCall — Voice Bridge for AI Coding Agents (Node.js)
 *
 * This script bridges a meeting's audio I/O with an AI agent framework
 * (Claude Code, Cursor, Codex, Gemini CLI, etc.) via stdin/stdout.
 *
 * It is NOT a standalone agent. It has NO LLM. The agent framework that
 * spawns this script IS the LLM. This script is a thin communication layer:
 *
 *   stdout → agent framework: meeting events (transcripts, chat, participants)
 *   stdin  ← agent framework: commands (tts.speak, send chat, leave, raise hand)
 *
 * KEY FEATURES:
 *   - VAD gap buffering: accumulates transcript.final events and waits for a
 *     configurable silence gap before emitting to the agent.
 *   - Barge-in prevention: tts.speak waits for silence before sending.
 *   - Chat I/O: agent can send and receive meeting chat messages.
 *   - Screenshot: agent can take a screenshot of the meeting view.
 *   - Raise hand: agent can raise the bot's hand before speaking.
 *   - Graceful exit: agent can leave the call.
 *
 * Usage:
 *     export AGENTCALL_API_KEY="ak_ac_your_key"
 *     node bridge.js "https://meet.google.com/abc-def-ghi"
 *
 *     # Custom bot name, voice, and VAD timeout
 *     node bridge.js "https://meet.google.com/abc" --name "Claude" --voice af_bella --vad-timeout 3.0
 *
 * Dependencies:
 *     npm install ws
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import WebSocket from 'ws';

// ──────────────────────────────────────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), '.agentcall', 'config.json');
let _cfg = {};
if (existsSync(CONFIG_PATH)) {
  try { _cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
}

const API_BASE = process.env.AGENTCALL_API_URL || _cfg.api_url || 'https://api.agentcall.dev';
const API_KEY = process.env.AGENTCALL_API_KEY || _cfg.api_key || '';

if (!API_KEY) {
  console.error('[bridge] API key not found. Set AGENTCALL_API_KEY env var or save to ~/.agentcall/config.json');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────────
// ARGS
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    meetURL: '',
    name: 'Agent',
    voice: 'af_heart',
    vadTimeout: 2.0,
    output: '',
    maxDuration: 0,
    aloneTimeout: 0,
    silenceTimeout: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--') && !opts.meetURL) { opts.meetURL = a; }
    else if (a === '--name') opts.name = args[++i];
    else if (a === '--voice') opts.voice = args[++i];
    else if (a === '--vad-timeout') opts.vadTimeout = parseFloat(args[++i]);
    else if (a === '--output') opts.output = args[++i];
    else if (a === '--max-duration') opts.maxDuration = parseInt(args[++i]);
    else if (a === '--alone-timeout') opts.aloneTimeout = parseInt(args[++i]);
    else if (a === '--silence-timeout') opts.silenceTimeout = parseInt(args[++i]);
  }

  if (!opts.meetURL) {
    console.error('Usage: bridge.js <meet-url> [--name Agent] [--voice af_heart] [--vad-timeout 2.0]');
    process.exit(1);
  }
  return opts;
}

// ──────────────────────────────────────────────────────────────────────────────
// EMIT
// ──────────────────────────────────────────────────────────────────────────────

let outputFile = '';

function emit(event) {
  const line = JSON.stringify(event);
  console.log(line);
  if (outputFile) {
    try { appendFileSync(outputFile, line + '\n'); } catch {}
  }
}

function emitErr(msg) {
  console.error(`[bridge] ${msg}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// VAD BUFFER
// ──────────────────────────────────────────────────────────────────────────────

class VADBuffer {
  constructor(timeout = 2.0, onComplete = null) {
    this.timeout = timeout * 1000; // convert to ms
    this.pending = [];
    this.speaker = 'User';
    this.timer = null;
    this.onComplete = onComplete;
  }

  onTranscriptFinal(speaker, text) {
    text = text.trim();
    if (!text) return;
    this.pending.push(text);
    this.speaker = speaker;
    this._resetTimer();
  }

  onTranscriptPartial(speaker, text) {
    if (this.pending.length > 0) {
      this._resetTimer();
    }
  }

  _resetTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._emit(), this.timeout);
  }

  _emit() {
    if (this.pending.length > 0 && this.onComplete) {
      const combined = this.pending.join(' ');
      const speaker = this.speaker;
      this.pending = [];
      this.onComplete(speaker, combined);
    }
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this._emit();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// API CLIENT
// ──────────────────────────────────────────────────────────────────────────────

async function apiCall(method, path, body) {
  const url = `${API_BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function checkCallActive(callId) {
  try {
    const data = await apiCall('GET', `/v1/calls/${callId}`);
    if (data.status === 'ended' || data.status === 'error') {
      return { active: false, reason: data.end_reason || data.status };
    }
    return { active: true, reason: '' };
  } catch {
    return { active: false, reason: 'api_unreachable' };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function reconnectWS(callId) {
  const delays = [1, 5, 10, 30];
  const wsURL = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://');
  const wsURI = `${wsURL}/v1/calls/${callId}/ws?api_key=${API_KEY}`;
  for (let i = 0; i < delays.length; i++) {
    emitErr(`WebSocket reconnecting in ${delays[i]}s (attempt ${i + 1}/${delays.length})...`);
    await sleep(delays[i] * 1000);
    const { active, reason } = await checkCallActive(callId);
    if (!active) {
      emitErr(`Call no longer active: ${reason}`);
      return null;
    }
    try {
      const newWs = new WebSocket(wsURI);
      await new Promise((resolve, reject) => {
        newWs.on('open', resolve);
        newWs.on('error', reject);
      });
      emitErr('WebSocket reconnected successfully');
      return newWs;
    } catch (e) {
      emitErr(`Reconnect attempt ${i + 1} failed: ${e.message}`);
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  outputFile = opts.output;
  if (outputFile) emitErr(`Events also writing to: ${outputFile}`);

  // ── Create call ──
  emitErr(`Creating call for: ${opts.meetURL}`);
  let call;
  try {
    const params = {
      meet_url: opts.meetURL,
      bot_name: opts.name,
      mode: 'audio',
      voice_strategy: 'direct',
      transcription: true,
    };
    if (opts.maxDuration > 0) params.max_duration = opts.maxDuration * 60000;
    if (opts.aloneTimeout > 0) params.alone_timeout = opts.aloneTimeout * 1000;
    if (opts.silenceTimeout > 0) params.silence_timeout = opts.silenceTimeout * 1000;
    call = await apiCall('POST', '/v1/calls', params);
  } catch (e) {
    emit({ event: 'error', message: e.message });
    process.exit(1);
  }

  const callId = call.call_id;
  emitErr(`Call created: ${callId}`);
  emit({ event: 'call.created', call_id: callId, status: call.status || '' });

  // ── VAD buffer ──
  const vad = new VADBuffer(opts.vadTimeout, (speaker, text) => {
    emit({ event: 'user.message', speaker, text });
  });

  // ── Connect WebSocket ──
  const wsURL = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://');
  const wsURI = `${wsURL}/v1/calls/${callId}/ws?api_key=${API_KEY}`;
  let ws;
  try {
    ws = new WebSocket(wsURI);
  } catch (e) {
    emit({ event: 'error', message: `WebSocket connection failed: ${e.message}` });
    process.exit(1);
  }

  // ── State ──
  const botNameLower = opts.name.toLowerCase();
  let isSpeaking = false;
  let greeted = false;
  const participants = new Set();
  let lastPartialTime = 0;
  let done = false;

  // ── Barge-in helper ──
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitForSilence() {
    const vadMs = opts.vadTimeout * 1000;
    while (Date.now() - lastPartialTime < vadMs && !done) {
      await sleep(200);
    }
  }

  // ── Safe send with retry (handles WS reconnect windows) ──
  async function safeSend(payload) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
          return true;
        }
        throw new Error('ws not open');
      } catch (e) {
        emitErr(`send failed (attempt ${attempt + 1}/3): ${e.message || e}`);
        await sleep(500 * (attempt + 1));
      }
    }
    emitErr(`dropped command after 3 failures: ${payload.type || '?'}`);
    return false;
  }

  // ── Stdin reader ──
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let cmd;
    try { cmd = JSON.parse(line.trim()); } catch { return; }
    const command = cmd.command || '';

    if (command === 'tts.speak') {
      // Barge-in prevention
      if (lastPartialTime > 0) await waitForSilence();
      if (done) return;
      await safeSend({
        type: 'tts.speak',
        text: cmd.text || '',
        voice: cmd.voice || opts.voice,
        speed: cmd.speed || 1.0,
      });
    } else if (command === 'send_chat') {
      await safeSend({ type: 'meeting.send_chat', message: cmd.message || '' });
    } else if (command === 'raise_hand') {
      await safeSend({ type: 'meeting.raise_hand' });
    } else if (command === 'mic') {
      await safeSend({ type: 'meeting.mic', action: cmd.action || 'on' });
    } else if (command === 'screenshot') {
      await safeSend({ type: 'screenshot.take', request_id: cmd.request_id || 'screenshot' });
    } else if (command === 'leave') {
      await safeSend({ type: 'meeting.leave' });
      done = true;
    }
  });

  // ── Wire up WebSocket event handlers ──
  function wireWS(socket) {
    socket.on('open', () => emitErr('WebSocket connected'));

    socket.on('message', (data) => {
      if (done) return;
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      const eventType = event.event || event.type || '';

      if (eventType === 'call.bot_joining_meeting') {
        emit({ event: 'call.bot_joining_meeting', call_id: callId, detail: event.detail || '' });
        emitErr(`Bot joining meeting (${event.detail || ''})`);
      } else if (eventType === 'call.bot_waiting_room') {
        emit({ event: 'call.bot_waiting_room', call_id: callId });
        emitErr('Bot is in the waiting room — waiting to be admitted');
      } else if (eventType === 'call.bot_ready') {
        emit({ event: 'call.bot_ready', call_id: callId });
        emitErr('Bot joined the meeting');
      } else if (eventType === 'participant.joined') {
        const p = event.participant || {};
        const name = p.name || event.name || 'Unknown';
        participants.add(name);
        emit({ event: 'participant.joined', name });
        emitErr(`Participant joined: ${name}`);
        if (!greeted && name.toLowerCase() !== botNameLower) {
          greeted = true;
          emit({
            event: 'greeting.prompt', participant: name,
            hint: `${name} joined. Introduce yourself and greet them via tts.speak. Active participation is the default — do not stay silent.`,
          });
        }
      } else if (eventType === 'participant.left') {
        const p = event.participant || {};
        const name = p.name || event.name || 'Unknown';
        participants.delete(name);
        emit({ event: 'participant.left', name });
      } else if (eventType === 'transcript.final') {
        const speakerObj = event.speaker || {};
        const speaker = typeof speakerObj === 'object' ? (speakerObj.name || 'Unknown') : String(speakerObj);
        const text = (event.text || '').trim();
        if (speaker.toLowerCase() === botNameLower) return;
        if (!text) return;
        vad.onTranscriptFinal(speaker, text);
      } else if (eventType === 'transcript.partial') {
        const speakerObj = event.speaker || {};
        const speaker = typeof speakerObj === 'object' ? (speakerObj.name || 'Unknown') : String(speakerObj);
        if (speaker.toLowerCase() === botNameLower) return;
        lastPartialTime = Date.now();
        vad.onTranscriptPartial(speaker, event.text || '');
      } else if (eventType === 'chat.message') {
        const sender = event.sender || 'Unknown';
        const message = event.message || '';
        if (sender.toLowerCase() !== botNameLower && message) {
          emit({ event: 'chat.received', sender, message });
        }
      } else if (eventType === 'screenshot.result') {
        emit({ event: 'screenshot.result', data: event.data || '', width: event.width || 0, height: event.height || 0, request_id: event.request_id || '' });
      } else if (eventType === 'tts.started') {
        isSpeaking = true;
      } else if (eventType === 'tts.done') {
        isSpeaking = false;
        emit({ event: 'tts.done' });
      } else if (eventType === 'tts.error') {
        isSpeaking = false;
        emit({ event: 'tts.error', reason: event.reason || 'unknown' });
      } else if (eventType === 'tts.interrupted') {
        isSpeaking = false;
        emit({ event: 'tts.interrupted', reason: event.reason || 'user_speaking', sentence_index: event.sentence_index ?? -1, elapsed_ms: event.elapsed_ms || 0 });
      } else if (eventType === 'call.max_duration_warning') {
        emit({ event: 'call.max_duration_warning', minutes_remaining: event.minutes_remaining || 5 });
        emitErr(`Warning: call will end in ${event.minutes_remaining || 5} minutes (max duration)`);
      } else if (eventType === 'call.credits_low') {
        emit({ event: 'call.credits_low', balance_microcents: event.balance_microcents || 0, estimated_minutes_remaining: event.estimated_minutes_remaining || 0 });
        emitErr(`Warning: credits low — estimated ${event.estimated_minutes_remaining || 0} minutes remaining`);
      } else if (eventType === 'call.ended') {
        const reason = event.reason || 'unknown';
        emit({ event: 'call.ended', reason });
        emitErr(`Call ended: ${reason}`);
        done = true;
        cleanup();
      }
    });

    socket.on('close', async () => {
      if (done) return;
      emitErr('WebSocket disconnected, checking call status...');
      const newWs = await reconnectWS(callId);
      if (newWs) {
        ws = newWs;
        wireWS(ws);
        emitErr('Resuming event stream');
      } else {
        emit({ event: 'call.ended', reason: 'connection_lost' });
        emitErr('WebSocket reconnection failed — call ended');
        done = true;
        cleanup();
      }
    });

    socket.on('error', (err) => {
      if (!done) {
        emitErr(`WebSocket error: ${err.message}`);
      }
    });
  }

  wireWS(ws);

  function cleanup() {
    vad.flush();
    rl.close();
    if (ws.readyState === WebSocket.OPEN) ws.close();
    setTimeout(() => process.exit(0), 500);
  }

  process.on('SIGINT', () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'meeting.leave' }));
    }
    done = true;
    cleanup();
  });
  process.on('SIGTERM', () => {
    done = true;
    cleanup();
  });
}

main();
