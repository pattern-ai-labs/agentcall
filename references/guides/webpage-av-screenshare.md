# webpage-av-screenshare Mode — Complete Guide

Two visual presences in the meeting: camera + screenshare.

- **Avatar page** = bot's camera feed (identity, brand, animated avatar)
- **Screenshare page** = shared content (slides, charts, demos, docs)
- Agent orchestrates both via WebSocket

## Audio Routing

```
Meeting participants speak
    -> FirstCall (meeting infrastructure) captures
    -> Routes to avatar page as mic input
    -> Avatar page can process (voice agent AI)
    -> Avatar page plays response -> meeting hears it

Screenshare page
    -> NO mic input (doesn't receive meeting audio)
    -> BUT audio output IS captured (e.g., video with sound)
    -> Meeting hears any audio the screenshare page plays
```

Summary:
- Meeting audio goes to the **avatar page only** (not screenshare)
- Audio output from **both pages** is captured into the meeting
- The screenshare page is for visual content — it cannot listen

## Setup Examples

```bash
# Both local (tunneled)
./scripts/run.sh https://meet.google.com/abc \
  --mode webpage-av-screenshare \
  --port 3000 \
  --screenshare-port 3001

# Avatar public, screenshare local
./scripts/run.sh https://meet.google.com/abc \
  --mode webpage-av-screenshare \
  --webpage-url https://brand.com/avatar \
  --screenshare-port 3001

# Both public (no tunnels)
./scripts/run.sh https://meet.google.com/abc \
  --mode webpage-av-screenshare \
  --webpage-url https://brand.com/avatar \
  --screenshare-url https://slides.com/deck
```

## Controlling Screenshare

```python
# Start sharing
await client.send_command({"type": "screenshare.start"})

# Stop sharing
await client.send_command({"type": "screenshare.stop"})

# To change content: send custom event to update the page
await client.send_command({
    "type": "custom.next_slide",
    "slide": 3
})
# The screenshare page handles this event and updates its DOM
```

## Use Cases

1. **Presenter Bot** — avatar as camera, slides as screenshare. Agent narrates slides with TTS, controls slide transitions via custom WS events.

2. **Support Bot with Docs** — avatar handles voice conversation, screenshare shows relevant documentation or troubleshooting steps based on what's being discussed.

3. **Demo Bot** — branded avatar as camera, live product demo as screenshare. Agent walks through the demo, responding to questions.

4. **Training Bot** — avatar as instructor presence, screenshare shows training materials, diagrams, or interactive exercises.

## Building the Screenshare Page

The screenshare page is a regular webpage that:
- Renders content (slides, charts, docs)
- Connects to the agent's WS for control events
- Updates DOM based on events received
- Does NOT receive mic input
- Any audio it plays IS captured into the meeting

```html
<!-- screenshare.html -->
<div id="slide-content"></div>
<script>
const params = new URLSearchParams(window.location.search);
const wsURL = params.get('ws');

const slides = [
  '<h1>Q3 Revenue Report</h1>',
  '<h1>Revenue: $2.4M</h1><p>Up 15% YoY</p>',
  '<h1>Enterprise: $1.6M</h1><p>67% of total</p>',
  '<h1>Questions?</h1>'
];
let current = 0;

function renderSlide(idx) {
  document.getElementById('slide-content').innerHTML = slides[idx];
}
renderSlide(0);

if (wsURL) {
  const ws = new WebSocket(wsURL);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'custom.next_slide') {
      current = Math.min(current + 1, slides.length - 1);
      renderSlide(current);
    }
    if (msg.type === 'custom.prev_slide') {
      current = Math.max(current - 1, 0);
      renderSlide(current);
    }
    if (msg.type === 'custom.goto_slide' && msg.slide !== undefined) {
      current = msg.slide;
      renderSlide(current);
    }
  };
}
</script>
```

## Agent-Side Orchestration (bridge-visual.py)

The agent controls the full screenshare lifecycle via bridge-visual.py commands:

### Starting screenshare

```json
// Share a public URL
{"command": "screenshare.start", "url": "https://your-slides.com/deck"}

// Share local content via tunnel (auto-tunneled)
{"command": "screenshare.start", "port": 3001}
```

The bridge handles tunneling automatically for local ports. The page loads in
FirstCall's browser and connects to the WebSocket via the `?ws=` parameter
(appended automatically by the backend).

### Controlling the page

Send custom commands via the agent's WebSocket — the screenshare page receives them:

```json
// Agent sends via WS (through bridge-visual.py)
{"type": "custom.next_slide"}
{"type": "custom.prev_slide"}
{"type": "custom.goto_slide", "slide": 3}
{"type": "custom.show_chart", "chart": "revenue_q3"}
{"type": "custom.update_text", "text": "Updated metrics: $2.4M revenue"}
```

The page's WS listener handles these and updates its DOM. Meeting participants
see the changes in real-time.

### Stopping screenshare

```json
{"command": "screenshare.stop"}
```

To switch to a different page entirely: stop, then start with a new URL.

### Full example — presenter bot flow

```
Agent: tts.speak "Good morning everyone. Let me walk you through Q3 results."
Agent: screenshare.start {"url": "https://company.com/q3-slides"}
  → event: screenshare.started

Agent: tts.speak "Starting with revenue. As you can see, we hit 2.4 million."
Agent: WS → {"type": "custom.next_slide"}

Agent: tts.speak "Enterprise was the main driver at 1.6 million."
Agent: WS → {"type": "custom.next_slide"}

User: "Can you go back to the revenue slide?"
Agent: tts.speak "Sure."
Agent: WS → {"type": "custom.goto_slide", "slide": 1}

User: "Thanks, we're good."
Agent: tts.speak "Ending the presentation."
Agent: screenshare.stop
  → event: screenshare.stopped
  → Participants see only the avatar now
```

### Local screenshare with tunnel

For agent-generated content (dynamically created HTML, charts, code):

```bash
# Agent starts a local HTTP server
python -m http.server 3001 --directory /tmp/my-slides/

# Then via bridge-visual.py stdin:
{"command": "screenshare.start", "port": 3001}
```

The bridge automatically creates a tunnel from `localhost:3001` through AgentCall's
tunnel server. FirstCall loads the page via the tunnel URL. The agent can update
files on disk and the page can refresh via WS commands.

## Important Notes

- **Screenshare is inactive at start** — the bot joins with avatar only. Send `screenshare.start` when ready.
- If you don't need screenshare, use `webpage-av` mode instead of `webpage-av-screenshare`.
- Both pages are loaded once — no auto-refresh. Updates must come via WebSocket commands.
- Agent controls both pages via WebSocket.
- To swap to a completely different page: `screenshare.stop` then `screenshare.start` with new URL.
- Keep screenshare pages lightweight for performance.
- The screenshare page runs in a headless browser — no clicks, scrolling, or typing possible.
- Test locally: what you see in your browser = what participants see.

## See Also

- [webpage-av.md](webpage-av.md) — single-page AV mode (no screenshare)
- [webpage-audio.md](webpage-audio.md) — audio-only webpage mode
- [interruption-handling.md](interruption-handling.md) — how interruptions work with voice state
