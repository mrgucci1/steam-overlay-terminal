# steam-overlay-terminal — PowerShell in the Steam in-game overlay

**Run a real PowerShell terminal — and Claude Code — inside the Steam overlay, without
alt-tabbing out of your game.** A Windows ConPTY session served as a local web page, so
Shift+Tab gets you a shell instead of a browser you don't want.

Steam has no API for putting an arbitrary Windows window into the overlay — the only
third-party surface it exposes in-game is its built-in Chromium browser. So the trick
is to make the terminal *be* a web page.

![Three PowerShell panes and a Claude Code session running in the Steam in-game overlay during Counter-Strike 2](docs/overlay.png)

*Three panes and a live Claude Code session in the Steam overlay, mid-match in
Counter-Strike 2.*

- Real ConPTY session via `node-pty`, so full TUIs (Claude Code, vim, fzf) work.
- **The shell outlives the browser.** Closing the overlay, reloading the page, or
  switching devices reattaches to the same shell with its scrollback intact.
- **Your normal terminal window can join the same session** (`client.js`), so the
  overlay is just a second view of the shell you were already using.
- **Split panes**, like Windows Terminal — each pane is its own shell, and the
  layout survives a page reload.
- A clickable key bar for Esc / Tab / Shift+Tab / Ctrl+C, because Steam eats
  Shift+Tab and phone keyboards have no Esc key.
- Multiple clients can attach at once (overlay + desktop + phone).
- Listens on loopback only unless you ask otherwise, and refuses connections from
  other web pages — see [Security](#security).

**Requirements:** Windows 10 1809 or newer (ConPTY), Node.js 18+, and PowerShell —
`pwsh.exe` if it's on your PATH, otherwise the built-in `powershell.exe`.

---

## Quick start

**1. Install**

```powershell
git clone https://github.com/YOUR-USERNAME/steam-overlay-terminal.git
cd steam-overlay-terminal
npm install
```

**2. Start the server** and leave it running:

```powershell
npm start
```

It prints the URL to use, e.g. `http://127.0.0.1:7681/`.

**3. Point Steam at it.** Two settings, both one-time:

- **Steam → Settings → In Game → Overlay shortcut keys.** Rebind off Shift+Tab.
  Claude Code uses Shift+Tab to cycle permission modes, so leaving the default
  guarantees a collision. Ctrl+Shift+O works fine.
- **Steam → Settings → Web Browser → Web browser home page.** Paste the URL from
  step 2. Now the overlay opens straight into the terminal.

Also check the game's Properties → General → *Enable the Steam Overlay while
in-game* is on.

**4. Use it.** Launch a game, hit your overlay key, click into the terminal, run
`claude`. Closing the overlay does not kill anything — reopen and you're back
where you left off.

---

## Split panes, like Windows Terminal

Same bindings as Windows Terminal:

| Action | Key | Button |
| --- | --- | --- |
| Split right | `Alt+Shift++` | **Split →** |
| Split down | `Alt+Shift+-` | **Split ↓** |
| Move focus | `Alt+←↑↓→` | click a pane |
| Close pane | `Ctrl+Shift+W` | **× Pane** |

Drag the divider between panes to resize; the pty is resized to match. Every pane
is an independent shell with its own session name, shown in the status corner.

The layout is saved to `localStorage`, so reloading the page — or the overlay
reloading it for you — brings back the same panes reattached to the same live
shells. **Closing a pane ends that shell**; merely disconnecting never does.

Use the buttons rather than the keys inside the Steam overlay if a binding gets
intercepted.

---

## Share one shell between the overlay and Windows Terminal

Don't run `claude` in a separate PowerShell window — run it *inside* the shared
session, so the overlay shows the work you were already doing:

```powershell
node client.js
```

This puts your current Windows Terminal window into the shared session with full
24-bit color. It's a peer of the browser view, not a mirror — type in either one
and both see it. **Ctrl+]** detaches without killing the shell.

Already mid-conversation in an ordinary window? You don't need to move the window.
Claude Code sessions are portable: start `client.js` (or open the overlay) and run
`claude --continue` to pick the same conversation back up.

> An already-running PowerShell window can't be adopted into a session — Windows
> has no way to re-parent a live process's stdio onto a new pty.

---

## From your phone or tablet, over your LAN

Often nicer than typing into a game overlay:

