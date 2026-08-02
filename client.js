'use strict';

// Attaches your CURRENT terminal window to a session hosted by server.js.
//
// Run this in Windows Terminal and work normally. The Steam overlay opens the
// same session in a browser, so both views show the same shell. Nothing is
// scraped or mirrored - they are two clients of one pty.
//
//   node client.js                 attach to session "main" on 127.0.0.1:7681
//   node client.js --session build attach to a different session
//
// Press Ctrl+] to detach. The shell keeps running.

const WebSocket = require('ws');

const DETACH = 29; // Ctrl+]

function parseArgs(argv) {
  const o = { host: '127.0.0.1', port: 7681, session: 'main', token: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') o.host = argv[++i];
    else if (argv[i] === '--port') o.port = Number(argv[++i]);
    else if (argv[i] === '--session' || argv[i] === '-s') o.session = argv[++i];
    else if (argv[i] === '--token' || argv[i] === '-t') o.token = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node client.js [--host H] [--port N] [--session NAME] [--token TOK]');
      console.log('Ctrl+] detaches without killing the shell.');
      process.exit(0);
    } else {
      // Silently ignoring a typo would quietly attach you to the wrong session.
      console.error('unknown option: ' + argv[i] + '  (try --help)');
      process.exit(1);
    }
  }
  return o;
}

const o = parseArgs(process.argv.slice(2));
const url =
  'ws://' + o.host + ':' + o.port + '/ws?s=' + encodeURIComponent(o.session) +
  (o.token ? '&t=' + encodeURIComponent(o.token) : '');

const ws = new WebSocket(url);

function bye(code, message) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  (code ? console.error : console.log)(message);
  process.exit(code);
}

function sendResize() {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'r',
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
  }));
}

ws.on('open', () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  sendResize();

  process.stdin.on('data', (buf) => {
    // Swallow the detach key rather than forwarding it to the shell.
    if (buf.length === 1 && buf[0] === DETACH) {
      ws.close();
      bye(0, '\r\n[detached - shell still running, run client.js again to reattach]');
    }
    ws.send(JSON.stringify({ type: 'i', d: buf.toString('utf8') }));
  });

  process.stdout.on('resize', sendResize);
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.type === 'o') process.stdout.write(msg.d);
  else if (msg.type === 'exit') bye(0, '\r\n[remote shell exited with code ' + msg.code + ']');
});

ws.on('error', (err) => {
  bye(1, 'connection failed: ' + err.message +
    '\nis server.js running on ' + o.host + ':' + o.port + '?');
});

ws.on('close', () => bye(0, '\r\n[connection closed]'));
