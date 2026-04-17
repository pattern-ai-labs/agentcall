#!/usr/bin/env node
/**
 * AgentCall — Visual Voice Bridge with Screenshare (Node.js)
 *
 * Like bridge.js but with visual presence + screenshare capability.
 * The bot joins with an animated avatar (voice states visible to participants)
 * and can screenshare any URL into the meeting.
 *
 * Uses webpage-av-screenshare mode. By default starts a local avatar template
 * server and tunnels it to the cloud — no manual setup needed.
 *
 * Everything from bridge.js is included:
 *   - VAD gap buffering, chat I/O, raise hand, screenshots, graceful exit
 *
 * Additional features:
 *   - Bot has a visual avatar (7 voice states: listening, speaking, etc.)
 *   - Agent can screenshare public URLs or local ports into the meeting
 *   - Screenshare can be started/stopped dynamically during the call
 *   - Tunnel client runs automatically for local UI and screenshare
 *
 * Additional stdin commands:
 *   {"command": "screenshare.start", "url": "https://slides.google.com/..."}
 *   {"command": "screenshare.start", "port": 3001}
 *   {"command": "screenshare.stop"}
 *   {"command": "set_state", "state": "thinking"}
 *
 * Usage:
 *     export AGENTCALL_API_KEY="ak_ac_your_key"
 *     node bridge-visual.js "https://meet.google.com/abc" --name "Claude"
 *     node bridge-visual.js "https://meet.google.com/abc" --webpage-url "https://your-site.com/avatar"
 *     node bridge-visual.js "https://meet.google.com/abc" --ui-port 3000
 *
 * Dependencies:
 *     npm install ws
 */