```powershell
node server.js --lan
```

This also listens on your LAN IP and prints a URL like
`http://192.168.1.42:7681/?t=<token>`. Open that on any device on your network.

The token is generated once and saved to `.token` (gitignored), so the URL is
stable and works as a bookmark. **Anyone on your network with that token gets a
shell on this machine — don't port-forward it.**

---

## Security

This process hands out shells, so it's worth being explicit about what protects
one.

- **Loopback by default.** Without `--lan` the server binds `127.0.0.1`, so
  nothing off this machine can reach it at all.
- **Other web pages can't use it.** A WebSocket handshake is exempt from the
  same-origin policy, so any site you had open could otherwise connect to
  `ws://127.0.0.1:7681/ws` and type into your shell. The server rejects any
  handshake whose `Origin` isn't the page it served itself. Non-browser clients
  like `client.js` send no `Origin` at all, which is how they're told apart.
- **DNS rebinding is blocked too.** When no token is in play, requests must
  arrive addressed to a loopback name; a rebinding page always arrives under its
  own hostname. Use `--allow-host` if you reach the server by some other name.
- **`--lan` requires a token**, compared in constant time, and it's the only
  thing standing between your LAN and a shell. It travels in the URL over plain
  HTTP, so treat it as LAN-only: no HTTPS, no port forwarding, no public tunnel.
- **No sandbox.** The shell runs as you, with your profile and your privileges.
  That's the point of the tool, but it means the trust boundary is the machine.

Found something? Open an issue — please don't include your `.token`.

---

## Options

```powershell
node server.js --port 7681          # change port (default 7681)
node server.js --lan                # listen on LAN too; requires a token
node server.js --cwd C:\src\myrepo  # shell start directory
node server.js --shell powershell.exe   # default: pwsh.exe if on PATH, else powershell.exe
node server.js --token <str>        # set the LAN token instead of the generated one
node server.js --allow-host term.local  # extra hostname the browser may use (repeatable)

node client.js --host 127.0.0.1     # server address (default 127.0.0.1)
node client.js --port 7681          # match a non-default server port
node client.js --session build      # a second, independent shell
node client.js --token <tok>        # needed when the server runs with --lan
```

Web URL parameters:

| Param | Meaning |
| --- | --- |
| `?s=<name>` | open a named session, matching `client.js --session <name>` |
| `?fontSize=<n>` | terminal font size (default 14) — worth raising on a phone |
| `?t=<token>` | required when the server runs with `--lan` |

---

## Troubleshooting: the overlay browser won't load the page

`http://127.0.0.1:7681/` loads in the overlay browser — that's what the screenshot
above is. If yours doesn't, the overlay runs an older Chromium build and some users
report loopback addresses failing in it. In order of effort:

1. Use `http://127.0.0.1:7681/` rather than `http://localhost:7681/`.
2. Run with `--lan` and use the printed LAN IP. A routable address sidesteps
   loopback handling entirely.
3. Add `127.0.0.1  term.local` to `C:\Windows\System32\drivers\etc\hosts`, start
   the server with `--allow-host term.local`, and browse to
   `http://term.local:7681/`.

---

## Notes and limitations

- Tested in Counter-Strike 2 (the screenshot above). Any game with the Steam overlay
  enabled should behave the same.
- Exclusive-fullscreen games work — that's the main advantage over an always-on-top
  terminal window, which exclusive fullscreen hides.
- Some games grab the mouse aggressively. The overlay usually still takes focus,
  but borderless-windowed mode is more reliable.
- The shell inherits your PowerShell profile, so a slow or noisy profile shows up
  in the session. Use `--shell` or edit your profile if that's a problem.
- Sessions live in server memory. Restarting `server.js` ends them.
- Scrollback replay is capped at 512 KB per session.
- Windows only. The pty layer is ConPTY, and the whole point is the Windows shell
  you already use.

## How it works: ConPTY, node-pty, and xterm.js

`server.js` spawns PowerShell in a ConPTY via `node-pty` and keeps it alive
independently of any viewer. Browsers connect over WebSocket to an xterm.js page;
`client.js` connects to the same WebSocket and pipes it through your terminal's
stdio in raw mode. Output is fanned out to every attached client and buffered for
replay, so attaching and detaching is lossless.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Valve or Anthropic.
