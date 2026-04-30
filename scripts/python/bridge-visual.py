#!/usr/bin/env python3
"""
AgentCall — Visual Voice Bridge with Screenshare

Like bridge.py but with visual presence + screenshare capability.
The bot joins with an animated avatar (voice states visible to participants)
and can screenshare any URL into the meeting.

Uses webpage-av-screenshare mode. By default starts a local avatar template
server and tunnels it to the cloud — no manual setup needed.

Everything from bridge.py is included:
  - VAD gap buffering, chat I/O, raise hand, screenshots, graceful exit

Additional features:
  - Bot has a visual avatar (7 voice states: listening, speaking, etc.)
  - Agent can screenshare public URLs or local ports into the meeting
  - Screenshare can be started/stopped dynamically during the call
  - Tunnel client runs automatically for local UI and screenshare

PROTOCOL (extends bridge.py):

  Additional stdout events:
    {"event": "screenshare.started", "url": "https://..."}
    {"event": "screenshare.stopped"}
    {"event": "screenshare.error", "message": "Failed to load URL"}

  Additional stdin commands:
    {"command": "screenshare.start", "url": "https://slides.google.com/..."}
    {"command": "screenshare.start", "port": 3001}
    {"command": "screenshare.swap", "port": 3002}             — atomic stop+start
    {"command": "screenshare.swap", "url": "https://..."}    — atomic stop+start
    {"command": "screenshare.stop"}

Usage:
    export AGENTCALL_API_KEY="ak_ac_your_key"

    # With built-in avatar template (starts local server + tunnel automatically)
    python bridge-visual.py "https://meet.google.com/abc" --name "Claude"

    # With public webpage as bot's video feed (no tunnel needed)
    python bridge-visual.py "https://meet.google.com/abc" --webpage-url "https://your-site.com/avatar"

    # With custom local UI on port 3000 (tunnel auto-started)
    python bridge-visual.py "https://meet.google.com/abc" --ui-port 3000

Dependencies:
    pip install aiohttp websockets
"""

import argparse
import asyncio
import json
import os
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import aiohttp
import websockets


# ──────────────────────────────────────────────────────────────────────────────
# SCREENSHARE HELPERS
#
# These exist because FirstCall's headless browser caches the screenshare URL
# aggressively — a swap from one local port to another keeps showing the OLD
# content because the URL (https://tunnel/screenshare/) doesn't change.
#
# Cache-buster: append ?_acv=<ms> so every start is a fresh URL.
# Pre-flight: TCP-probe the local port before sending start, so a dead port
#             produces a clear screenshare.error instead of a silent white page.
# State tracking: lets screenshare.swap wait for FirstCall to confirm the
#                 previous screenshare has stopped before issuing the new start
#                 (eliminates race where start arrives before stop is processed).
# ──────────────────────────────────────────────────────────────────────────────

def _is_port_reachable(host: str, port: int, timeout: float = 0.5) -> bool:
    """Quick TCP probe — is something listening on host:port?"""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, socket.timeout):
        return False


def _cache_busted_url(base: str) -> str:
    """Append a millisecond timestamp as ?_acv= so FirstCall's browser reloads.
    Handles hash fragments correctly: per RFC 3986, query must precede fragment.
    Only used for the local tunnel URL — never for external URLs (would break
    signed URLs like S3/CloudFront/Vimeo where the signature includes the query)."""
    fragment = ""
    if "#" in base:
        base, frag = base.split("#", 1)
        fragment = "#" + frag
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}_acv={int(time.time() * 1000)}{fragment}"


