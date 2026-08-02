'use strict';

// Serves a real PowerShell session (ConPTY) as a web page, so it can be opened
// in the Steam in-game overlay browser with Shift+Tab.
//
// The pty outlives the browser connection: closing the overlay, reloading the
// page, or switching devices reattaches to the same shell with its scrollback.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const ROOT = __dirname;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = { port: 7681, lan: false, cwd: null, shell: null, token: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lan') opts.lan = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--shell') opts.shell = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node server.js [--port 7681] [--lan] [--cwd <dir>] [--shell <exe>] [--token <str>]\n\n' +
          '  --lan     bind 0.0.0.0 so phones/tablets and the overlay can reach it by LAN IP\n' +
          '            (a token is required in this mode; one is generated and persisted)\n' +
          '  --cwd     starting directory for the shell\n' +
          '  --shell   shell executable (default: pwsh.exe, falling back to powershell.exe)'
      );
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

function resolveShell() {
  if (opts.shell) return opts.shell;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return dirs.some((d) => fs.existsSync(path.join(d, 'pwsh.exe'))) ? 'pwsh.exe' : 'powershell.exe';
}

const SHELL = resolveShell();
const START_CWD = opts.cwd || process.env.USERPROFILE || os.homedir();

// A token is only enforced when we're listening beyond loopback. Persisted so
// the URL stays stable and can be saved as the overlay browser's home page.
let TOKEN = '';
if (opts.lan) {
  const tokenFile = path.join(ROOT, '.token');
  if (opts.token) {
    TOKEN = opts.token;
  } else if (fs.existsSync(tokenFile)) {
    TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
  }
  if (!TOKEN) {
    TOKEN = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(tokenFile, TOKEN + '\n');
  }
}

function authorized(url) {
  return !TOKEN || url.searchParams.get('t') === TOKEN;
}

// ------------------------------------------------------------- sessions

const SCROLLBACK_LIMIT = 512 * 1024; // chars of replay kept per session

const sessions = new Map();

// One serialization for all attached clients, rather than one per client.
function broadcast(s, msg) {
  const frame = JSON.stringify(msg);
  for (const ws of s.clients) {
    if (ws.readyState === ws.OPEN) ws.send(frame);
  }
}

function getSession(name) {
  const existing = sessions.get(name);
  if (existing) return existing;

  const proc = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: START_CWD,
    env: process.env,
    useConpty: true,
  });

  // Scrollback is kept as a chunk list so trimming is O(chunk) rather than
  // recopying the whole cap on every write - a redrawing TUI writes constantly.
  const s = { name, proc, chunks: [], bytes: 0, clients: new Set() };

  proc.onData((data) => {
    s.chunks.push(data);
    s.bytes += data.length;
    while (s.chunks.length > 1 && s.bytes - s.chunks[0].length >= SCROLLBACK_LIMIT) {
      s.bytes -= s.chunks.shift().length;
    }
    broadcast(s, { type: 'o', d: data });
  });

  proc.onExit(({ exitCode }) => {
    sessions.delete(name);
    broadcast(s, { type: 'exit', code: exitCode });
    // Otherwise the scrollback stays reachable through every attached socket's
    // handler closure for as long as that socket lives.
    s.chunks = [];
    s.bytes = 0;
  });

  sessions.set(name, s);
  console.log(`[session] spawned "${name}" -> ${SHELL} (pid ${proc.pid}) in ${START_CWD}`);
  return s;
}

// ---------------------------------------------------------------- http

// `auth` is a property of the route so that adding a route forces the decision.
// The vendor assets stay ungated: they are inert, and gating them would break
// the relative loads from the page.
const STATIC = {
  '/': {
    file: path.join(ROOT, 'public', 'index.html'),
    type: 'text/html; charset=utf-8',
    auth: true,
    cache: 'no-cache',
  },
  '/vendor/xterm.js': {
    file: path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
    type: 'application/javascript; charset=utf-8',
  },
  '/vendor/xterm.css': {
    file: path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
    type: 'text/css; charset=utf-8',
  },
  '/vendor/addon-fit.js': {
    file: path.join(ROOT, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
    type: 'application/javascript; charset=utf-8',
  },
};

// The vendor bundle is ~300 KB and never changes while the process runs, so it
// is read once and served from memory with a long-lived cache header.
const VENDOR_CACHE = 'public, max-age=31536000, immutable';
const cached = new Map();

function readStatic(entry, cb) {
  if (entry.cache) { // never cached in memory; edit index.html and reload
    fs.readFile(entry.file, cb);
    return;
  }
  const hit = cached.get(entry.file);
  if (hit) {
    cb(null, hit);
    return;
  }
  fs.readFile(entry.file, (err, buf) => {
    if (!err) cached.set(entry.file, buf);
    cb(err, buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const entry = STATIC[url.pathname];

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  if (!entry) {
    res.writeHead(404).end('not found');
    return;
  }
  if (entry.auth && !authorized(url)) {
    res.writeHead(401, { 'content-type': 'text/plain' }).end('missing or bad ?t= token');
    return;
  }
  readStatic(entry, (err, buf) => {
    if (err) {
      res.writeHead(500).end('read error: ' + err.message);
      return;
    }
    res.writeHead(200, {
      'content-type': entry.type,
      'cache-control': entry.cache || VENDOR_CACHE,
    }).end(buf);
  });
});

// ----------------------------------------------------------------- ws

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !authorized(url)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
});

wss.on('connection', (ws, url) => {
  const s = getSession(url.searchParams.get('s') || 'main');
  s.clients.add(ws);
  console.log(`[client] attached to "${s.name}" (${s.clients.size} attached)`);

  // Replay scrollback so a reconnect looks like you never left.
  ws.send(JSON.stringify({ type: 'o', d: s.chunks.join('') }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'i') s.proc.write(msg.d);
    else if (msg.type === 'r' && msg.cols > 0 && msg.rows > 0) {
      try {
        s.proc.resize(msg.cols, msg.rows);
      } catch { /* pty may have exited */ }
    } else if (msg.type === 'k') {
      // Closing a pane in the UI ends that shell, the way closing a terminal
      // pane does. Merely disconnecting never kills anything.
      console.log(`[session] killing "${s.name}" at client request`);
      try {
        s.proc.kill();
      } catch { /* already gone */ }
    }
  });

  ws.on('close', () => {
    s.clients.delete(ws);
    console.log(`[client] detached from "${s.name}" (${s.clients.size} attached) - shell kept alive`);
  });
});

// -------------------------------------------------------------- listen

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const host = opts.lan ? '0.0.0.0' : '127.0.0.1';
server.listen(opts.port, host, () => {
  const q = TOKEN ? `/?t=${TOKEN}` : '/';
  console.log('');
  console.log(`  shell : ${SHELL}   cwd: ${START_CWD}`);
  console.log('  open  :');
  console.log(`          http://127.0.0.1:${opts.port}${q}`);
  if (opts.lan) {
    for (const ip of lanAddresses()) console.log(`          http://${ip}:${opts.port}${q}`);
    console.log('');
    console.log('  LAN mode: anyone on your network who has the token gets a shell.');
  }
  console.log('');
  console.log('  Paste one of those into the Steam overlay browser address bar.');
  console.log('  Closing the page does NOT kill the shell - reopen to reattach.');
  console.log('');
});
