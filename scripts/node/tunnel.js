/**
 * Tunnel client — proxies HTTP/WS from AgentCall to localhost.
 */

import WebSocket from 'ws';
import http from 'http';

// Request headers never forwarded to the local server: connection-scoped, or
// describing the body as it was before the tunnel re-encoded it.
const SKIP_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);

export class TunnelClient {
  constructor(tunnelWSURL, tunnelId, tunnelAccessKey, localPort = 3000) {
    this.tunnelWSURL = tunnelWSURL;
    this.tunnelId = tunnelId;
    this.tunnelAccessKey = tunnelAccessKey;
    this.localPort = localPort;
    this.ws = null;
    this.running = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.running = true;
      this.ws = new WebSocket(this.tunnelWSURL);

      this.ws.on('open', () => {
        // Register.
        this.ws.send(JSON.stringify({
          type: 'tunnel.register',
          payload: {
            tunnel_id: this.tunnelId,
            tunnel_access_key: this.tunnelAccessKey,
            // Bodies travel as base64 both ways (binary-safe).
            capabilities: ['binary_bodies'],
          },
        }));
        console.error(`[tunnel] connected: ${this.tunnelId}`);
        resolve();
      });

      this.ws.on('error', reject);
      this.ws.on('message', (data) => this._handleMessage(JSON.parse(data.toString())));

      this.ws.on('close', () => {
        if (this.running) {
          console.error('[tunnel] disconnected, reconnecting...');
          this._reconnect();
        }
      });

      // Heartbeat.
      this._heartbeatInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000);
    });
  }

  _handleMessage(msg) {
    const type = msg.type;

    if (type === 'http.request') {
      this._handleHTTPRequest(msg.payload || msg);
    }
  }

  _handleHTTPRequest(payload) {
    const requestId = payload.request_id;
    const method = payload.method || 'GET';
    // The tunnel URL is .../ui/, so page requests arrive as /ui/<path>; strip the
    // prefix like the other tunnel clients so the local server sees /<path>.
    const rawPath = payload.path || '/';
    const path = rawPath.startsWith('/ui') ? (rawPath.substring('/ui'.length) || '/') : rawPath;
    const headers = {};
    for (const [k, v] of Object.entries(payload.headers || {})) {
      if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    // The tunnel always sends request bodies as base64. body_encoding="base64"
    // marks a server that also accepts base64 responses (binary-safe); an
    // older server gets the legacy text format.
    const binary = payload.body_encoding === 'base64';

    const options = {
      hostname: 'localhost',
      port: this.localPort,
      path,
      method,
      headers,
    };

    const reqBody = payload.body ? Buffer.from(payload.body, binary ? 'base64' : 'utf8') : null;

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks); // bytes as sent (Node does not decompress)
        const respHeaders = {};
        for (const [k, v] of Object.entries(res.headers)) {
          respHeaders[k] = Array.isArray(v) ? v[0] : v;
        }
        const out = { request_id: requestId, status: res.statusCode, headers: respHeaders };
        if (binary) {
          out.body = raw.toString('base64');
          out.body_encoding = 'base64';
        } else {
          out.body = raw.toString();
        }
        this.ws.send(JSON.stringify({
          type: 'http.response',
          request_id: requestId,
          payload: out,
        }));
      });
    });

    req.on('error', (err) => {
      this.ws.send(JSON.stringify({
        type: 'http.response',
        request_id: requestId,
        payload: {
          request_id: requestId,
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
          body: `Local server error: ${err.message}`,
        },
      }));
    });

    if (reqBody) {
      req.write(reqBody);
    }
    req.end();
  }

  async _reconnect() {
    const delays = [1000, 2000, 4000, 8000, 16000];
    for (const delay of delays) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        await this.connect();
        return;
      } catch (e) {
        console.error(`[tunnel] reconnect failed: ${e.message}`);
      }
    }
    console.error('[tunnel] reconnect failed after all retries');
  }

  close() {
    this.running = false;
    clearInterval(this._heartbeatInterval);
    if (this.ws) this.ws.close();
  }
}