class ScreenshareState:
    """Tracks screenshare lifecycle so screenshare.swap can wait for stop confirmation."""

    def __init__(self):
        self.active = False
        self._stopped_event = asyncio.Event()
        self._stopped_event.set()  # initially stopped → wait_stopped() returns immediately

    def mark_starting(self):
        """Bridge issued screenshare.start — active until FirstCall confirms stop."""
        self.active = True
        self._stopped_event.clear()

    def mark_stopped(self):
        """FirstCall confirmed screenshare.stopped (or error) — wake any swap waiters."""
        self.active = False
        self._stopped_event.set()

    async def wait_stopped(self, timeout: float = 5.0) -> bool:
        """Block until FirstCall confirms stop, or timeout. Returns True if confirmed."""
        try:
            await asyncio.wait_for(self._stopped_event.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False


# ──────────────────────────────────────────────────────────────────────────────
# EMIT HELPERS
#
# All output goes to stdout as single-line JSON objects.
# The agent framework reads these as events.
# stderr is used for debug logging (not visible to agent).
# ──────────────────────────────────────────────────────────────────────────────

_output_file = None  # set by --output flag

def emit(event: dict):
    """Send an event to the agent framework via stdout (and optionally to a file)."""
    line = json.dumps(event)
    print(line, flush=True)
    if _output_file:
        try:
            with open(_output_file, "a") as f:
                f.write(line + "\n")
        except Exception:
            pass


def emit_err(msg: str):
    """Log to stderr (visible in terminal, not to agent framework)."""
    print(f"[bridge] {msg}", file=sys.stderr, flush=True)


# ──────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ──────────────────────────────────────────────────────────────────────────────

_config_path = Path.home() / ".agentcall" / "config.json"
_config = {}
if _config_path.exists():
    try:
        _config = json.loads(_config_path.read_text())
    except (json.JSONDecodeError, OSError):
        pass

API_BASE = os.environ.get("AGENTCALL_API_URL", "") or _config.get("api_url", "") or "https://api.agentcall.dev"
API_KEY = os.environ.get("AGENTCALL_API_KEY", "") or _config.get("api_key", "")

if not API_KEY:
    emit_err("API key not found. Set AGENTCALL_API_KEY env var or save to ~/.agentcall/config.json")
    sys.exit(1)


# ──────────────────────────────────────────────────────────────────────────────
# VAD GAP BUFFER
#
# Problem: FirstCall's STT splits long utterances into multiple transcript.final
# events. A speaker who pauses mid-sentence gets split:
#   final: "Can you check the"      (1s gap)
#   final: "health endpoint"         (1s gap)
#   final: "and also the database"
#
# If we emit each final separately, the agent sees 3 separate instructions
# instead of one: "Can you check the health endpoint and also the database"
#
# Solution: Buffer finals and wait for a silence gap (configurable, default 2s).
# If a transcript.partial arrives during the gap, the user is still speaking —
# reset the timer. Only emit the combined text when silence confirms the user
# is done speaking.
#
# This is especially important for:
# - Slow speakers who pause between phrases
# - Complex instructions with natural pauses
# - Non-native speakers who think between words
# ──────────────────────────────────────────────────────────────────────────────

class VADBuffer:
    """Accumulates transcript finals and emits after a silence gap."""

    def __init__(self, timeout: float = 2.0):
        self.timeout = timeout
        self.pending: list[str] = []
        self.speaker: str = "User"
        self.timer_task: Optional[asyncio.Task] = None
        self.on_complete = None  # callback: async fn(speaker, text)

    def on_transcript_final(self, speaker: str, text: str):
        """Add a final transcript. Start/reset the silence timer."""
        text = text.strip()
        if not text:
            return

        self.pending.append(text)
        self.speaker = speaker
        self._reset_timer()

    def on_transcript_partial(self, speaker: str, text: str):
        """
        A partial transcript arrived — user is still speaking.
        Reset the timer if we have pending finals.
        """
        if self.pending:
            self._reset_timer()

    def _reset_timer(self):
        """Cancel existing timer and start a new one."""
        if self.timer_task and not self.timer_task.done():
            self.timer_task.cancel()
        self.timer_task = asyncio.create_task(self._wait_and_emit())

    async def _wait_and_emit(self):
        """Wait for silence, then emit combined text."""
        try:
            await asyncio.sleep(self.timeout)
            if self.pending and self.on_complete:
                combined = " ".join(self.pending)
                speaker = self.speaker
                self.pending.clear()
                await self.on_complete(speaker, combined)
        except asyncio.CancelledError:
            pass  # Timer was reset — user is still speaking

    async def flush(self):
        """Force-emit any pending text (e.g., on call end)."""
        if self.timer_task and not self.timer_task.done():
            self.timer_task.cancel()
        if self.pending and self.on_complete:
            combined = " ".join(self.pending)
            speaker = self.speaker
            self.pending.clear()
            await self.on_complete(speaker, combined)


# ──────────────────────────────────────────────────────────────────────────────
# API CLIENT (minimal, inline — no external dependency beyond aiohttp)
# ──────────────────────────────────────────────────────────────────────────────

class APIClient:
    """Minimal AgentCall API client."""

    def __init__(self):
        self.session: Optional[aiohttp.ClientSession] = None
        self.ws: Optional[websockets.WebSocketClientProtocol] = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession(
                headers={"Authorization": f"Bearer {API_KEY}"}
            )
        return self.session

    async def create_call(self, meet_url: str, bot_name: str,
                          webpage_url: str = "", screenshare_url: str = "",
                          ui_port: int = 0, screenshare_port: int = 0,
                          max_duration: int = 0, alone_timeout: int = 0,
                          silence_timeout: int = 0) -> dict:
        params = {
            "meet_url": meet_url,
            "bot_name": bot_name,
            "mode": "webpage-av-screenshare",
            "voice_strategy": "direct",
            "transcription": True,
        }
        if webpage_url:
            params["webpage_url"] = webpage_url
        if screenshare_url:
            params["screenshare_url"] = screenshare_url
        if max_duration > 0:
            params["max_duration"] = max_duration
        if alone_timeout > 0:
            params["alone_timeout"] = alone_timeout
        if silence_timeout > 0:
            params["silence_timeout"] = silence_timeout
        if ui_port:
            params["ui_port"] = ui_port
        if screenshare_port:
            params["screenshare_port"] = screenshare_port

        session = await self._get_session()
        async with session.post(f"{API_BASE}/v1/calls", json=params) as resp:
            if resp.status != 201:
                body = await resp.text()
                raise Exception(f"Create call failed ({resp.status}): {body}")
            return await resp.json()

    async def connect_ws(self, call_id: str):
        ws_url = API_BASE.replace("https://", "wss://").replace("http://", "ws://")
        uri = f"{ws_url}/v1/calls/{call_id}/ws?api_key={API_KEY}"
        self.ws = await websockets.connect(uri)
        return self.ws

    async def check_call_active(self, call_id: str) -> tuple:
        """Check if call is still active via HTTP API. Returns (active, reason)."""
        try:
            session = await self._get_session()
            async with session.get(f"{API_BASE}/v1/calls/{call_id}") as resp:
                if resp.status != 200:
                    return False, "call_not_found"
                data = await resp.json()
                status = data.get("status", "")
                if status in ("ended", "error"):
                    return False, data.get("end_reason", status)
                return True, ""
        except Exception:
            return False, "api_unreachable"

    async def reconnect_ws(self, call_id: str) -> bool:
        """Reconnect WebSocket with exponential backoff. Returns True on success."""
        delays = [1, 5, 10, 30]
        for i, delay in enumerate(delays):
            emit_err(f"WebSocket reconnecting in {delay}s (attempt {i + 1}/{len(delays)})...")
            await asyncio.sleep(delay)
            active, reason = await self.check_call_active(call_id)
            if not active:
                emit_err(f"Call no longer active: {reason}")
                return False
            try:
                await self.connect_ws(call_id)
                emit_err("WebSocket reconnected successfully")
                return True
            except Exception as e:
                emit_err(f"Reconnect attempt {i + 1} failed: {e}")
        return False

    async def send(self, command: dict):
        """Send with automatic retry on transient errors (e.g. WS reconnect window).
        Retries up to 3 times with exponential backoff. Logs drop to stderr if all fail."""
        for attempt in range(3):
            try:
                if self.ws:
                    await self.ws.send(json.dumps(command))
                    return True
            except Exception as e:
                emit_err(f"send failed (attempt {attempt + 1}/3): {e}")
                await asyncio.sleep(0.5 * (attempt + 1))
        emit_err(f"dropped command after 3 failures: {command.get('type', '?')}")
        return False

    async def close(self):
        if self.ws:
            await self.ws.close()
        if self.session and not self.session.closed:
            await self.session.close()


# ──────────────────────────────────────────────────────────────────────────────
# TEMPLATE SERVER
#
# Starts a local HTTP server to serve built-in UI templates.
# The template page is injected with query params (ws, name) so it can
# connect back to AgentCall's WebSocket for voice state + audio events.
# ──────────────────────────────────────────────────────────────────────────────

class TemplateServer:
    """Local HTTP server that serves a UI template with dynamic WS config."""

    def __init__(self, template_dir: str, shared_js_path: str):
        self.template_dir = template_dir
        self.shared_js_path = shared_js_path
        self.ws_url = ""
        self.bot_name = "Agent"

    def set_ws_url(self, url: str):
        self.ws_url = url

    def set_bot_name(self, name: str):
        self.bot_name = name

    async def handle_index(self, request):
        """Serve index.html. The backend appends ?ws= and &name= to the URL
        that FirstCall loads, so the template reads them from window.location.search."""
        from aiohttp import web
        index_path = os.path.join(self.template_dir, "index.html")
        if not os.path.exists(index_path):
            return web.Response(status=404, text="Template not found")
        with open(index_path, "r") as f:
            html = f.read()
        return web.Response(text=html, content_type="text/html")

    async def handle_shared_js(self, request):
        """Serve the shared agentcall-audio.js file."""
        from aiohttp import web
        if os.path.exists(self.shared_js_path):
            with open(self.shared_js_path, "r") as f:
                return web.Response(text=f.read(), content_type="application/javascript")
        return web.Response(status=404)

    async def handle_static(self, request):
        """Serve other static files from the template directory."""
        from aiohttp import web
        filename = request.match_info.get("filename", "")
        filepath = os.path.realpath(os.path.join(self.template_dir, filename))
        # Prevent path traversal — file must be inside template directory
        if not filepath.startswith(os.path.realpath(self.template_dir)):
            return web.Response(status=403, text="Forbidden")
        if os.path.exists(filepath) and os.path.isfile(filepath):
            return web.FileResponse(filepath)
        return web.Response(status=404)


async def start_template_server(template_name: str):
    """Start a local HTTP server for a built-in template. Returns (server, port)."""
    from aiohttp import web

    # Find templates relative to this script: ../../ui-templates/
    script_dir = os.path.dirname(os.path.abspath(__file__))
    templates_base = os.path.join(script_dir, "..", "..", "ui-templates")
    template_dir = os.path.join(templates_base, template_name)
    shared_js = os.path.join(templates_base, "agentcall-audio.js")

    if not os.path.isdir(template_dir):
        emit_err(f"Template '{template_name}' not found at {template_dir}")
        return None, 0

    server = TemplateServer(template_dir, shared_js)
    app = web.Application()
    app.router.add_get("/", server.handle_index)
    # Serve agentcall-audio.js at the path the templates expect (../agentcall-audio.js)
    app.router.add_get("/../agentcall-audio.js", server.handle_shared_js)
    app.router.add_get("/agentcall-audio.js", server.handle_shared_js)
    app.router.add_get("/{filename:.+}", server.handle_static)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    # Use port 0 to get a random available port.
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]

    return server, port


