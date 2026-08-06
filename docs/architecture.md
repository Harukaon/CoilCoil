# Runtime architecture

SuoCode keeps the UI, process transport, Agent runtime, workflow, and Pi source as separate layers.

```text
React renderer
    │ typed Electron IPC
Electron main + sandboxed preload
    │ process IPC
Bundled SuoCode runtime
    ├── runtime protocol and server
    ├── Pi AgentSession + ModelRuntime
    ├── SuoCode workflow extensions
    ├── bundled MCP and subagent extensions
    ├── SessionManager persistence
    └── project files, Git changes, plans, and terminal projection
```

## Packages

- `@suocode/runtime-protocol` defines commands, responses, events, messages, sessions, plans, changes, terminal runs, and file-tree data.
- `@suocode/runtime-core` owns model configuration, Pi session creation, workflow loading, event translation, session persistence, and project inspection.
- `@suocode/runtime-server` exposes the core over Node process IPC for Desktop and strict JSONL over stdin/stdout for integrations.
- `@suocode/workflow` contains the SuoCode-specific Pi extensions. The runtime explicitly loads it together with pinned `pi-mcp-adapter` and `pi-subagents` releases; it never reads the package list from the user's Pi settings.

## Desktop isolation

The renderer runs with `contextIsolation`, Chromium sandboxing, and Node integration disabled. It can select a project through Electron main and send only typed runtime commands through the preload bridge. The Agent loop and credentials never run in the renderer.

## Runtime ownership

Desktop starts the runtime with dedicated Agent and session directories inside the platform application-data location. CLI uses `~/.suocode` unless `SUOCODE_DATA_DIR` is set. The product does not implicitly read `~/.pi/agent`; credentials and model settings belong to SuoCode's own data directory. An explicit `SUOCODE_LEGACY_AGENT_DIR` is retained only for controlled development migration and tests.

Subagents and background memory workers launch the Pi CLI shipped inside SuoCode using the current runtime executable. They do not discover or invoke a `pi` executable from the user's shell `PATH`. MCP uses SuoCode's own Agent directory plus standard/project MCP configuration files; secrets are never copied into the repository or installation image.

Each project session uses Pi's `SessionManager`. The runtime translates Pi message and tool events into stable SuoCode events, reconstructs tool/plan/terminal state when a session is reopened, and refreshes Git and file state after mutations.

## Extension-first product architecture

SuoCode follows an extension-first rule: when a mature Pi extension already implements a capability, the product bundles and reuses that extension, then adds a GUI control and visualization layer around it. SuoCode must not build a second competing implementation merely because the original extension exposes a TUI-first experience.

The preferred order is:

1. Bundle a pinned, reviewed Pi extension inside SuoCode.
2. Use the extension's existing configuration format, runtime behavior, lifecycle, and tool implementation.
3. Project its state and events through a thin typed bridge for the Desktop UI.
4. Provide GUI configuration, status, preview, cancellation, and diagnostics without moving core behavior into the renderer.
5. If a stable headless API is missing, add the smallest possible public API to the extension or maintain a thin patch while proposing the change upstream.
6. Reimplement the capability in SuoCode only when no suitable extension exists or the extension cannot satisfy product safety and lifecycle requirements.

Examples:

- MCP reuses `pi-mcp-adapter`; SuoCode only adds configuration and status UI.
- Subagents reuse `pi-subagents`; SuoCode adds activity cards, execution details, and stop controls by projecting the extension's lifecycle.
- Todo and workflow tools remain Pi extensions; the activity panel visualizes their structured state.

Bundled extensions are still part of the SuoCode runtime distribution. Extension-first does not mean loading packages from the user's local Pi installation.

## Pi thin fork

Pi is committed under `vendor/pi` through Git subtree. SuoCode builds against that local source so desktop releases are reproducible and debuggable. Product-specific behavior remains outside the fork unless Pi's public SDK cannot provide a required runtime capability.
