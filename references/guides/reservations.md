# Reservations (fast join)

A bot normally joins a meeting in under a minute. During busy times it can need a minute or two
longer while a new machine starts. If the bot must be there on time, reserve it ahead: a reserved
bot skips that wait — its machine is already running.

**Pro and Enterprise plans only.** API reference: [api.md → Reservations](../api.md#reservations).

## What a reservation is

- Up to **4 bots** of **one mode** (`audio`, `webpage-audio`, `webpage-av` or
  `webpage-av-screenshare`).
- A fixed **15-minute window**, starting **5 minutes to 7 days** from now.
- Usable from 5 minutes before the start until the end of the window.
- Each reserved bot is **single-use**: a bot leaving doesn't give it back. To run 3 bots one after
  another, reserve 3.
- A bot that took a reserved slot keeps running normally after the window ends (normal call billing).
- Bots beyond the count, or started without the reservation id, start the normal way.

## Book, check, cancel

```bash
# Book 1 audio bot for a window starting in 10 minutes (or an ISO 8601 UTC time)
python scripts/python/reserve.py book --mode audio --count 1 --start +10m
python scripts/python/reserve.py book --mode webpage-av-screenshare --count 2 --start 2026-11-10T15:00:00Z

python scripts/python/reserve.py list            # your reservations, newest first
python scripts/python/reserve.py get res_abc123  # one reservation; "ready" = reserved bots ready now
python scripts/python/reserve.py cancel res_abc123
```

Node: `node scripts/node/reserve.js book|list|get|cancel ...` with the same arguments. Both
scripts use only the standard library, read the API key from `AGENTCALL_API_KEY` or
`~/.agentcall/config.json`, print the JSON response, and exit 1 on an error with
`{"event": "error", "status": ..., "message": ..., "hint": ...}`.

`--start` takes an ISO 8601 UTC time or a relative `+Nm` / `+Nh` / `+Nd` (e.g. `+10m`, `+2h`).
Save the returned `reservation_id` (`res_...`).

| Error | Meaning |
|---|---|
| 400 | Invalid field (mode, count 1–4, start not 5 minutes – 7 days ahead) |
| 402 | Credits don't cover every reserved bot unused for the full 15 minutes |
| 403 | Plan is not Pro or Enterprise |
| 409 | No reservable capacity at that time — try another time or fewer bots |
| 429 | Limit reached: max 4 reservations overlapping in time, max 100 not yet ended |
| 503 | Reservations temporarily unavailable — start the call without one |

You can also see and cancel reservations in the dashboard: app.agentcall.dev → Reservations.

## Use it

Pass the id when starting the bot. The call's mode must match the reservation's mode
(`bridge.py` / `bridge.js` = `audio`, `bridge-visual.py` / `bridge-visual.js` =
`webpage-av-screenshare`, `run.sh` / `join` = its `--mode`):

```bash
python scripts/python/bridge.py "https://meet.google.com/abc-defg-hij" --name "Juno" --reservation-id res_abc123
```

A wrong id (not yours) or a different mode is rejected with 400. Otherwise the bot **always
starts**, and the bridge prints:

```json
{"event": "call.reservation", "call_id": "call-...", "reservation_id": "res_abc123", "result": "claimed"}
```

| `result` | Meaning |
|---|---|
| `claimed` | A reserved bot was used — fast start |
| `not_ready` | More than 5 minutes before the start — normal start |
| `exhausted` | All reserved bots of this reservation already used — normal start |
| `expired` | Window over or reservation cancelled — normal start |
| `unavailable` | Reserved bot not available — normal start |

Anything other than `claimed` is not an error: the bot is on its way, it just takes the normal
start time.

## Billing

- Calls are billed per minute as always.
- Plus unused reserved time, at your normal per-minute rate for that mode:
  - reserved bot used before the start → nothing extra
  - used later → from the start until it was used (rounded up to whole minutes)
  - never used → the full 15 minutes
- Charged after the window ends (`charged_microcents` on the reservation; 1,000,000 = $1).
- Cancelling is free until 5 minutes before the start; after that the unused reserved time is
  charged as if held to the end.
