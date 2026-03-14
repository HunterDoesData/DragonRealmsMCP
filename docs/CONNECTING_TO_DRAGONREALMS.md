# Connecting DragonRealms to this MCP Server (macOS)

This guide explains how to connect your browser-based DragonRealms session to the local MCP bridge so tools and agents can read game output and send commands.

## Overview

You are connecting three pieces:

1. DragonRealms web client in your browser.
2. Local MCP bridge server (`127.0.0.1:3989` by default).
3. Optional local control panel UI (`ui/`) for approvals and telemetry.

Once connected:

- Browser pulls queued commands from `GET /io/commands`.
- Browser pushes game output to `POST /io/output`.
- MCP tools and/or UI can inspect output and queue or approve actions.

## Prerequisites (macOS)

- Node.js 18+ installed.
- A DragonRealms account and active web session.
- A userscript extension:
  - Chrome/Brave/Edge: Tampermonkey or Violentmonkey.
  - Firefox: Tampermonkey or Violentmonkey.

## 1) Start the MCP bridge

From project root:

```bash
npm install
npm run build
npm run dev
```

Optional token-protected mode:

```bash
cp .env.example .env
```

Then set `DR_BRIDGE_TOKEN` in your environment before starting the server.

## 2) Launch DragonRealms in browser

1. Sign in through your Play.net account.
2. Open your DragonRealms web game client session.
3. Keep that tab open while testing bridge traffic.

## 3) Install and enable the userscript bridge

1. Open `examples/dragonrealms-bridge.user.js`.
2. Create a new userscript and paste the file contents.
3. Set:
   - `BRIDGE_URL` to your bridge (default: `http://127.0.0.1:3989`).
   - `TOKEN` to the same value as `DR_BRIDGE_TOKEN` if token auth is enabled.
4. Save and enable the script.
5. Reload your DragonRealms browser tab.

Important:

- The userscript must run on the DragonRealms game tab itself (not a separate browser tab).
- If you update script metadata (`@grant`, `@connect`), re-save/re-enable the script in Tampermonkey/Violentmonkey.

## 4) Map selectors for your game client (important)

The userscript now supports click-capture selector profiling and may still need one-time tuning.

### Fast setup (recommended)

1. Load/reload your DragonRealms tab with the userscript enabled.
2. Press `Alt+Shift+I`, then click your game command input box.
3. Press `Alt+Shift+O`, then click your main game output panel.
4. Reload the page once.

The script stores selectors in localStorage under `dr.mcp.selectorProfile.v1`.

### Manual setup (fallback)

If your client has unusual DOM behavior, manually edit selectors in the userscript:

- Input box selector: `findInputElement()`
- Output panel selector(s): `readVisibleGameText()` candidates

### How to find the correct selectors

1. Open browser dev tools on the DragonRealms tab.
2. Click the command input box and inspect the element.
3. Replace the selector in `findInputElement()` with a stable selector from your client.
4. Inspect the scrollback/output container.
5. Replace candidates in `readVisibleGameText()` with the exact output container selector.

Prefer IDs or unique class names from the game client DOM over broad fallbacks.

### Reset selector profile

In browser dev tools console:

```js
localStorage.removeItem("dr.mcp.selectorProfile.v1")
```

Then reload and capture again.

## 5) Verify the connection

With game tab + userscript + server running, test from terminal:

```bash
curl http://127.0.0.1:3989/health
```

You should see `ok: true` and counters.

Queue a command manually:

```bash
curl -X POST http://127.0.0.1:3989/io/commands \
  -H "Content-Type: application/json" \
  -d '{"command":"look"}'
```

Within the next poll cycle, the command should appear in game.

Read buffered output:

```bash
curl "http://127.0.0.1:3989/io/output?limit=20"
```

If token auth is enabled, include header:

```bash
-H "x-dr-token: YOUR_TOKEN"
```

## 6) Optional: run control panel UI

From project root:

```bash
npm run ui:dev
```

Open the local Vite URL (typically `http://127.0.0.1:5173`) and set:

- Bridge URL
- Token (if required)

Use the UI to:

- Watch output and queue depth.
- Approve/reject agent command proposals.
- Queue manual commands.

## 7) Agent-in-the-loop mode

For safer automation, use proposals instead of direct command sends.

- Agent proposes via MCP tool: `dr_propose_command`.
- Human approves in UI (or via bridge proposal endpoint).
- Approved command is moved to command queue and sent to the game client.

This keeps a human safety gate while still enabling agent learning.

## Troubleshooting

### No commands execute in game

- Userscript not running on current URL (`@match` mismatch).
- Wrong input selector (recapture with `Alt+Shift+I`).
- Browser extension disabled for the tab.

### No output captured

- Wrong output selector (recapture with `Alt+Shift+O`).
- Output container is inside an iframe/shadow root and needs custom handling.

### 401 Unauthorized

- `DR_BRIDGE_TOKEN` is set on server but not provided in userscript/UI.
- Token mismatch between server and client.

### Bridge looks healthy but agent feels blind

- Output payload may be too broad/noisy; tighten output selector to the real text stream.
- Increase polling interval slightly if the game client throttles events.

## Security notes

- Bridge binds to loopback only (`127.0.0.1`).
- Keep token enabled when possible.
- Do not expose bridge endpoints publicly.

## Next hardening step (recommended)

Add a small game-client-specific selector profile for your exact DragonRealms UI so setup is one-click for your browser/client combination.
