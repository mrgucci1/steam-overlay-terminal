# steam-overlay-terminal

A real PowerShell session served as a web page, so you can open it inside the Steam
in-game overlay and keep using Claude Code without alt-tabbing out of a game.

Steam has no API for putting an arbitrary Windows window into the overlay — the only
third-party surface it exposes in-game is its built-in Chromium browser. So the trick
is to make the terminal *be* a web page.

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

Windows only. Requires Node.js.

---

## Quick start

**1. Install**

```powershell
cd C:\Users\dalqu\Documents\Github\steam-overlay-terminal
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

## Split panes

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

## Working in the same session from your desktop

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

## From your phone or tablet

Often nicer than typing into a game overlay:

```powershell
node server.js --lan
```

This also listens on your LAN IP and prints a URL like
`http://192.168.1.42:7681/?t=<token>`. Open that on any device on your network.

The token is generated once and saved to `.token`, so the URL is stable and works
as a bookmark. **Anyone on your network with that token gets a shell on this
machine — don't port-forward it.**

---

## Options

```powershell
node server.js --port 7681      # change port (default 7681)
node server.js --lan            # listen on LAN too; requires a token
node server.js --cwd C:\Users\dalqu\Documents\Github   # shell start directory
node server.js --shell powershell.exe                  # default: pwsh.exe

node client.js --port 7681      # match a non-default server port
node client.js --session build  # a second, independent shell
node client.js --token <tok>    # needed when the server runs with --lan
```

Add `?s=<name>` to the web URL to open a named session, matching
`client.js --session <name>`.

---

## If the overlay browser won't load the page

The overlay runs an older Chromium build, and some users report loopback addresses
failing in it. In order of effort:

1. Use `http://127.0.0.1:7681/` rather than `http://localhost:7681/`.
2. Run with `--lan` and use the printed LAN IP. A routable address sidesteps
   loopback handling entirely.
3. Add `127.0.0.1  term.local` to `C:\Windows\System32\drivers\etc\hosts` and
   browse to `http://term.local:7681/`.

---

## Notes and limitations

- Exclusive-fullscreen games work — that's the main advantage over an always-on-top
  terminal window, which exclusive fullscreen hides.
- Some games grab the mouse aggressively. The overlay usually still takes focus,
  but borderless-windowed mode is more reliable.
- The shell inherits your PowerShell profile, so a slow or noisy profile shows up
  in the session. Use `--shell` or edit your profile if that's a problem.
- Sessions live in server memory. Restarting `server.js` ends them.
- Scrollback replay is capped at 512 KB per session.

## How it works

`server.js` spawns PowerShell in a ConPTY via `node-pty` and keeps it alive
independently of any viewer. Browsers connect over WebSocket to an xterm.js page;
`client.js` connects to the same WebSocket and pipes it through your terminal's
stdio in raw mode. Output is fanned out to every attached client and buffered for
replay, so attaching and detaching is lossless.