# ──────────────────────────────────────────────────────────────────────────────
# TUNNEL CLIENT
#
# Connects to AgentCall's tunnel server via WebSocket and proxies HTTP requests
# from FirstCall's browser back to the local template/UI server.
# ──────────────────────────────────────────────────────────────────────────────

class BridgeTunnelClient:
    """Inline tunnel client for bridge-visual — proxies HTTP via WS."""

    def __init__(self, tunnel_ws_url: str, tunnel_id: str, access_key: str,
                 ui_port: int, screenshare_port: int = 0):
        self.tunnel_ws_url = tunnel_ws_url
        self.tunnel_id = tunnel_id
        self.access_key = access_key
        self.ui_port = ui_port
        self.screenshare_port = screenshare_port
        self.webpage_port = 0
        self._ws = None
        self._running = False

    async def connect(self):
        """Connect to tunnel server and register."""
        import base64 as b64
        self._running = True
        self._ws = await websockets.connect(self.tunnel_ws_url)
        # Send registration with tunnel_access_key (NOT the API key).
        await self._ws.send(json.dumps({
            "type": "tunnel.register",
            "payload": {
                "tunnel_id": self.tunnel_id,
                "tunnel_access_key": self.access_key,
            },
        }))
        emit_err(f"Tunnel client connected (tunnel_id={self.tunnel_id[:8]}...)")
        asyncio.create_task(self._read_loop())
        asyncio.create_task(self._heartbeat())

    def _resolve_local_url(self, path: str) -> str:
        """Route to correct local port based on path prefix."""
        if path.startswith("/screenshare") and self.screenshare_port:
            local_path = path[len("/screenshare"):] or "/"
            return f"http://localhost:{self.screenshare_port}{local_path}"
        if path.startswith("/webpage") and self.webpage_port:
            local_path = path[len("/webpage"):] or "/"
            return f"http://localhost:{self.webpage_port}{local_path}"
        if path.startswith("/ui"):
            local_path = path[len("/ui"):] or "/"
            return f"http://localhost:{self.ui_port}{local_path}"
        return f"http://localhost:{self.ui_port}{path}"

    async def _read_loop(self):
        try:
            async for message in self._ws:
                msg = json.loads(message)
                msg_type = msg.get("type", "")
                if msg_type == "http.request":
                    asyncio.create_task(self._handle_http(msg))
                elif msg_type == "tunnel.error":
                    error_msg = msg.get("message", "unknown tunnel error")
                    emit_err(f"TUNNEL ERROR: {error_msg}")
                    emit({"event": "error", "message": f"Tunnel: {error_msg}"})
        except websockets.ConnectionClosed:
            if self._running:
                emit_err("Tunnel connection lost")

    async def _handle_http(self, msg: dict):
        payload = msg.get("payload", msg)
        request_id = payload.get("request_id", msg.get("request_id", ""))
        method = payload.get("method", "GET")
        path = payload.get("path", "/")
        headers = payload.get("headers", {})
        body = payload.get("body", "")

        local_url = self._resolve_local_url(path)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.request(method, local_url, headers=headers,
                                           data=body if body else None) as resp:
                    resp_body = await resp.text()
                    resp_headers = {k: v for k, v in resp.headers.items()}
                    response = {
                        "type": "http.response",
                        "request_id": request_id,
                        "payload": {
                            "request_id": request_id,
                            "status": resp.status,
                            "headers": resp_headers,
                            "body": resp_body,
                        },
                    }
                    await self._ws.send(json.dumps(response))
        except Exception as e:
            response = {
                "type": "http.response",
                "request_id": request_id,
                "payload": {
                    "request_id": request_id,
                    "status": 502,
                    "headers": {"Content-Type": "text/plain"},
                    "body": f"Local server error: {e}",
                },
            }
            await self._ws.send(json.dumps(response))

    async def _heartbeat(self):
        while self._running and self._ws and not self._ws.closed:
            try:
                await asyncio.sleep(30)
                if self._ws and not self._ws.closed:
                    await self._ws.ping()
            except Exception:
                break

    async def close(self):
        self._running = False
        if self._ws:
            await self._ws.close()


