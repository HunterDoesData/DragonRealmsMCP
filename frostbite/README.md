Frostbite
=========

### Description

MUD client for dragonrealms.

### User guide
[https://matoom.github.io/frostbite/](https://matoom.github.io/frostbite/)

### Local AI bridge + internal MCP (optional)

Frostbite can stream game output to a local bridge, optionally consume queued commands, and optionally start the DragonRealms MCP server internally.

1. In Frostbite open `Tools -> Script settings -> AI`.
2. Configure:
	- `Run MCP server internally` (enabled)
	- `LLM provider` (`openai` or `anthropic`)
	- matching API key
	- `MCP server entry` (typically `/.../DragonRealmsMCP/dist/index.js`)
	- `Node executable` (usually `node`)
3. Ensure `AiBridge` settings point at your local bridge port (default now `3989`).

You can also edit `Frostbite.app/Contents/MacOS/client.ini` directly:

```ini
[AiBridge]
enabled=true
baseUrl=http://127.0.0.1:3989
token=
sendOutput=true
consumeCommands=false
pollIntervalMs=1200
runInternalMcp=true
llmProvider=openai
openAiApiKey=
anthropicApiKey=
mcpEntryPath=
nodeExecutable=node
```

Recommended secret handling:
- Keep `openAiApiKey` and `anthropicApiKey` blank in repository-tracked files.
- Set keys only on your local machine via `Tools -> Script settings -> AI`.
- If you use manual file edits, store secrets in a local-only file such as `baseclient/client.local.ini` or `Frostbite.app/Contents/MacOS/client.local.ini` and keep those files out of git.

Safety defaults:
- `consumeCommands=false` means AI cannot execute commands in Frostbite.
- Set `consumeCommands=true` only when you want queued commands auto-applied.
- If you configured `DR_BRIDGE_TOKEN`, set the same value in `AiBridge/token`.
- On settings apply, Frostbite reloads AI bridge settings and starts/stops the internal MCP process.

### In-game AI prompt command

You can ask the configured provider directly from the game command line:

```text
/ai <your prompt>
```

Additional in-game commands:

```text
/aimodel
/aihelp
/aiwiki <topic>
/aiobserve on|off|status
/aipending
/aiapprove [id]
/aireject [id]
```

- Example: `/ai summarize this room and suggest the safest next command`
- Frostbite sends the prompt to the provider selected in `Script settings -> AI` using the matching configured API key.
- The response is printed in the main window prefixed with `[AI]`.
- `/ai` now includes recent in-game output context automatically so the coach can see current game state.
- The assistant is constrained with a DragonRealms-only coaching system prompt and refuses non-DragonRealms requests.
- The assistant can propose executable commands using `CMD:`; commands are queued for explicit player approval via `/aiapprove`.
- Observer mode allows periodic proactive coaching based on live prompt/output updates.
- `/aiwiki` pulls Elanthipedia API content directly inside Frostbite for game-specific learning support.

### License

MIT