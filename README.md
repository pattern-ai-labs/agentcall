# join-meeting

**Let any AI agent join and participate in video meetings via voice.**

An [AgentCall](https://agentcall.dev) skill that enables AI coding agents (Claude Code, Cursor, Codex, Gemini CLI, OpenClaw, Windsurf, Junie, and 30+ more) to join Google Meet, Zoom, and Microsoft Teams as a bot with voice conversation, visual avatar, screenshare, and real-time transcription.

## What It Does

Your AI agent joins a meeting as a participant and can:

- **Talk** — respond via text-to-speech (54 voices, 9 languages, <1s latency)
- **Listen** — receive real-time transcripts of what participants say
- **See** — take screenshots of shared screens, slides, presentations
- **Show** — display an animated avatar as the bot's camera feed
- **Present** — screenshare URLs, dashboards, slides dynamically during the call
- **Chat** — send and receive meeting chat messages
- **Collaborate** — use GetSun voice intelligence for natural multi-party conversations

The agent keeps its full session context — it can search code, edit files, run commands, and commit changes while talking in the meeting. The meeting is just another I/O channel.

## Quick Start

### Install

```bash
# Claude Code
/plugin marketplace add REPO_URL
/plugin install join-meeting

# Or manually — copy this directory into your project
```

### Prerequisites

- Python 3.10+ or Node.js 18+
- `pip install aiohttp websockets` (Python) or `npm install ws` (Node.js)
- AgentCall API key ([get one free](https://app.agentcall.dev/api-keys))

### Join a Meeting

Tell your agent: *"Join this meeting: https://meet.google.com/abc-def-ghi"*

Or run directly:

```bash
# Python (voice only)
python scripts/python/bridge.py "https://meet.google.com/abc" --name "Juno"

# Python (avatar + screenshare)
python scripts/python/bridge-visual.py "https://meet.google.com/abc" --name "Juno"

# Node.js (voice only)
node scripts/node/bridge.js "https://meet.google.com/abc" --name "Juno"

# Node.js (avatar + screenshare)
node scripts/node/bridge-visual.js "https://meet.google.com/abc" --name "Juno"
```

## Modes

| Mode | What the bot has | Use case |
|------|-----------------|----------|
| `audio` | Voice only | Simplest — voice conversations, note-taking |
| `webpage-av` | Voice + animated avatar | Visual presence in meetings |
| `webpage-av-screenshare` | Voice + avatar + screenshare | Presentations, sharing content |

## Voice Strategies

| Strategy | How it works | Best for |
|----------|-------------|----------|
| `direct` | Agent controls TTS directly | 1-on-1 conversations, customer support |
| `collaborative` | GetSun voice intelligence handles timing | Group meetings, natural conversation flow |

## Features

- **VAD gap buffering** — combines fragmented transcripts into complete utterances
- **Barge-in prevention** — waits for silence before speaking
- **Auto-interruption** — detects when someone talks over the bot (webpage modes)
- **Sentence tracking** — knows which sentence was interrupted and when
- **WebSocket reconnection** — auto-reconnects on network blips with call status check
- **Crash recovery** — reconnects to active calls after agent restart
- **5 built-in templates** — orb, avatar, dashboard, blank, voice-agent
- **Screenshots** — capture what's on screen at any time
- **Chat I/O** — send URLs, code, text that's hard to speak
- **API key persistence** — saved to `~/.agentcall/config.json`, asked once

## Agent Frameworks

Works with any agent that can spawn a subprocess and read stdout:

| Framework | Status |
|-----------|--------|
| Claude Code / Agent SDK | Full support (+ Stop Hook for persistent calls) |
| OpenAI Codex | Full support |
| Cursor | Full support (tmux for PTY) |
| Windsurf (Cascade) | Full support |
| Gemini CLI | Full support |
| JetBrains Junie | Full support |
| OpenClaw | Full support |
| GitHub Copilot | Full support |
| Aider | Partial (no subprocess) |

## Documentation

- **[SKILL.md](SKILL.md)** — Complete reference (modes, events, commands, patterns, Claude Code integration)
- **[examples/](examples/)** — 7 working examples (notetakers, support agent, meeting assistants, coding companion)
- **[references/](references/)** — API reference + guides (collaborative mode, interruption handling, crash recovery, screenshare)

## Pricing

Base plan: 6 hours of meeting time, 1 concurrent call. All features included.
Paid: per-minute billing. See [agentcall.dev](https://agentcall.dev) for details.

## License

MIT — use, modify, redistribute freely.

---

Built by [AgentCall](https://agentcall.dev) (Pattern AI Labs)