# ──────────────────────────────────────────────────────────────────────────────
# STDIN READER
#
# Reads commands from the agent framework via stdin.
# Each command is a single-line JSON object.
#
# Supported commands:
#   tts.speak  — speak text in the meeting via TTS
#   send_chat  — send a text message in the meeting chat
#   raise_hand — raise the bot's hand in the meeting
#   leave      — gracefully leave the meeting
# ──────────────────────────────────────────────────────────────────────────────

async def read_stdin(client: APIClient, done_event: asyncio.Event,
                     tunnel_client: BridgeTunnelClient = None, tunnel_base_url: str = "",
                     last_partial_time: list = None, vad_timeout: float = 2.0,
                     screenshare_state: ScreenshareState = None):
    """Read commands from agent framework and forward to AgentCall.
    Includes barge-in prevention: tts.speak waits for silence before sending.

    Uses a daemon thread with blocking sys.stdin.readline() + asyncio.Queue for
    cross-platform compatibility (asyncio.connect_read_pipe is broken on Windows
    per CPython issue #71019). Latency is sub-millisecond on all platforms.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def reader_thread():
        while not done_event.is_set():
            try:
                line = sys.stdin.readline()
            except Exception:
                break
            if not line:
                loop.call_soon_threadsafe(queue.put_nowait, None)
                break
            loop.call_soon_threadsafe(queue.put_nowait, line)

    threading.Thread(target=reader_thread, daemon=True).start()

    try:
        while not done_event.is_set():
            try:
                line = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            if line is None:
                break  # EOF

            try:
                cmd = json.loads(line.strip())
            except json.JSONDecodeError:
                continue

            command = cmd.get("command", "")

            if command == "tts.speak":
                # Barge-in prevention: wait for silence before speaking.
                if last_partial_time and last_partial_time[0] > 0:
                    while time.time() - last_partial_time[0] < vad_timeout:
                        await asyncio.sleep(0.2)
                        if done_event.is_set():
                            break

                await client.send({
                    "type": "tts.speak",
                    "text": cmd.get("text", ""),
                    "voice": cmd.get("voice", "af_heart"),
                    "speed": cmd.get("speed", 1.0),
                })

            elif command == "send_chat":
                # Send a text message in the meeting chat.
                # Useful for: URLs, code snippets, emails, anything hard to speak.
                await client.send({
                    "type": "meeting.send_chat",
                    "message": cmd.get("message", ""),
                })

            elif command == "raise_hand":
                # Raise the bot's hand in the meeting.
                # Useful to signal the agent wants to speak in group meetings.
                await client.send({
                    "type": "meeting.raise_hand",
                })

            elif command == "mic":
                # Mute/unmute/toggle the bot's microphone.
                # Useful when the bot joins muted in a large group meeting.
                # Action: "on" (unmute, default), "off" (mute), "toggle" (flip state).
                action = cmd.get("action", "on")
                await client.send({
                    "type": "meeting.mic",
                    "action": action,
                })

            elif command == "screenshot":
                # Take a screenshot of the meeting view.
                await client.send({
                    "type": "screenshot.take",
                    "request_id": cmd.get("request_id", "screenshot"),
                })

            elif command == "screenshare.start":
                # Start screensharing. Accepts either:
                #   {"command": "screenshare.start", "url": "https://..."}  — public URL
                #   {"command": "screenshare.start", "port": 3001}          — local port via tunnel
                url = cmd.get("url", "")
                port = cmd.get("port", 0)
                if port and tunnel_client and tunnel_base_url:
                    # Pre-flight: confirm something is actually listening locally.
                    # Catches the "white screen" failure mode where the agent forgot
                    # to start its HTTP server, or killed it before sending start.
                    if not _is_port_reachable("127.0.0.1", port):
                        emit({"event": "screenshare.error",
                              "message": f"localhost:{port} is not reachable. Is your local server running?"})
                        continue
                    tunnel_client.screenshare_port = port
                    url = _cache_busted_url(tunnel_base_url + "/screenshare/")
                    emit_err(f"Screenshare tunneling localhost:{port}")
                # External URLs are passed through as-is. Cache-busting is applied
                # only to the local tunnel URL because that URL is byte-identical
                # across swaps (FirstCall's browser would otherwise see "same URL —
                # don't reload" and keep showing the old content). Two different
                # external URLs in a swap are already different, so the browser
                # reloads naturally. Appending ?_acv would also break signed URLs
                # (S3 pre-signed, Vimeo private, Power BI secure embed, etc.).
                if url:
                    if screenshare_state:
                        screenshare_state.mark_starting()
                    await client.send({
                        "type": "screenshare.start",
                        "url": url,
                    })
                else:
                    emit({"event": "screenshare.error", "message": "screenshare.start requires 'url' or 'port'"})

            elif command == "screenshare.stop":
                # Stop screensharing. NOTE: we intentionally do NOT clear
                # tunnel_client.screenshare_port here — FirstCall's browser may have
                # in-flight /screenshare/* fetches, and clearing the port would route
                # them to ui_port (the avatar template), producing garbage on screen.
                # Cleared in the screenshare.stopped event handler instead.
                await client.send({
                    "type": "screenshare.stop",
                })

            elif command == "screenshare.swap":
                # Atomic swap: stop the current screenshare, wait for FirstCall to
                # confirm stop, then start the new one with a cache-busted URL.
                # Eliminates race conditions and cache reuse from naive stop+start.
                new_url = cmd.get("url", "")
                new_port = cmd.get("port", 0)
                if not new_url and not new_port:
                    emit({"event": "screenshare.error",
                          "message": "screenshare.swap requires 'url' or 'port'"})
                    continue
                # Pre-flight check on new local port
                if new_port and tunnel_client and tunnel_base_url:
                    if not _is_port_reachable("127.0.0.1", new_port):
                        emit({"event": "screenshare.error",
                              "message": f"localhost:{new_port} is not reachable. Is your local server running?"})
                        continue
                # Stop current if active, wait for FirstCall to confirm
                if screenshare_state and screenshare_state.active:
                    await client.send({"type": "screenshare.stop"})
                    confirmed = await screenshare_state.wait_stopped(timeout=5.0)
                    if not confirmed:
                        emit_err("screenshare.swap: stop timeout (5s) — proceeding anyway")
                # Build new URL. Cache-bust ONLY the local tunnel URL — external
                # URLs pass through unchanged (signed URLs would break, and a swap
                # to a different external URL already triggers a fresh load).
                if new_port and tunnel_client and tunnel_base_url:
                    tunnel_client.screenshare_port = new_port
                    final_url = _cache_busted_url(tunnel_base_url + "/screenshare/")
                    emit_err(f"Screenshare swapped to localhost:{new_port}")
                else:
                    final_url = new_url
                if screenshare_state:
                    screenshare_state.mark_starting()
                await client.send({
                    "type": "screenshare.start",
                    "url": final_url,
                })

            elif command == "webpage.open":
                # Open a shareable webpage from a local port.
                # Participants open the URL in their own browser (interactive, clickable).
                port = cmd.get("port", 0)
                if port and tunnel_client and tunnel_base_url:
                    tunnel_client.webpage_port = port
                    webpage_url = tunnel_base_url + "/webpage/"
                    emit_err(f"Webpage tunneling localhost:{port}")
                    emit({"event": "webpage.opened", "url": webpage_url})
                else:
                    emit({"event": "webpage.error", "message": "webpage.open requires 'port' and an active tunnel"})

            elif command == "webpage.close":
                # Close the shareable webpage.
                if tunnel_client:
                    tunnel_client.webpage_port = 0
                emit({"event": "webpage.closed"})

            elif command == "set_state":
                # Manually set the avatar's voice state.
                # States: listening, actively_listening, thinking,
                #         waiting_to_speak, speaking, interrupted, contextually_aware
                # This is broadcast to all WS clients (including the avatar template).
                state = cmd.get("state", "listening")
                await client.send({
                    "type": "voice.state_update",
                    "state": state,
                })

            elif command == "leave":
                # Gracefully leave the meeting.
                await client.send({
                    "type": "meeting.leave",
                })
                done_event.set()

    except asyncio.CancelledError:
        pass


# ──────────────────────────────────────────────────────────────────────────────
# EVENT LOOP
#
# Connects to the meeting WebSocket and processes events.
# Events are translated to a simplified protocol for the agent framework.
#
# The agent framework receives clean, simple events:
#   user.message  — user finished speaking (VAD-buffered, complete utterance)
#   chat.received — user sent a chat message
#   participant.joined/left — people entering/leaving
#   tts.done — bot finished speaking (agent can speak again)
#   call.ended — meeting is over
# ──────────────────────────────────────────────────────────────────────────────

async def run_bridge(meet_url: str, bot_name: str, voice: str, vad_timeout: float,
                     webpage_url: str = "", screenshare_url: str = "",
                     template: str = "", ui_port: int = 0,
                     screenshare_port: int = 0,
                     max_duration: int = 0, alone_timeout: int = 0,
                     silence_timeout: int = 0):
    """Main bridge loop."""
    client = APIClient()
    done = asyncio.Event()
    template_server = None

    # ── Start local template server if needed ──
    if template and not webpage_url and not ui_port:
        template_server, ui_port = await start_template_server(template)
        if template_server is None:
            emit({"event": "error", "message": f"Failed to start template server for '{template}'"})
            await client.close()
            return
        emit_err(f"Template '{template}' serving on port {ui_port}")

    # ── Create call ──
    emit_err(f"Creating visual call for: {meet_url}")
    try:
        call = await client.create_call(
            meet_url, bot_name,
            webpage_url=webpage_url,
            ui_port=ui_port,
            screenshare_url=screenshare_url,
            screenshare_port=screenshare_port,
            max_duration=max_duration,
            alone_timeout=alone_timeout,
            silence_timeout=silence_timeout,
        )
    except Exception as e:
        emit({"event": "error", "message": str(e)})
        await client.close()
        return

    call_id = call["call_id"]
    call_token = call.get("call_token", "")
    tunnel_id = call.get("tunnel_id", "")
    tunnel_access_key = call.get("tunnel_access_key", "")
    tunnel_url = call.get("tunnel_url", "")
    emit_err(f"Call created: {call_id}")
    emit({"event": "call.created", "call_id": call_id, "status": call.get("status", "")})

    # Note: the backend appends ?ws= and &name= to the tunnel URL when creating
    # the FirstCall bot. The template page reads these from window.location.search.
    # No client-side injection needed.

    # ── Start tunnel client if using local port (template or --ui-port) ──
    tunnel_client = None
    tunnel_base_url = ""
    if tunnel_id and tunnel_access_key and ui_port:
        tunnel_ws = API_BASE.replace("https://", "wss://").replace("http://", "ws://")
        tunnel_ws_url = f"{tunnel_ws}/internal/tunnel/connect"
        tunnel_client = BridgeTunnelClient(
            tunnel_ws_url, tunnel_id, tunnel_access_key,
            ui_port=ui_port, screenshare_port=screenshare_port,
        )
        try:
            await tunnel_client.connect()
            # Extract base URL for screenshare (tunnel_url is like .../k/{key}/ui/)
            if tunnel_url.endswith("/ui/"):
                tunnel_base_url = tunnel_url[:-4]  # strip /ui/
            elif tunnel_url.endswith("/ui"):
                tunnel_base_url = tunnel_url[:-3]  # strip /ui
            emit_err("Tunnel client connected — waiting for bot to join")
        except Exception as e:
            emit({"event": "error", "message": f"Tunnel connection failed: {e}"})
            await client.close()
            return

    # ── Set up screenshare state (tracks active/stopped for screenshare.swap) ──
    screenshare_state = ScreenshareState()

    # ── Set up VAD buffer ──
    vad = VADBuffer(timeout=vad_timeout)

    async def on_user_complete(speaker: str, text: str):
        """Called when VAD confirms user is done speaking."""
        emit({"event": "user.message", "speaker": speaker, "text": text})

    vad.on_complete = on_user_complete

    # ── Connect WebSocket ──
    try:
        ws = await client.connect_ws(call_id)
    except Exception as e:
        emit({"event": "error", "message": f"WebSocket connection failed: {e}"})
        await client.close()
        return

    emit_err("WebSocket connected")

    # ── Barge-in prevention state ──
    last_partial_time = [0.0]

    # ── Start stdin reader ──
    stdin_task = asyncio.create_task(read_stdin(
        client, done, tunnel_client, tunnel_base_url,
        last_partial_time, vad_timeout, screenshare_state))

    # ── Track state ──
    bot_name_lower = bot_name.lower()
    is_speaking = False
    greeted = False
    participants = set()

    # ── Process events (with reconnection) ──
    while not done.is_set():
        try:
            async for msg in ws:
                if done.is_set():
                    break

                event = json.loads(msg)
                event_type = event.get("event", event.get("type", ""))

                # ── Bot lifecycle ──
                if event_type == "call.bot_joining_meeting":
                    detail = event.get("detail", "")
                    emit({"event": "call.bot_joining_meeting", "call_id": call_id, "detail": detail})
                    emit_err(f"Bot joining meeting ({detail})")

                elif event_type == "call.bot_waiting_room":
                    emit({"event": "call.bot_waiting_room", "call_id": call_id})
                    emit_err("Bot is in the waiting room — waiting to be admitted")

                elif event_type == "call.bot_ready":
                    emit({"event": "call.bot_ready", "call_id": call_id})
                    emit_err("Bot joined the meeting")

                # ── Participant joined ──
                elif event_type == "participant.joined":
                    participant = event.get("participant", {})
                    name = participant.get("name", event.get("name", "Unknown"))
                    participants.add(name)
                    emit({"event": "participant.joined", "name": name})
                    emit_err(f"Participant joined: {name}")

                    if not greeted and name.lower() != bot_name_lower:
                        greeted = True
                        emit({
                            "event": "greeting.prompt",
                            "participant": name,
                            "hint": f"{name} joined. Introduce yourself and greet them via tts.speak. Active participation is the default — do not stay silent.",
                        })

                # ── Participant left ──
                elif event_type == "participant.left":
                    participant = event.get("participant", {})
                    name = participant.get("name", event.get("name", "Unknown"))
                    participants.discard(name)
                    emit({"event": "participant.left", "name": name})

                # ── Transcript final ──
                elif event_type == "transcript.final":
                    speaker_obj = event.get("speaker", {})
                    if isinstance(speaker_obj, dict):
                        speaker = speaker_obj.get("name", "Unknown")
                    else:
                        speaker = str(speaker_obj)
                    text = event.get("text", "").strip()

                    if speaker.lower() == bot_name_lower:
                        continue
                    if not text:
                        continue

                    vad.on_transcript_final(speaker, text)

                # ── Transcript partial ──
                elif event_type == "transcript.partial":
                    speaker_obj = event.get("speaker", {})
                    if isinstance(speaker_obj, dict):
                        speaker = speaker_obj.get("name", "Unknown")
                    else:
                        speaker = str(speaker_obj)

                    if speaker.lower() == bot_name_lower:
                        continue

                    last_partial_time[0] = time.time()
                    vad.on_transcript_partial(speaker, event.get("text", ""))

                # ── Chat message received ──
                elif event_type == "chat.message":
                    sender = event.get("sender", "Unknown")
                    message = event.get("message", "")
                    if sender.lower() != bot_name_lower and message:
                        emit({"event": "chat.received", "sender": sender, "message": message})

                # ── Screenshare events ──
                elif event_type == "screenshare.started":
                    screenshare_state.mark_starting()  # idempotent confirmation
                    emit({"event": "screenshare.started", "url": event.get("url", "")})
                    emit_err("Screenshare started")

                elif event_type == "screenshare.stopped":
                    screenshare_state.mark_stopped()  # unblocks any swap waiters
                    if tunnel_client:
                        # Now safe to clear — no more in-flight /screenshare/* fetches.
                        tunnel_client.screenshare_port = 0
                    emit({"event": "screenshare.stopped"})
                    emit_err("Screenshare stopped")

                elif event_type == "screenshare.error":
                    screenshare_state.mark_stopped()  # unblock waiters from a failed start/stop
                    emit({"event": "screenshare.error", "message": event.get("message", "unknown")})
                    emit_err(f"Screenshare error: {event.get('message', '')}")

                # ── Screenshot result ──
                elif event_type == "screenshot.result":
                    emit({
                        "event": "screenshot.result",
                        "data": event.get("data", ""),
                        "width": event.get("width", 0),
                        "height": event.get("height", 0),
                        "request_id": event.get("request_id", ""),
                    })

                # ── TTS lifecycle ──
                elif event_type == "tts.started":
                    is_speaking = True

                elif event_type == "tts.done":
                    is_speaking = False
                    emit({"event": "tts.done"})

                elif event_type == "tts.error":
                    is_speaking = False
                    emit({"event": "tts.error", "reason": event.get("reason", "unknown")})

                elif event_type == "tts.interrupted":
                    is_speaking = False
                    emit({
                        "event": "tts.interrupted",
                        "reason": event.get("reason", "user_speaking"),
                        "sentence_index": event.get("sentence_index", -1),
                        "elapsed_ms": event.get("elapsed_ms", 0),
                    })

                # ── Warnings ──
                elif event_type == "call.max_duration_warning":
                    emit({"event": "call.max_duration_warning", "minutes_remaining": event.get("minutes_remaining", 5)})
                    emit_err(f"Warning: call will end in {event.get('minutes_remaining', 5)} minutes (max duration)")

                elif event_type == "call.credits_low":
                    emit({"event": "call.credits_low", "balance_microcents": event.get("balance_microcents", 0), "estimated_minutes_remaining": event.get("estimated_minutes_remaining", 0)})
                    emit_err(f"Warning: credits low — estimated {event.get('estimated_minutes_remaining', 0)} minutes remaining")

                # ── Call ended ──
                elif event_type == "call.ended":
                    reason = event.get("reason", "unknown")
                    emit({"event": "call.ended", "reason": reason})
                    emit_err(f"Call ended: {reason}")
                    done.set()
                    break

            if not done.is_set():
                raise websockets.exceptions.ConnectionClosed(None, None)

        except websockets.exceptions.ConnectionClosed:
            if done.is_set():
                break
            emit_err("WebSocket disconnected, checking call status...")
            if await client.reconnect_ws(call_id):
                ws = client.ws
                emit_err("Resuming event stream")
                continue
            else:
                emit({"event": "call.ended", "reason": "connection_lost"})
                emit_err("WebSocket reconnection failed — call ended")
                break
        except Exception as e:
            emit({"event": "error", "message": str(e)})
            emit_err(f"Error: {e}")
            break

    # ── Cleanup ──
    await vad.flush()
    stdin_task.cancel()
    if tunnel_client:
        await tunnel_client.close()
    await client.close()


# ──────────────────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="AgentCall Visual Voice Bridge — avatar + screenshare in meetings",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Like bridge.py but with visual presence + screenshare. The bot joins with
an animated avatar and can screenshare URLs into the meeting.

Protocol (extends bridge.py):
  stdout: {"event": "user.message", ...}, {"event": "screenshare.started", ...}
  stdin:  {"command": "tts.speak", ...}, {"command": "screenshare.start", "url": "..."}

Examples:
  # Avatar template (no local server needed)
  python bridge-visual.py "https://meet.google.com/abc" --name Claude

  # Public webpage as avatar
  python bridge-visual.py "https://meet.google.com/abc" --webpage-url "https://your-site.com/avatar"

  # Local screenshare (agent runs local server on port 3001)
  python bridge-visual.py "https://meet.google.com/abc" --screenshare-port 3001

  # Share a URL during the call
  stdin: {"command": "screenshare.start", "url": "https://slides.google.com/..."}
  stdin: {"command": "screenshare.stop"}
        """,
    )
    parser.add_argument("meet_url", help="Meeting URL (Google Meet, Zoom, or Teams)")
    parser.add_argument("--name", default="Agent", help="Bot name in participant list (default: Agent)")
    parser.add_argument("--voice", default="af_heart", help="TTS voice ID (default: af_heart)")
    parser.add_argument(
        "--vad-timeout", type=float, default=2.0,
        help="Seconds to wait after last transcript.final (default: 2.0)"
    )
    parser.add_argument("--webpage-url", default="", help="Public URL for bot's video feed (avatar page)")
    parser.add_argument("--screenshare-url", default="", help="Public URL for initial screenshare content")
    parser.add_argument("--template", default="ring", help="Built-in UI template (default: ring). Options: ring, orb, avatar, dashboard, blank, voice-agent.")
    parser.add_argument("--ui-port", type=int, default=0, help="Local port for bot's video feed (instead of --template or --webpage-url)")
    parser.add_argument("--screenshare-port", type=int, default=0, help="Local port for screenshare content")
    parser.add_argument("--output", default="",
        help="Also write events to this file (for file-based polling). "
             "Events go to both stdout AND this file."
    )
    parser.add_argument("--max-duration", type=int, default=0,
        help="Max call duration in minutes (default: plan limit). Cannot exceed plan limit."
    )
    parser.add_argument("--alone-timeout", type=int, default=0,
        help="Leave if alone for N seconds (default: 120). Set 0 for plan default."
    )
    parser.add_argument("--silence-timeout", type=int, default=0,
        help="Leave if silent for N seconds (default: 300). Set 0 for plan default."
    )
    args = parser.parse_args()

    global _output_file
    if args.output:
        _output_file = args.output
        emit_err(f"Events also writing to: {_output_file}")

    # If using local port or public URL, don't use template
    template = args.template
    if args.ui_port or args.webpage_url:
        template = ""

    asyncio.run(run_bridge(
        args.meet_url, args.name, args.voice, args.vad_timeout,
        webpage_url=args.webpage_url,
        screenshare_url=args.screenshare_url,
        template=template,
        ui_port=args.ui_port,
        screenshare_port=args.screenshare_port,
        max_duration=args.max_duration * 60000 if args.max_duration > 0 else 0,
        alone_timeout=args.alone_timeout * 1000 if args.alone_timeout > 0 else 0,
        silence_timeout=args.silence_timeout * 1000 if args.silence_timeout > 0 else 0,
    ))


if __name__ == "__main__":
    main()
