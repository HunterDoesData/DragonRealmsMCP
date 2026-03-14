# AGENT.md

## Purpose
This repository combines two related systems:

1. **DragonRealms MCP server** (TypeScript, root project) for Elanthipedia tools + local bridge I/O.
2. **Frostbite client** (Qt/C++, in `frostbite/`) with AI bridge and internal MCP integration.

When making changes, prefer minimal, targeted edits and validate only the affected area.

## Repository Map
- `src/` — MCP server source (TypeScript).
- `ui/` — local React/Vite control panel for bridge telemetry and approvals.
- `frostbite/` — vendored Frostbite source (Qt/C++ desktop client).
- `docs/` and `examples/` — setup docs and userscript integration examples.
- `.env` — local runtime secrets/config (must remain untracked).

## Core Workflows
### MCP server (root)
- Install: `npm install`
- Build: `npm run build`
- Dev run: `npm run dev`
- Run built server: `npm run start`

### UI
- Dev: `npm run ui:dev`
- Build: `npm run ui:build`

### Frostbite (macOS)
- Build: `cd frostbite/gui && qmake gui.pro && make -j4`
- Run app: `cd frostbite && ./Frostbite.app/Contents/MacOS/Frostbite`

## Frostbite Packaging Note
`frostbite/gui/gui.pro` now removes existing `Frostbite.dmg` before `macdeployqt -dmg` so repeat builds do not fail with `hdiutil: create failed - File exists`.

## Change Strategy
1. Identify which subsystem is affected (`src/`, `ui/`, or `frostbite/`).
2. Make the smallest possible fix at the root cause.
3. Avoid unrelated refactors in mixed-language sessions.
4. Validate with the narrowest useful command first, then broader build if needed.

## Validation Expectations
- TypeScript-only change: run `npm run build`.
- UI-only change: run `npm run ui:build` (or `npm run ui:dev` for behavior checks).
- Frostbite C++ change: run `qmake gui.pro && make -j4` in `frostbite/gui`.

## Secrets and Safety
- Never commit real API keys or tokens.
- Keep secrets in local-only files (`.env`, local INI overrides); tracked INI files should keep API key fields blank.
- Treat any leaked key in terminal/chat history as compromised; rotate immediately.
- Bridge endpoints bind to `127.0.0.1`; preserve loopback-only behavior unless explicitly requested.

## Agent Guardrails
- Respect existing architecture and style in each subsystem.
- Keep repo hygiene: do not add generated binaries, app bundles, PSD/PEM extras, or build artifacts unless explicitly requested.
- If touching both MCP and Frostbite in one task, separate concerns clearly and report validation per subsystem.
- Do not create commits/branches unless explicitly asked.

## Quick Triage Hints
- MCP build/runtime issues: check `package.json` scripts and `src/index.ts` entry behavior.
- UI issues: check `ui/package.json` scripts and Vite/React config.
- Frostbite nav/AI behavior: inspect `frostbite/gui/mainwindow.*`, `frostbite/gui/maps/*`, and `frostbite/gui/aibridgeservice.*`.
