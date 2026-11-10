#!/usr/bin/env python3
"""Reserve bots ahead of a meeting for a fast join (Pro / Enterprise).

Zero third-party deps (stdlib only).

A reservation holds up to 4 bots of ONE mode for a fixed 15-minute window,
starting 5 minutes to 7 days ahead. Start a call on it with
`--reservation-id res_...` (bridges / join): the bot skips the machine start.
Unused reserved time is billed at your normal per-minute rate for that mode;
cancelling is free until 5 minutes before the start.

Subcommands (each prints the JSON response to stdout; exit 1 on an error):
  book   --mode audio --count 2 --start +10m   -> book (start: ISO 8601 UTC, or +Nm / +Nh / +Nd)
  list                                         -> your reservations, newest first
  get    <reservation_id>                      -> one reservation (live "ready" count while active)
  cancel <reservation_id>                      -> cancel it

Reads the API key from AGENTCALL_API_KEY or ~/.agentcall/config.json, and the
API URL from AGENTCALL_API_URL, the config, or https://api.agentcall.dev.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

CONFIG_PATH = Path.home() / ".agentcall" / "config.json"
DEFAULT_API_URL = "https://api.agentcall.dev"
MODES = ["audio", "webpage-audio", "webpage-av", "webpage-av-screenshare"]

# Short explanations for the errors the reservations API returns.
HINTS = {
    400: "invalid field (mode, count 1-4, start 5 minutes to 7 days ahead)",
    402: "not enough credits to cover every reserved bot for the full 15 minutes",
    403: "reservations need a Pro or Enterprise plan",
    409: "no reservable capacity at that time; try another time or fewer bots",
    429: "reservation limit reached (max 4 overlapping, max 100 not yet ended)",
    503: "reservations are temporarily unavailable; start the call without one",
}


def _config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def api_url() -> str:
    """Resolve the API base URL: env var, then config, then the public default."""
    return os.environ.get("AGENTCALL_API_URL") or _config().get("api_url") or DEFAULT_API_URL


def api_key() -> str:
    """Resolve the API key: env var, then config."""
    return os.environ.get("AGENTCALL_API_KEY") or _config().get("api_key") or ""


def parse_start(value: str, now: datetime = None) -> str:
    """Return start_at as ISO 8601 UTC. "+10m" / "+2h" / "+1d" are relative to
    now; anything else is passed through as an ISO 8601 time."""
    value = value.strip()
    m = re.fullmatch(r"\+(\d+)([mhd])", value)
    if not m:
        if value.startswith("+"):
            raise ValueError(f"bad relative start {value!r}: use +Nm, +Nh or +Nd")
        return value
    n, unit = int(m.group(1)), m.group(2)
    delta = {"m": timedelta(minutes=n), "h": timedelta(hours=n), "d": timedelta(days=n)}[unit]
    t = (now or datetime.now(timezone.utc)) + delta
    return t.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def request(method: str, path: str, body: dict = None):
    """Send a request, return (status_code, parsed_body). status 0 = network error."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{api_url()}{path}", data=data, method=method)
    req.add_header("Authorization", f"Bearer {api_key()}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or "null")
    except urllib.error.HTTPError as e:
        raw = e.read() or b""
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw.decode(errors="replace").strip()}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"error": str(e)}


def finish(status: int, body):
    if 200 <= status < 300:
        print(json.dumps(body), flush=True)
        sys.exit(0)
    message = body.get("error", "") if isinstance(body, dict) else str(body)
    out = {"event": "error", "status": status, "message": message or HINTS.get(status, "request failed")}
    if status in HINTS:
        out["hint"] = HINTS[status]
    print(json.dumps(out), flush=True)
    sys.exit(1)


def main():
    p = argparse.ArgumentParser(
        description="Reserve AgentCall bots for a fast join (Pro / Enterprise). "
                    "Window: 15 minutes, max 4 bots of one mode, 5 minutes to 7 days ahead.")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("book", help="book a reservation")
    b.add_argument("--mode", default="audio", choices=MODES,
                   help="mode of the calls that will use it (default: audio; bridge-visual uses webpage-av-screenshare)")
    b.add_argument("--count", type=int, default=1, help="number of bots, 1-4 (default: 1); each is single-use")
    b.add_argument("--start", required=True,
                   help="window start: ISO 8601 UTC (2026-11-10T15:00:00Z) or relative +10m / +2h / +1d")

    sub.add_parser("list", help="list your reservations (newest first)")
    g = sub.add_parser("get", help="show one reservation")
    g.add_argument("reservation_id")
    c = sub.add_parser("cancel", help="cancel a reservation (free until 5 minutes before the start)")
    c.add_argument("reservation_id")

    args = p.parse_args()
    if not api_key():
        finish(0, {"error": "API key not found. Set AGENTCALL_API_KEY or save it to ~/.agentcall/config.json"})

    if args.cmd == "book":
        try:
            start_at = parse_start(args.start)
        except ValueError as e:
            p.error(str(e))
        finish(*request("POST", "/v1/reservations",
                        {"mode": args.mode, "count": args.count, "start_at": start_at}))
    elif args.cmd == "list":
        finish(*request("GET", "/v1/reservations"))
    else:
        rid = urllib.parse.quote(args.reservation_id.strip(), safe="")
        finish(*request("GET" if args.cmd == "get" else "DELETE", f"/v1/reservations/{rid}"))


if __name__ == "__main__":
    main()
