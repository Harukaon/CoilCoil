# SuoCode

SuoCode is a self-contained coding Agent product built on an embedded Pi runtime. It ships as a desktop application and a terminal application; both use the same runtime, sessions, tools, and SuoCode workflow.

SuoCode Desktop does not require a user-installed Pi. The application starts its bundled runtime in an isolated child process and communicates with it through a typed IPC protocol.

## Products

- **SuoCode Desktop** — a three-pane Agent workspace with projects and sessions on the left, the live Agent conversation in the center, and project files on the right.
- **SuoCode CLI** — a terminal Agent using the same model configuration, session system, tools, and workflow.

## Included capabilities

- Streaming Agent responses, reasoning, tool calls, steering, and cancellation
- Persistent project-scoped conversations that survive application restarts
- Model/provider selection and API-key configuration
- SuoCode-owned `OpenAI Response (WS)` Pi extension for ordinary proxy keys and persistent WebSocket transport
- Project tools for reading, searching, editing, writing, and running commands
- Bundled `pi-mcp-adapter` with SuoCode-owned GUI configuration, plus SuoCode's own subagent engine and typed runtime activity events
- `/goal <目标>` goal mode: an Agent loop that keeps working through errors until it calls the goal-completion tool or the user stops it
- Structured todo plans, Git changes and patches, terminal output, and project file previews
- SuoCode's bundled Simplified Chinese workflow, policies, project memory, and terminal support
- Explicit development-only migration support for an existing Pi model configuration

## Repository layout

```text
SuoCode/
├── apps/
│   ├── cli/                  # SuoCode terminal application
│   └── desktop/              # Electron + React desktop application
├── packages/
│   ├── runtime-core/         # Pi session and project runtime
│   ├── runtime-protocol/     # Shared command/event contracts
│   ├── runtime-server/       # Process IPC and JSONL transports
│   └── workflow/             # SuoCode tools, policies, and defaults
├── vendor/pi/                # Traceable thin fork of Pi
├── scripts/                  # End-to-end runtime smoke tests
└── docs/                     # Architecture and upstream maintenance
```

See [the runtime architecture](docs/architecture.md), [the multi-Agent development guide](docs/multi-agent-development.md), [the current Desktop bug list](docs/desktop-bugs-2026-08-07.md), [the product roadmap](docs/product-roadmap-2026-08-07.md), and [Pi upstream maintenance](docs/pi-upstream.md) for implementation details.

## Setup

SuoCode requires Node.js 22.19 or newer. From a clean checkout:

```bash
npm run setup
```

This installs Pi and product dependencies, builds the vendored Pi packages, and prepares Electron and native terminal modules.

## Run

Start the desktop application:

```bash
npm run dev
```

Start the CLI for a project:

```bash
npm run cli -- /absolute/path/to/project
```

The CLI can also receive an initial model configuration:

```bash
SUOCODE_API_KEY=your-key npm run cli -- /path/to/project \
  --provider anthropic --model claude-sonnet-4-5
```

## Verify

```bash
npm run check
npm test
npm run smoke
npm run package:desktop
npm run smoke:desktop
```

`npm run smoke:live` performs a real provider request and a real Agent tool call in a disposable temporary project.
`npm run smoke:desktop:live` launches the packaged application and verifies a real GUI-driven Agent run across Plan, Changes, Terminal, Files, and session restoration.

## Package Desktop

```bash
npm run package:desktop
```

Installers and archives are written to `apps/desktop/release/`. The macOS build produces both DMG and ZIP artifacts; Linux is configured as AppImage.

### Windows

Windows builds NSIS installers for x64 and arm64 plus an x64 ZIP:

```bash
npm run build:pi
npm run build --workspace @suocode/openai-responses-ws
npm run build --workspace @suocode/desktop
npm --prefix apps/desktop exec electron-builder -- --win
```

`node-pty` is the only native dependency and is built with Node-API, so its
shipped `prebuilds/win32-*` binaries load unchanged under Electron. The build
therefore sets `npmRebuild: false`: `@electron/rebuild` would otherwise try to
compile it from source and fail, because node-gyp cannot cross-compile. Host
native modules are prepared by `npm run setup` instead.

Cross-building the ZIP from macOS or Linux works as-is. The NSIS installers
additionally need Wine on a non-Windows host; without it, run the command above
on Windows.

## Product data

Desktop credentials, settings, MCP configuration, project memory, and sessions live under Electron's platform-specific application-data directory. CLI data defaults to `~/.suocode` and can be redirected with `SUOCODE_DATA_DIR`. SuoCode never loads the user's global Pi packages or executable at runtime.
