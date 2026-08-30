import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';

import { config, assertConfig, ROOT } from './config.js';
import { describeProvider } from './providers/index.js';
import { loadVenueConfig } from './venueConfig.js';
import { SessionManager } from './session.js';
import { decodeAudioFrame, FRAME_MIC } from './protocol.js';
import { pack as meseroPack } from './packs/mesero.js';

const PACKS = { mesero: meseroPack };

const pack = PACKS[config.pack];
if (!pack) {
  console.error(`Unknown PACK "${config.pack}". Available: ${Object.keys(PACKS).join(', ')}`);
  process.exit(1);
}

assertConfig();

const sessions = new SessionManager(pack);
const WEB_DIR = resolve(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // Contain the path inside web/ — no traversal out of the served directory.
  const target = normalize(join(WEB_DIR, rel));
  if (!target.startsWith(WEB_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const body = await readFile(target);
  res.writeHead(200, {
    'content-type': MIME[extname(target)] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  if (pathname === '/api/health') {
    return json(res, 200, { ok: true, pack: pack.id, sessions: sessions.list().length });
  }

  if (pathname === '/api/sessions') {
    return json(res, 200, { sessions: sessions.list().map((s) => s.toJSON()) });
  }

  const dockMatch = pathname.match(/^\/api\/dock\/([^/]+)$/);
  if (dockMatch) {
    const s = sessions.peek(decodeURIComponent(dockMatch[1]));
    if (!s) return json(res, 404, { error: 'no session for that dock' });
    return json(res, 200, s.toJSON());
  }

  // ------------------------------------------------------------------- menu
  // The POS edits the whole menu and PUTs it back: one atomic write, one
  // validation, and menu.json stays the single source of truth. New agent
  // sessions pick the change up immediately; live ones keep the menu they
  // connected with until the table is next woken.
  if (pathname === '/api/menu') {
    if (req.method === 'GET') return json(res, 200, { menu: pack.menu || null });
    if (req.method === 'PUT') {
      if (!pack.saveMenu) return json(res, 400, { error: `el pack ${pack.id} no tiene carta editable` });
      const body = await readBody(req, 512 * 1024).catch(() => null);
      if (!body) return json(res, 400, { error: 'JSON inválido o demasiado grande' });
      const result = pack.saveMenu(body.menu || body);
      if (!result.ok) return json(res, 422, { error: result.error });
      for (const s of sessions.list()) s.broadcastMenu();
      return json(res, 200, { ok: true, menu: result.menu });
    }
    return json(res, 405, { error: 'use GET o PUT' });
  }

  // POS → kitchen workflow: advance a confirmed ticket through
  // kitchen / preparing / ready / served.
  const ticketMatch = pathname.match(/^\/api\/dock\/([^/]+)\/ticket\/([^/]+)\/status$/);
  if (ticketMatch) {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
    const s = sessions.peek(decodeURIComponent(ticketMatch[1]));
    if (!s) return json(res, 404, { error: 'no session for that dock' });
    const body = await readBody(req).catch(() => ({}));
    if (!s.setTicketStatus(decodeURIComponent(ticketMatch[2]), body.status)) {
      return json(res, 422, { error: 'ticket o estado inválido' });
    }
    return json(res, 200, { ok: true, session: s.toJSON() });
  }

  // POS / demo → apply a pack tool by hand (add_item, confirm_order, …).
  // Same reducer the voice agent uses, so every screen sees the same thing.
  const toolMatch = pathname.match(/^\/api\/dock\/([^/]+)\/tool$/);
  if (toolMatch) {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
    const s = sessions.get(decodeURIComponent(toolMatch[1]));
    const body = await readBody(req).catch(() => ({}));
    if (!body.name) return json(res, 400, { error: 'falta name' });
    const changed = s.applyToolDirect(
      String(body.name),
      body.args || {},
      typeof body.doa === 'number' ? body.doa : null
    );
    if (!changed) return json(res, 422, { error: `la herramienta ${body.name} no aplicó` });
    return json(res, 200, { ok: true, session: s.toJSON() });
  }

  // POS → clear a table once everything is served and paid.
  const resetMatch = pathname.match(/^\/api\/dock\/([^/]+)\/reset$/);
  if (resetMatch) {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
    const s = sessions.peek(decodeURIComponent(resetMatch[1]));
    if (!s) return json(res, 404, { error: 'no session for that dock' });
    s.resetTable();
    return json(res, 200, { ok: true, session: s.toJSON() });
  }

  // ---------------------------------------------------------------- webhook
  // The trigger that wakes the hardware when a diner arrives.
  //
  // The phone cannot reach the gadget directly (iOS Safari has no Web Bluetooth
  // and no Web Serial), so it does not try to. Opening the table screen already
  // wakes the dock through the /ui socket; this endpoint exposes the same wake
  // to anything else that can send an HTTP request — an NFC shortcut, a POS, a
  // QR landing page, a reservation system.
  const wakeMatch = pathname.match(/^\/hooks\/dock\/([^/]+)\/(wake|sleep)$/);
  if (wakeMatch) {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
    const dock = decodeURIComponent(wakeMatch[1]);
    const action = wakeMatch[2];
    const body = await readBody(req).catch(() => ({}));
    const s = sessions.get(dock);
    if (action === 'wake') {
      const changed = s.wake(body.reason || 'webhook');
      return json(res, 200, { ok: true, changed, session: s.toJSON() });
    }
    s.sleep(body.reason || 'webhook');
    return json(res, 200, { ok: true, session: s.toJSON() });
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);
  res.writeHead(404).end('not found');
});

// -------------------------------------------------------------- WebSockets

const deviceWss = new WebSocketServer({ noServer: true });
const uiWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/device') {
    deviceWss.handleUpgrade(req, socket, head, (ws) => deviceWss.emit('connection', ws, req, url));
  } else if (url.pathname === '/ui') {
    uiWss.handleUpgrade(req, socket, head, (ws) => uiWss.emit('connection', ws, req, url));
  } else {
    socket.destroy();
  }
});

