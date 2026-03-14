# DragonRealms MCP Server

Local MCP server for DragonRealms that provides:

- **Elanthipedia tools** for searching and reading game knowledge.
- **Browser I/O bridge** so MCP tools can send commands to your web game client and ingest output.

## Features

### Elanthipedia

- `elanthipedia_search`: Search Elanthipedia by keyword.
- `elanthipedia_page`: Fetch and clean page text by title or URL.
- `get_skill`: Fetch a DragonRealms skill page by skill name.
- `get_guild_skills`: Return guild-specific skills for a guild.

### DragonRealms Browser Bridge

- `dr_send_command`: Queue a command for the browser client.
- `dr_propose_command`: Propose a command for UI approval before execution.
- `dr_get_proposals`: List proposed commands by status.
- `dr_get_output`: Read recent captured output lines.
- `dr_clear_output`: Clear buffered output.
- `dr_bridge_status`: Check bridge health and endpoint details.

### Agent Control UI (mac/local)

- React UI in `ui/` for live bridge telemetry and command approvals.
- Shows output feed, pending proposal queue, queued commands, and health counters.
- Supports approve/reject via local bridge endpoints.

## Quick Start

1. Install dependencies:

   ```bash
   npm install
   ```

2. (Optional) set bridge env vars:

   ```bash
   cp .env.example .env
   ```

3. Build:

   ```bash
   npm run build
   ```

4. Run server (stdio for MCP host + local HTTP bridge):

   ```bash
   npm run start
   ```

The bridge listens on `http://127.0.0.1:3989` by default.

## Control Panel UI

1. Install UI dependencies:

  ```bash
  cd ui && npm install
  ```

2. Start the UI:

  ```bash
  npm run ui:dev
  ```

3. Open the local URL printed by Vite (usually `http://127.0.0.1:5173`).

If you use `DR_BRIDGE_TOKEN`, enter the same value in the UI token field.

## MCP Host Configuration

Example local MCP config entry:

```json
{
  "mcpServers": {
    "dragonrealms": {
      "command": "node",
      "args": ["/absolute/path/to/DragonRealmsMCP/dist/index.js"],
      "env": {
        "DR_BRIDGE_PORT": "3989"
      }
    }
  }
}
```

## Browser Integration

1. Install a userscript manager (Tampermonkey or Violentmonkey).
2. Create a script from `examples/dragonrealms-bridge.user.js`.
3. On the game page, press `Alt+Shift+I` and click command input, then `Alt+Shift+O` and click output panel.
4. If you set `DR_BRIDGE_TOKEN`, also set `TOKEN` in the userscript.

The userscript polls `/io/commands` and posts output to `/io/output`.

For a full macOS setup walkthrough, see `docs/CONNECTING_TO_DRAGONREALMS.md`.

## Local Bridge API for UI/Agents

- `GET /health`
- `GET /io/output?limit=200`
- `DELETE /io/output`
- `POST /io/commands` with `{ "command": "look" }`
- `GET /io/commands/pending`
- `POST /agent/proposals` with `{ "command": "hunt", "reason": "train" }`
- `GET /agent/proposals?status=pending`
- `POST /agent/proposals/:id/approve`
- `POST /agent/proposals/:id/reject`

## Notes

- Bridge endpoint binds to loopback (`127.0.0.1`) only.
- Keep the userscript and MCP server running at the same time.
- Tune polling intervals/selectors based on your game client behavior.
