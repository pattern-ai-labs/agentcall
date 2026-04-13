/**
 * AgentCall Audio Player — Drop-in audio queue for webpage modes.
 *
 * In webpage modes (webpage-audio, webpage-av, webpage-av-screenshare),
 * audio from GetSun (collaborative voice intelligence) or AgentCall TTS arrives as base64-encoded 24kHz PCM
 * chunks via WebSocket events. This player:
 *
 * 1. Decodes base64 PCM → AudioBuffer
 * 2. Queues chunks for gapless sequential playback
 * 3. On `tts.audio_clear` → stops playback + flushes queue immediately
 * 4. On `transcript.partial` during playback → interruption detected,
 *    clears audio and fires onInterrupted callback with sentence info
 *
 * INTERRUPTION DETECTION (direct mode, webpage modes 2-4):
 * FirstCall does NOT transcribe bot audio — transcript.partial always
 * comes from a human participant. If transcript.partial arrives while
 * audio is playing, a human is talking over the bot → interrupt.
 * The player clears audio immediately and reports which sentence was
 * interrupted and how far it got (elapsed_ms).
 *
 * SENTENCE TRACKING:
 * Each tts.webpage_audio event can include sentence_index, sentence_text,
 * and duration_ms. The player tracks which sentence is currently playing
 * and how much time has elapsed, so interruption reports are precise.
 *
 * USAGE:
 *   const player = new AgentCallAudio({
 *     onInterrupted: (info) => {
 *       // info: { sentence_index, sentence_text, elapsed_ms, reason }
 *       ws.send(JSON.stringify({ type: 'tts.interrupted', ...info }));
 *     }
 *   });
 *   ws.onmessage = (e) => player.handleEvent(JSON.parse(e.data));
 */

class AgentCallAudio {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 24000;
    this.ctx = null;
    this.queue = [];
    this.nextTime = 0;
    this.playing = false;
    this.onStateChange = options.onStateChange || null;
    this.onInterrupted = options.onInterrupted || null;

    // Sentence tracking
    this.sentences = [];       // [{index, text, duration_ms, startTime}]
    this.currentSentence = -1;
    this.playbackStartTime = 0;
  }

  /**
   * Handle a WebSocket event. Call this for every message.
   * Handles tts.webpage_audio, tts.audio_clear, and transcript.partial (interruption).
   */
  handleEvent(msg) {
    const eventType = msg.event || msg.type;

    if (eventType === 'tts.webpage_audio' && msg.data) {
      this.playChunk(msg.data, {
        sentenceIndex: msg.sentence_index,
        sentenceText: msg.sentence_text,
        durationMs: msg.duration_ms,
      });
    }

    if (eventType === 'tts.audio_clear') {
      this.clear();
    }

    // Interruption detection: transcript.partial during playback = human speaking
    if (eventType === 'transcript.partial' && this.playing) {
      this._handleInterruption('user_speaking');
    }
  }

  /**
   * Decode and queue a base64 PCM audio chunk for playback.
   * Optionally tracks sentence metadata for interruption reporting.
   */
  playChunk(base64Data, metadata = {}) {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: this.sampleRate
      });
    }

    // Decode base64 → PCM bytes → Float32 samples.
    const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const samples = new Float32Array(bytes.length / 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768.0;
    }

    // Create AudioBuffer.
    const buffer = this.ctx.createBuffer(1, samples.length, this.sampleRate);
    buffer.getChannelData(0).set(samples);

    // Create source node.
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    // Schedule: play immediately if queue is empty, or right after the last chunk.
    const now = this.ctx.currentTime;
    if (this.nextTime < now) {
      this.nextTime = now;
    }

    // Track sentence metadata
    if (metadata.sentenceIndex !== undefined) {
      this.sentences.push({
        index: metadata.sentenceIndex,
        text: metadata.sentenceText || '',
        duration_ms: metadata.durationMs || 0,
        startTime: this.nextTime,
      });
      this.currentSentence = metadata.sentenceIndex;
    }

    source.start(this.nextTime);
    this.nextTime += buffer.duration;

    // Track for clearing.
    this.queue.push(source);
    source.onended = () => {
      const idx = this.queue.indexOf(source);
      if (idx !== -1) this.queue.splice(idx, 1);
      if (this.queue.length === 0) {
        this.playing = false;
        this.sentences = [];
        this.currentSentence = -1;
        if (this.onStateChange) this.onStateChange(false);
      }
    };

    if (!this.playing) {
      this.playing = true;
      this.playbackStartTime = now;
      if (this.onStateChange) this.onStateChange(true);
    }
  }

  /**
   * Handle interruption: clear audio and report what was interrupted.
   */
  _handleInterruption(reason) {
    if (!this.playing) return;

    // Figure out which sentence was playing and how far we got
    let sentenceIndex = this.currentSentence;
    let sentenceText = '';
    let elapsedMs = 0;

    if (this.ctx && this.sentences.length > 0) {
      const now = this.ctx.currentTime;
      // Find which sentence is currently playing based on scheduled times
      for (let i = this.sentences.length - 1; i >= 0; i--) {
        if (now >= this.sentences[i].startTime) {
          sentenceIndex = this.sentences[i].index;
          sentenceText = this.sentences[i].text;
          elapsedMs = Math.round((now - this.sentences[i].startTime) * 1000);
          break;
        }
      }
    }

    this.clear();

    if (this.onInterrupted) {
      this.onInterrupted({
        sentence_index: sentenceIndex,
        sentence_text: sentenceText,
        elapsed_ms: elapsedMs,
        reason: reason,
      });
    }
  }

  /**
   * Stop all playback immediately and flush the queue.
   * Called when the bot is interrupted (tts.audio_clear event).
   */
  clear() {
    for (const source of this.queue) {
      try { source.stop(); } catch (e) { /* already stopped */ }
    }
    this.queue = [];
    this.nextTime = 0;
    this.playing = false;
    this.sentences = [];
    this.currentSentence = -1;
    if (this.onStateChange) this.onStateChange(false);
  }

  /**
   * Returns true if audio is currently playing.
   */
  isPlaying() {
    return this.playing;
  }
}

// Export for module usage.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AgentCallAudio;
}