deviceWss.on('connection', (ws, req, url) => {
  const dock = url.searchParams.get('dock') || 'mesa-01';
  /**
   * A gadget proves which restaurant it belongs to with its venue key — the same
   * credential the voice, the payments and the carta already check, and the one
   * the firmware actually carries.
   *
   * What was here before asked for a `token` that was never compared against
   * anything: any non-empty string opened the door, while the real firmware sent
   * none at all. Turning that check on in production would have rejected every
   * gadget in the restaurant and left the tables silent.
   *
   * With no venue key configured this backend is somebody's laptop running the
   * open-source stack against the bundled carta, and there is nothing to prove.
   */
  const presented = url.searchParams.get('venue');
  if (config.venueKey && presented !== config.venueKey) {
    console.log(`[${dock}] device refused: ${presented ? 'wrong venue key' : 'no venue key'}`);
    ws.close(4401, 'venue key required');
    return;
  }

  const session = sessions.get(dock);
  let attached = false;
  ws.binaryType = 'nodebuffer';

  const keepalive = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
  }, 15000);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const frame = decodeAudioFrame(data);
      if (!frame || frame.type !== FRAME_MIC) return;
      session.handleDeviceAudio(frame);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }

    switch (msg.t) {
      case 'hello':
        session.attachDevice(ws, msg);
        attached = true;
        break;
      case 'telemetry':
        session.handleDeviceTelemetry(msg);
        break;
      case 'button':
        session.handleDeviceButton(msg);
        break;
      case 'pong':
        break;
      case 'bye':
        ws.close(1000, 'bye');
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    clearInterval(keepalive);
    if (attached && session.device === ws) session.detachDevice();
  });

  ws.on('error', () => {
    /* close handler cleans up */
  });
});

uiWss.on('connection', (ws, req, url) => {
  const dock = url.searchParams.get('dock') || 'mesa-01';
  const session = sessions.get(dock);
  session.attachUi(ws);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.t === 'ui_action') session.handleUiAction(msg);
  });

  ws.on('close', () => session.detachUi(ws));
  ws.on('error', () => session.detachUi(ws));
});

/**
 * Boot.
 *
 * Wrapped in a function rather than awaited at the top level so this file can be
 * bundled to CommonJS for the desktop build — top-level await has no equivalent
 * there, and a restaurant should not have to install Node to run this.
 */
async function main() {
  // Pull the carta, the tables and the agent from the platform before answering
  // anything. Without a venue key this is a no-op and the bundled menu.json wins,
  // which is exactly what a first-time replicator gets.
  const venue = await loadVenueConfig(pack);

  server.listen(config.port, () => {
    console.log('');
    console.log(`  Mesero AI backend`);
    console.log(`  pack        ${pack.id}  (${pack.label})`);
    console.log(`  provider    ${describeProvider()}${config.venueKey ? ` venue=${config.venueKey.slice(0, 12)}…` : ' (sin llave de venue)'}`);
    console.log(
      `  carta       ${venue.ok ? `${venue.venue?.name} (plataforma)` : `local${venue.reason ? ` — ${venue.reason}` : ''}`}`
    );
    console.log(`  http        http://localhost:${config.port}`);
    console.log(`  table view  http://localhost:${config.port}/?dock=mesa-01`);
    console.log(`  kitchen     http://localhost:${config.port}/kitchen.html`);
    console.log(`  POS admin   http://localhost:${config.port}/pos.html`);
    console.log(`  device ws   ws://localhost:${config.port}/device?dock=mesa-01`);
    console.log(`  wake hook   POST http://localhost:${config.port}/hooks/dock/mesa-01/wake`);
    console.log('');
  });
}

main().catch((err) => {
  console.error(`No se pudo arrancar: ${err.message}`);
  process.exit(1);
});
