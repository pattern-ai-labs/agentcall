#!/usr/bin/env node
/**
 * Reserve bots ahead of a meeting for a fast join (Pro / Enterprise).
 *
 * Zero third-party deps (Node stdlib only).
 *
 * A reservation holds up to 4 bots of ONE mode for a fixed 15-minute window,
 * starting 5 minutes to 7 days ahead. Start a call on it with
 * `--reservation-id res_...` (bridges / join): the bot skips the machine start.
 * Unused reserved time is billed at your normal per-minute rate for that mode;
 * cancelling is free until 5 minutes before the start.
 *
 * Subcommands (each prints the JSON response to stdout; exit 1 on an error):
 *   book   --mode audio --count 2 --start +10m   -> book (start: ISO 8601 UTC, or +Nm / +Nh / +Nd)
 *   list                                         -> your reservations, newest first
 *   get    <reservation_id>                      -> one reservation (live "ready" count while active)
 *   cancel <reservation_id>                      -> cancel it
 *
 * Reads the API key from AGENTCALL_API_KEY or ~/.agentcall/config.json, and the
 * API URL from AGENTCALL_API_URL, the config, or https://api.agentcall.dev.
 */

import https from 'https';
import http from 'http';
import { readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const CONFIG_PATH = join(homedir(), '.agentcall', 'config.json');
const DEFAULT_API_URL = 'https://api.agentcall.dev';
const MODES = ['audio', 'webpage-audio', 'webpage-av', 'webpage-av-screenshare'];

// Short explanations for the errors the reservations API returns.
const HINTS = {
  400: 'invalid field (mode, count 1-4, start 5 minutes to 7 days ahead)',
  402: 'not enough credits to cover every reserved bot for the full 15 minutes',
  403: 'reservations need a Pro or Enterprise plan',
  409: 'no reservable capacity at that time; try another time or fewer bots',
  429: 'reservation limit reached (max 4 overlapping, max 100 not yet ended)',
  503: 'reservations are temporarily unavailable; start the call without one',
};

const USAGE = 'usage: reserve.js book --start <ISO 8601 UTC | +10m | +2h | +1d> [--mode audio] [--count 1]\n'
  + '       reserve.js list | get <reservation_id> | cancel <reservation_id>';

function config() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function apiUrl() {
  return process.env.AGENTCALL_API_URL || config().api_url || DEFAULT_API_URL;
}

function apiKey() {
  return process.env.AGENTCALL_API_KEY || config().api_key || '';
}

// start_at as ISO 8601 UTC. "+10m" / "+2h" / "+1d" are relative to now;
// anything else is passed through as an ISO 8601 time.
export function parseStart(value, now = new Date()) {
  value = String(value).trim();
  const m = /^\+(\d+)([mhd])$/.exec(value);
  if (!m) {
    if (value.startsWith('+')) throw new Error(`bad relative start "${value}": use +Nm, +Nh or +Nd`);
    return value;
  }
  const ms = { m: 60000, h: 3600000, d: 86400000 }[m[2]] * parseInt(m[1], 10);
  return new Date(now.getTime() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Send a request, resolve { status, body }. status 0 = network error.
function request(method, path, body) {
  return new Promise((resolve) => {
    const url = `${apiUrl()}${path}`;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const lib = url.startsWith('http://') ? http : https;
    const headers = { Authorization: `Bearer ${apiKey()}` };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const req = lib.request(url, { method, headers, timeout: 30000 }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw || 'null'); } catch { parsed = { error: raw.trim() }; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: String(e) } }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: { error: 'timeout' } }); });
    if (data) req.write(data);
    req.end();
  });
}

function finish({ status, body }) {
  if (status >= 200 && status < 300) {
    process.stdout.write(JSON.stringify(body) + '\n');
    process.exit(0);
  }
  const message = (body && typeof body === 'object' ? body.error : String(body)) || HINTS[status] || 'request failed';
  const out = { event: 'error', status, message };
  if (HINTS[status]) out.hint = HINTS[status];
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(1);
}

// --- minimal flag parser: reserve.js <cmd> [id] [--mode M] [--count N] [--start S] ---
function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}

function usage(msg) {
  if (msg) process.stderr.write(`reserve.js: ${msg}\n`);
  process.stderr.write(USAGE + '\n');
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = parseFlags(rest);
  if (!['book', 'list', 'get', 'cancel'].includes(cmd)) usage();
  if (!apiKey()) {
    finish({ status: 0, body: { error: 'API key not found. Set AGENTCALL_API_KEY or save it to ~/.agentcall/config.json' } });
  }

  if (cmd === 'book') {
    const mode = f.mode || 'audio';
    if (!MODES.includes(mode)) usage(`--mode must be one of: ${MODES.join(', ')}`);
    const count = f.count === undefined ? 1 : Number(f.count);
    if (!Number.isInteger(count)) usage('--count must be a whole number (1-4)');
    if (!f.start) usage('--start is required');
    let startAt;
    try { startAt = parseStart(f.start); } catch (e) { usage(e.message); }
    finish(await request('POST', '/v1/reservations', { mode, count, start_at: startAt }));
  } else if (cmd === 'list') {
    finish(await request('GET', '/v1/reservations'));
  } else {
    const id = (f._[0] || '').trim();
    if (!id) usage(`${cmd} needs a reservation_id`);
    finish(await request(cmd === 'get' ? 'GET' : 'DELETE', `/v1/reservations/${encodeURIComponent(id)}`));
  }
}

// Run only when executed directly (tests import parseStart).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
