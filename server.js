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
  const opts = { port: 7681, lan: false, cwd: null, shell: null, token: null, allowHosts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lan') opts.lan = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--shell') opts.shell = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--allow-host') opts.allowHosts.push(String(argv[++i]).toLowerCase());
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node server.js [--port 7681] [--lan] [--cwd <dir>] [--shell <exe>]\n' +
          '                     [--token <str>] [--allow-host <name>]\n\n' +
          '  --lan          bind 0.0.0.0 so phones/tablets and the overlay can reach it by LAN IP\n' +
          '                 (a token is required in this mode; one is generated and persisted)\n' +
          '  --cwd          starting directory for the shell\n' +
          '  --shell        shell executable (default: pwsh.exe, falling back to powershell.exe)\n' +
          '  --token        set the LAN token instead of using the generated one\n' +
          '  --allow-host   extra hostname the browser may reach this server by, e.g. a\n' +
          '                 hosts-file alias (repeatable)'
      );
      process.exit(0);
    } else {
      console.error(`unknown option: ${a}  (try --help)`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error('--port must be a number between 1 and 65535');
    process.exit(1);
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

// ------------------------------------------------------- access control
//
// This process hands out shells, so two distinct attacks have to be closed.
//
// A WebSocket handshake is exempt from the same-origin policy. Without an
// Origin check, any page in any open tab could connect to ws://127.0.0.1:7681
// and type into your shell. Browsers always send Origin on a handshake;
// client.js and other non-browser clients send none, so an absent Origin means
// the request did not come from a web page.
//
// An Origin check alone does not stop DNS rebinding - such a page can serve
// itself from the same origin it later aims at us - but it always arrives under
// its own hostname. So when no token is in play, the Host has to be a name that
// can only mean this machine.

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', ...opts.allowHosts]);

function sameSite(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (!TOKEN && !LOCAL_HOSTS.has(host.replace(/:\d+$/, ''))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function tokenOk(url) {
  if (!TOKEN) return true;
  const got = Buffer.from(url.searchParams.get('t') || '');
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
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
    // node-pty's older ConPTY path forks a helper on kill() to enumerate the
    // console process list; from a process that already owns a console (this
    // one) that helper dies with "AttachConsole failed" and prints a stack
    // trace to our stderr on every closed pane. The bundled conpty.dll takes a
    // kill path with no helper. Both prebuilt arches ship the DLL.
    useConptyDll: true,
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
    console.log(`[session] "${name}" ended (exit ${exitCode})`);
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
// A read-only view of what is running, so the page can offer a session picker
// instead of making you remember names. Deliberately read-only: killing a
// session still happens only over a WebSocket already attached to it, which
// keeps the mutating surface of this server at exactly one place.
const DYNAMIC = {
  '/sessions': {
    auth: true,
    type: 'application/json; charset=utf-8',
    body: () =>
      JSON.stringify(
        [...sessions.values()]
          .map((s) => ({ name: s.name, clients: s.clients.size }))
          // Numeric collation so pane2 sorts before pane10.
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      ),
  },
};

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

  if (!sameSite(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('bad Host or Origin');
    return;
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const dyn = DYNAMIC[url.pathname];
  if (dyn) {
    if (dyn.auth && !tokenOk(url)) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('missing or bad ?t= token');
      return;
    }
    res.writeHead(200, { 'content-type': dyn.type, 'cache-control': 'no-store' }).end(dyn.body());
    return;
  }
  if (!entry) {
    res.writeHead(404).end('not found');
    return;
  }
  if (entry.auth && !tokenOk(url)) {
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
  if (url.pathname !== '/ws' || !sameSite(req) || !tokenOk(url)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
});

wss.on('connection', (ws, url) => {
  let s;
  try {
    s = getSession(url.searchParams.get('s') || 'main');
  } catch (err) {
    // A bad --shell shouldn't take the server down with a stack trace; show the
    // reason in the pane that asked for it.
    console.error(`[session] failed to spawn ${SHELL}: ${err.message}`);
    ws.send(JSON.stringify({ type: 'o', d: `failed to start ${SHELL}: ${err.message}\r\n` }));
    ws.close();
    return;
  }
  s.clients.add(ws);
  console.log(`[client] attached to "${s.name}" (${s.clients.size} attached)`);

  // Replay scrollback so a reconnect looks like you never left. Flagged as a
  // replay because a terminal must not answer the queries buried in it a second
  // time - see the client's handler.
  ws.send(JSON.stringify({ type: 'o', d: s.chunks.join(''), replay: true }));

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
    const fate = sessions.has(s.name) ? ' - shell kept alive' : '';
    console.log(`[client] detached from "${s.name}" (${s.clients.size} attached)${fate}`);
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  port ${opts.port} is already in use - is server.js already running?`);
    console.error('  pick another with --port.\n');
  } else {
    console.error(`\n  could not listen on ${host}:${opts.port} - ${err.message}\n`);
  }
  process.exit(1);
});

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
