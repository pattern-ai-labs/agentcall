#!/usr/bin/env python3
"""Self-service registration — get an AgentCall API key via email OTP.

Zero third-party deps (stdlib only) so it runs before `pip install`.

Subcommands (each prints one JSON line to stdout):
  send   --email E             -> emails a 6-digit code to E
  verify --email E --code C     -> verifies the code, mints an API key, and
                                   saves it to ~/.agentcall/config.json

Agent flow: run `send`, obtain the 6-digit code (read the mailbox yourself if
you have email access, otherwise ask the user to paste it), then run `verify`.
New accounts are created automatically on first verify and include free trial
credits, so the first call works immediately.
"""

import argparse
import json
import os
import socket
import sys
import urllib.error
import urllib.request
from pathlib import Path

CONFIG_PATH = Path.home() / ".agentcall" / "config.json"
DEFAULT_API_URL = "https://api.agentcall.dev"


def api_url() -> str:
    """Resolve the API base URL: env var, then config, then the public default."""
    if os.environ.get("AGENTCALL_API_URL"):
        return os.environ["AGENTCALL_API_URL"]
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text()).get("api_url") or DEFAULT_API_URL
        except (json.JSONDecodeError, OSError):
            pass
    return DEFAULT_API_URL


def _post(url, body, token=""):
    """POST JSON, return (status_code, parsed_body). status 0 = network error."""
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or "{}")
        except Exception:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"error": str(e)}


def emit(obj, code=0):
    print(json.dumps(obj), flush=True)
    sys.exit(code)


def cmd_send(email):
    # The send endpoint always returns 200 {"ok":true} to prevent enumeration,
    # so a non-200 means malformed input / connectivity — surface only that.
    status, _ = _post(f"{api_url()}/v1/auth/email-otp/send", {"email": email})
    if status == 200:
        emit({"event": "otp_sent", "email": email,
              "note": "6-digit code emailed if the address is eligible; expires in "
                      "10 minutes, resend allowed after 60 seconds"})
    emit({"event": "error", "stage": "send", "email": email,
          "message": "could not request code (check email format / connectivity)"}, 1)


def cmd_verify(email, code, name):
    base = api_url()
    status, body = _post(f"{base}/v1/auth/email-otp/verify",
                         {"email": email, "code": code})
    if status != 200 or not body.get("token"):
        emit({"event": "error", "stage": "verify",
              "message": body.get("error", "invalid or expired code")}, 1)
    token = body["token"]
    is_new = bool(body.get("is_new_user"))

    status, body = _post(f"{base}/v1/auth/api-keys", {"name": name}, token=token)
    if status != 201 or not body.get("key"):
        emit({"event": "error", "stage": "mint",
              "message": body.get("error", "could not create API key")}, 1)

    _save_key(body["key"])
    emit({"event": "registered", "email": email, "is_new_user": is_new,
          "api_key_prefix": body.get("key_prefix", ""), "saved": str(CONFIG_PATH)})


def _save_key(key):
    """Merge api_key into ~/.agentcall/config.json, preserving other fields."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    cfg = {}
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            cfg = {}
    cfg["api_key"] = key
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))


def default_key_name():
    try:
        host = socket.gethostname() or "unknown-host"
    except Exception:
        host = "unknown-host"
    return f"AgentCall Skill on {host}"


def main():
    p = argparse.ArgumentParser(
        description="Self-service AgentCall registration via email OTP")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send", help="email a 6-digit code")
    s.add_argument("--email", required=True)

    v = sub.add_parser("verify", help="verify code + mint & save API key")
    v.add_argument("--email", required=True)
    v.add_argument("--code", required=True)
    v.add_argument("--name", default="", help="API key name (defaults to host)")

    args = p.parse_args()
    if args.cmd == "send":
        cmd_send(args.email.strip().lower())
    elif args.cmd == "verify":
        cmd_verify(args.email.strip().lower(), args.code.strip(),
                   args.name or default_key_name())


if __name__ == "__main__":
    main()
