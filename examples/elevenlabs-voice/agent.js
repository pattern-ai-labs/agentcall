#!/usr/bin/env node
/**
 * AgentCall — Bring Your Own Voice (ElevenLabs)
 *
 * Joins a meeting in audio mode and speaks with an ElevenLabs voice instead of
 * AgentCall's built-in TTS. Your agent generates the audio with your own
 * ElevenLabs API key and sends it into the call with `audio.inject`.
 *
 *     transcript.final → your reply → ElevenLabs (PCM 16 kHz) → paced audio.inject → meeting
 *
 * Barge-in: when someone starts talking while the bot speaks, playback stops
 * and `audio.clear` flushes what the meeting still has queued.
 *
 * Usage:
 *     export AGENTCALL_API_KEY="ak_ac_your_key"
 *     export ELEVENLABS_API_KEY="your_elevenlabs_key"
 *     node agent.js "https://meet.google.com/abc-def-ghi"
 *
 *     # Custom bot name and ElevenLabs voice
 *     node agent.js "https://meet.google.com/abc" --name "Ava" --voice-id 21m00Tcm4TlvDq8ikWAM
 *
 * Dependencies (Node.js 18+):
 *     npm install ws
 *
 * Notes:
 *   - `audio.inject` works in audio mode only (mode: "audio").
 *   - Audio format: raw PCM, signed 16-bit little-endian, 16 kHz, mono, base64.
 *     ElevenLabs returns exactly this with output_format=pcm_16000.
 *   - Pace the audio (about real time). Sending a whole reply in one burst can
 *     exceed the meeting bot's command rate limit and cut the audio off.
 *   - Your own audio is not billed as AgentCall TTS.
 *
 * NOTE: decideReply() is a placeholder — plug in your LLM there.
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

// ── Configuration ────────────────────────────────────────────────────────────

let _cfg = {};
const _cfgPath = path.join(require("os").homedir(), ".agentcall", "config.json");
if (fs.existsSync(_cfgPath)) {
  try { _cfg = JSON.parse(fs.readFileSync(_cfgPath, "utf-8")); } catch {}
}

const API_BASE = process.env.AGENTCALL_API_URL || _cfg.api_url || "https://api.agentcall.dev";
const API_KEY = process.env.AGENTCALL_API_KEY || _cfg.api_key || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";

if (!API_KEY) {
  console.error("Error: set AGENTCALL_API_KEY or save it to ~/.agentcall/config.json");
  process.exit(1);
}
if (!ELEVENLABS_API_KEY) {
  console.error("Error: set ELEVENLABS_API_KEY");
  process.exit(1);
}

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;     // 16-bit mono
const FRAME_BYTES = BYTES_PER_SECOND / 5;     // 200 ms per audio.inject message
const LEAD_SECONDS = 0.4;                     // stay at most this far ahead of real time

// CLI args
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const meetUrl = args.find((a) => a.startsWith("http"));
const botName = flag("--name", "Ava");
const voiceId = flag("--voice-id", "21m00Tcm4TlvDq8ikWAM");
const modelId = flag("--model", "eleven_flash_v2_5"); // flash = lowest latency

if (!meetUrl) {
  console.error("Usage: node agent.js <meeting-url> [--name Ava] [--voice-id ID] [--model eleven_flash_v2_5]");
  process.exit(1);
}

// ── Your agent logic ─────────────────────────────────────────────────────────

function decideReply(speaker, text) {
  // Placeholder: replace with your LLM call. Return "" to stay silent.
  return `${speaker}, you said: ${text}`;
}

// ── ElevenLabs → audio.inject ────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Voice {
  /** Speaks queued replies through ElevenLabs, paced, with barge-in. */
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.current = null; // { abort: AbortController } while speaking
    this.working = false;
  }

  get speaking() {
    return this.current !== null;
  }

  say(text) {
    this.queue.push(text);
    if (!this.working) this._work();
  }

  interrupt() {
    // Barge-in: drop queued replies, stop sending, flush the meeting's buffer.
    this.queue.length = 0;
    if (this.current) {
      this.current.abort.abort();
      this.ws.send(JSON.stringify({ type: "audio.clear" }));
      console.log("  (interrupted)");
    }
  }

  async _work() {
    this.working = true;
    while (this.queue.length) {
      const text = this.queue.shift();
      this.current = { abort: new AbortController() };
      try {
        await this._speak(text, this.current.abort.signal);
      } catch (e) {
        if (e.name !== "AbortError") console.error(`  speak failed: ${e.message}`);
      } finally {
        this.current = null;
      }
    }
    this.working = false;
  }

  async _speak(text, signal) {
    console.log(`  [bot] ${text}`);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_${SAMPLE_RATE}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: modelId }),
      signal,
    });
    if (!resp.ok) {
      console.error(`  ElevenLabs error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      return;
    }

    let buf = Buffer.alloc(0);
    let sentSeconds = 0;
    const start = Date.now();
    // First audio starts before the reply is fully generated.
    for await (const chunk of resp.body) {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      while (buf.length >= FRAME_BYTES) {
        const frame = buf.subarray(0, FRAME_BYTES);
        buf = buf.subarray(FRAME_BYTES);
        sentSeconds = await this._sendPaced(frame, sentSeconds, start, signal);
      }
    }
    if (buf.length) {
      if (buf.length % 2) buf = buf.subarray(0, buf.length - 1); // keep whole 16-bit samples
      await this._sendPaced(buf, sentSeconds, start, signal);
    }
  }

  async _sendPaced(frame, sentSeconds, start, signal) {
    // Send one frame, never getting more than LEAD_SECONDS ahead of real time.
    const ahead = sentSeconds - (Date.now() - start) / 1000;
    if (ahead > LEAD_SECONDS) await sleep((ahead - LEAD_SECONDS) * 1000);
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    this.ws.send(JSON.stringify({ type: "audio.inject", data: frame.toString("base64") }));
    return sentSeconds + frame.length / BYTES_PER_SECOND;
  }
}

// ── Call lifecycle ───────────────────────────────────────────────────────────

async function main() {
  const headers = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
  const resp = await fetch(`${API_BASE}/v1/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      meet_url: meetUrl,
      bot_name: botName,
      mode: "audio", // audio.inject works in audio mode only
      voice_strategy: "direct",
      transcription: true,
    }),
  });
  if (!resp.ok) {
    console.error(`Create call failed (${resp.status}): ${await resp.text()}`);
    process.exit(1);
  }
  const call = await resp.json();
  console.log(`Call created: ${call.call_id} — admit '${botName}' if the meeting has a waiting room.`);

  const endCall = () => fetch(`${API_BASE}/v1/calls/${call.call_id}`, { method: "DELETE", headers }).catch(() => {});
  process.on("SIGINT", async () => {
    console.log("\nStopped.");
    await endCall();
    process.exit(0);
  });

  const ws = new WebSocket(`${call.ws_url}?api_key=${API_KEY}`);
  const voice = new Voice(ws);

  ws.on("message", (data) => {
    const event = JSON.parse(data.toString());
    const kind = event.event || event.type;

    if (kind === "call.bot_ready") {
      console.log("Bot is in the meeting.");
      voice.say(`Hi, I'm ${botName}. I'm speaking with an ElevenLabs voice.`);
    } else if (kind === "transcript.partial") {
      // Barge-in on real speech, not a one-word "mm-hm".
      if (voice.speaking && (event.text || "").trim().split(/\s+/).length >= 2) voice.interrupt();
    } else if (kind === "transcript.final") {
      const speaker = (event.speaker && event.speaker.name) || "Someone";
      const text = (event.text || "").trim();
      if (!text) return;
      console.log(`  [${speaker}] ${text}`);
      const reply = decideReply(speaker, text);
      if (reply) voice.say(reply);
    } else if (kind === "command.error") {
      console.error(`  command.error: ${event.command} — ${event.message}`);
    } else if (kind === "call.ended") {
      console.log(`Call ended: ${event.reason || "unknown"}`);
      ws.close();
    }
  });

  ws.on("error", (e) => console.error(`WebSocket error: ${e.message}`));

  ws.on("close", async () => {
    await endCall();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
