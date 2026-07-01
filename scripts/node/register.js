#!/usr/bin/env node
/**
 * Self-service registration — get an AgentCall API key via email OTP.
 *
 * Zero third-party deps (Node stdlib only) so it runs before `npm install`.
 *
 * Subcommands (each prints one JSON line to stdout):
 *   send   --email E             -> emails a 6-digit code to E
 *   verify --email E --code C     -> verifies the code, mints an API key, and
 *                                    saves it to ~/.agentcall/config.json
 *
 * Agent flow: run `send`, obtain the 6-digit code (read the mailbox yourself if
 * you have email access, otherwise ask the user to paste it), then run `verify`.
 * New accounts are created automatically on first verify and include free trial
 * credits, so the first call works immediately.
 */

import https from 'https';
import http from 'http';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir, hostname } from 'os';
import { join, dirname } from 'path';

const CONFIG_PATH = join(homedir(), '.agentcall', 'config.json');
const DEFAULT_API_URL = 'https://api.agentcall.dev';

function apiUrl() {
  if (process.env.AGENTCALL_API_URL) return process.env.AGENTCALL_API_URL;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.api_url) return cfg.api_url;
  } catch {
    // ignore
  }
  return DEFAULT_API_URL;
}

// POST JSON, resolve { status, body }. status 0 = network error.
function post(url, body, token = '') {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const lib = url.startsWith('http://') ? http : https;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = lib.request(url, { method: 'POST', headers, timeout: 30000 }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: String(e) } }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: { error: 'timeout' } }); });
    req.write(data);
    req.end();
  });
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

function saveKey(key) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { cfg = {}; }
  cfg.api_key = key;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function defaultKeyName() {
  let host = 'unknown-host';
  try { host = hostname() || 'unknown-host'; } catch { /* ignore */ }
  return `AgentCall Skill on ${host}`;
}

async function cmdSend(email) {
  // send always returns 200 {"ok":true} (anti-enumeration); non-200 = bad input/network
  const { status } = await post(`${apiUrl()}/v1/auth/email-otp/send`, { email });
  if (status === 200) {
    emit({ event: 'otp_sent', email,
           note: '6-digit code emailed if the address is eligible; expires in 10 '
                 + 'minutes, resend allowed after 60 seconds' });
  }
  emit({ event: 'error', stage: 'send', email,
         message: 'could not request code (check email format / connectivity)' }, 1);
}

async function cmdVerify(email, code, name) {
  const base = apiUrl();
  let r = await post(`${base}/v1/auth/email-otp/verify`, { email, code });
  if (r.status !== 200 || !r.body.token) {
    emit({ event: 'error', stage: 'verify',
           message: r.body.error || 'invalid or expired code' }, 1);
  }
  const token = r.body.token;
  const isNew = Boolean(r.body.is_new_user);

  r = await post(`${base}/v1/auth/api-keys`, { name }, token);
  if (r.status !== 201 || !r.body.key) {
    emit({ event: 'error', stage: 'mint',
           message: r.body.error || 'could not create API key' }, 1);
  }

  saveKey(r.body.key);
  emit({ event: 'registered', email, is_new_user: isNew,
         api_key_prefix: r.body.key_prefix || '', saved: CONFIG_PATH });
}

// --- minimal flag parser: register.js <cmd> --email X [--code C] [--name N] ---
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    }
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const f = parseFlags(rest);
if (cmd === 'send' && f.email) {
  cmdSend(f.email.trim().toLowerCase());
} else if (cmd === 'verify' && f.email && f.code) {
  cmdVerify(f.email.trim().toLowerCase(), f.code.trim(), f.name || defaultKeyName());
} else {
  emit({ event: 'error', message: 'usage: register.js send --email E | verify --email E --code C [--name N]' }, 2);
}