import { readFileSync, existsSync, appendFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    webpageURL: '',
    screenshareURL: '',
    template: 'ring',
    uiPort: 0,
    screensharePort: 0,
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
    else if (a === '--webpage-url') opts.webpageURL = args[++i];
    else if (a === '--screenshare-url') opts.screenshareURL = args[++i];
    else if (a === '--template') opts.template = args[++i];
    else if (a === '--ui-port') opts.uiPort = parseInt(args[++i]);
    else if (a === '--screenshare-port') opts.screensharePort = parseInt(args[++i]);
    else if (a === '--max-duration') opts.maxDuration = parseInt(args[++i]);
    else if (a === '--alone-timeout') opts.aloneTimeout = parseInt(args[++i]);
    else if (a === '--silence-timeout') opts.silenceTimeout = parseInt(args[++i]);
  }

  if (!opts.meetURL) {
    console.error('Usage: bridge-visual.js <meet-url> [--name Agent] [--template ring] [--ui-port 3000]');
    process.exit(1);
  }

  // If using local port or public URL, don't use template
  if (opts.uiPort || opts.webpageURL) opts.template = '';

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
    this.timeout = timeout * 1000;
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
    if (this.pending.length > 0) this._resetTimer();
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
// TEMPLATE SERVER
// ──────────────────────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function startTemplateServer(templateName) {
  return new Promise((resolve, reject) => {
    const templatesBase = join(__dirname, '..', '..', 'ui-templates');
    const templateDir = join(templatesBase, templateName);
    const sharedJsPath = join(templatesBase, 'agentcall-audio.js');

    if (!existsSync(templateDir)) {
      reject(new Error(`Template '${templateName}' not found at ${templateDir}`));
      return;
    }

    const server = createServer((req, res) => {
      let urlPath = req.url.split('?')[0];

      // Serve shared JS
      if (urlPath === '/agentcall-audio.js' || urlPath === '/../agentcall-audio.js') {
        if (existsSync(sharedJsPath)) {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end(readFileSync(sharedJsPath, 'utf-8'));
          return;
        }
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Serve index
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

      const filePath = require('path').resolve(join(templateDir, urlPath));
      // Prevent path traversal — file must be inside template directory
      if (!filePath.startsWith(require('path').resolve(templateDir))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const ext = '.' + filePath.split('.').pop();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(readFileSync(filePath));
    });

    // Port 0 = random available port
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// TUNNEL CLIENT (inline, with path routing for UI + screenshare)
// ──────────────────────────────────────────────────────────────────────────────

class BridgeTunnelClient {
  constructor(tunnelWSURL, tunnelId, accessKey, uiPort, screensharePort = 0) {
    this.tunnelWSURL = tunnelWSURL;
    this.tunnelId = tunnelId;
    this.accessKey = accessKey;
    this.uiPort = uiPort;
    this.screensharePort = screensharePort;
    this.webpagePort = 0;
    this.ws = null;
    this.running = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.running = true;
      this.ws = new WebSocket(this.tunnelWSURL);

      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({
          type: 'tunnel.register',
          payload: {
            tunnel_id: this.tunnelId,
            tunnel_access_key: this.accessKey,
          },
        }));
        emitErr(`Tunnel client connected (tunnel_id=${this.tunnelId.substring(0, 8)}...)`);
        resolve();
      });

      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'http.request') {
            this._handleHTTP(msg);
          } else if (msg.type === 'tunnel.error') {
            emitErr(`TUNNEL ERROR: ${msg.message || 'unknown'}`);
            emit({ event: 'error', message: `Tunnel: ${msg.message || 'unknown'}` });
          }
        } catch {}
      });

      this.ws.on('close', () => {
        if (this.running) emitErr('Tunnel connection lost');
      });

      // Heartbeat
      this._heartbeat = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
      }, 30000);
    });
  }

  _resolvePort(path) {
    if (path.startsWith('/screenshare') && this.screensharePort) {
      return { port: this.screensharePort, localPath: path.substring('/screenshare'.length) || '/' };
    }
    if (path.startsWith('/webpage') && this.webpagePort) {
      return { port: this.webpagePort, localPath: path.substring('/webpage'.length) || '/' };
    }
    if (path.startsWith('/ui')) {
      return { port: this.uiPort, localPath: path.substring('/ui'.length) || '/' };
    }
    return { port: this.uiPort, localPath: path };
  }

  _handleHTTP(msg) {
    const payload = msg.payload || msg;
    const requestId = payload.request_id || msg.request_id || '';
    const method = payload.method || 'GET';
    const path = payload.path || '/';
    const headers = payload.headers || {};
    const reqBody = payload.body || '';

    const { port, localPath } = this._resolvePort(path);

    const options = { hostname: 'localhost', port, path: localPath, method, headers };
    const req = require('http').request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        const respHeaders = {};
        for (const [k, v] of Object.entries(res.headers)) {
          respHeaders[k] = Array.isArray(v) ? v[0] : v;
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'http.response',
            request_id: requestId,
            payload: { request_id: requestId, status: res.statusCode, headers: respHeaders, body },
          }));
        }
      });
    });

    req.on('error', (err) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'http.response',
          request_id: requestId,
          payload: { request_id: requestId, status: 502, headers: { 'Content-Type': 'text/plain' }, body: `Local server error: ${err.message}` },
        }));
      }
    });

    if (reqBody) req.write(reqBody);
    req.end();
  }

  close() {
    this.running = false;
    clearInterval(this._heartbeat);
    if (this.ws) this.ws.close();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// API
// ──────────────────────────────────────────────────────────────────────────────

async function apiCall(method, path, body) {
  const url = `${API_BASE}${path}`;
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
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

function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

async function reconnectWS(callId) {
  const delays = [1, 5, 10, 30];
  const wsURL = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://');
  const wsURI = `${wsURL}/v1/calls/${callId}/ws?api_key=${API_KEY}`;
  for (let i = 0; i < delays.length; i++) {
    emitErr(`WebSocket reconnecting in ${delays[i]}s (attempt ${i + 1}/${delays.length})...`);
    await sleepMs(delays[i] * 1000);
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

  let uiPort = opts.uiPort;
  let templateServer = null;

  // ── Start template server if needed ──
  if (opts.template && !opts.webpageURL && !uiPort) {
    try {
      const result = await startTemplateServer(opts.template);
      templateServer = result.server;
      uiPort = result.port;
      emitErr(`Template '${opts.template}' serving on port ${uiPort}`);
    } catch (e) {
      emit({ event: 'error', message: `Failed to start template: ${e.message}` });
      process.exit(1);
    }
  }

  // ── Create call ──
  emitErr(`Creating visual call for: ${opts.meetURL}`);
  let call;
  try {
    const params = {
      meet_url: opts.meetURL,
      bot_name: opts.name,
      mode: 'webpage-av-screenshare',
      voice_strategy: 'direct',
      transcription: true,
    };
    if (opts.webpageURL) params.webpage_url = opts.webpageURL;
    if (opts.screenshareURL) params.screenshare_url = opts.screenshareURL;
    if (uiPort) params.ui_port = uiPort;
    if (opts.screensharePort) params.screenshare_port = opts.screensharePort;
    if (opts.maxDuration > 0) params.max_duration = opts.maxDuration * 60000;
    if (opts.aloneTimeout > 0) params.alone_timeout = opts.aloneTimeout * 1000;
    if (opts.silenceTimeout > 0) params.silence_timeout = opts.silenceTimeout * 1000;
    call = await apiCall('POST', '/v1/calls', params);
  } catch (e) {
    emit({ event: 'error', message: e.message });
    process.exit(1);
  }

  const callId = call.call_id;
  const tunnelId = call.tunnel_id || '';
  const tunnelAccessKey = call.tunnel_access_key || '';
  const tunnelUrl = call.tunnel_url || '';
  emitErr(`Call created: ${callId}`);
  emit({ event: 'call.created', call_id: callId, status: call.status || '' });

  // ── Start tunnel client if using local port ──
  let tunnelClient = null;
  let tunnelBaseUrl = '';
  if (tunnelId && tunnelAccessKey && uiPort) {
    const tunnelWS = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://');
    tunnelClient = new BridgeTunnelClient(
      `${tunnelWS}/internal/tunnel/connect`,
      tunnelId, tunnelAccessKey, uiPort, opts.screensharePort
    );
    try {
      await tunnelClient.connect();
      if (tunnelUrl.endsWith('/ui/')) tunnelBaseUrl = tunnelUrl.slice(0, -4);
      else if (tunnelUrl.endsWith('/ui')) tunnelBaseUrl = tunnelUrl.slice(0, -3);
      emitErr('Tunnel client connected — waiting for bot to join');
    } catch (e) {
      emit({ event: 'error', message: `Tunnel connection failed: ${e.message}` });
      process.exit(1);
    }
  }

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

    } else if (command === 'screenshare.start') {
      let url = cmd.url || '';
      const port = cmd.port || 0;
      if (port && tunnelClient && tunnelBaseUrl) {
        tunnelClient.screensharePort = port;
        url = tunnelBaseUrl + '/screenshare/';
        emitErr(`Screenshare tunneling localhost:${port}`);
      }
      if (url) {
        await safeSend({ type: 'screenshare.start', url });
      } else {
        emit({ event: 'screenshare.error', message: "screenshare.start requires 'url' or 'port'" });
      }

    } else if (command === 'screenshare.stop') {
      await safeSend({ type: 'screenshare.stop' });
      if (tunnelClient) tunnelClient.screensharePort = 0;

    } else if (command === 'webpage.open') {
      const port = cmd.port || 0;
      if (port && tunnelClient && tunnelBaseUrl) {
        tunnelClient.webpagePort = port;
        const webpageUrl = tunnelBaseUrl + '/webpage/';
        emitErr(`Webpage tunneling localhost:${port}`);
        emit({ event: 'webpage.opened', url: webpageUrl });
      } else {
        emit({ event: 'webpage.error', message: "webpage.open requires 'port' and an active tunnel" });
      }

    } else if (command === 'webpage.close') {
      if (tunnelClient) tunnelClient.webpagePort = 0;
      emit({ event: 'webpage.closed' });

    } else if (command === 'set_state') {
      await safeSend({ type: 'voice.state_update', state: cmd.state || 'listening' });

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
      } else if (eventType === 'screenshare.started') {
        emit({ event: 'screenshare.started', url: event.url || '' });
        emitErr('Screenshare started');
      } else if (eventType === 'screenshare.stopped') {
        emit({ event: 'screenshare.stopped' });
        emitErr('Screenshare stopped');
      } else if (eventType === 'screenshare.error') {
        emit({ event: 'screenshare.error', message: event.message || 'unknown' });
        emitErr(`Screenshare error: ${event.message || ''}`);
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
      if (!done) emitErr(`WebSocket error: ${err.message}`);
    });
  }

  wireWS(ws);

  function cleanup() {
    vad.flush();
    rl.close();
    if (tunnelClient) tunnelClient.close();
    if (templateServer) templateServer.close();
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
