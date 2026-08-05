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
    ├── SessionManager persistence
    └── project files, Git changes, plans, and terminal projection
```

## Packages

- `@suocode/runtime-protocol` defines commands, responses, events, messages, sessions, plans, changes, terminal runs, and file-tree data.
- `@suocode/runtime-core` owns model configuration, Pi session creation, workflow loading, event translation, session persistence, and project inspection.
- `@suocode/runtime-server` exposes the core over Node process IPC for Desktop and strict JSONL over stdin/stdout for integrations.
- `@suocode/workflow` contains the SuoCode-specific Pi extensions. The runtime loads these paths explicitly and does not depend on user-installed extensions.

## Desktop isolation

The renderer runs with `contextIsolation`, Chromium sandboxing, and Node integration disabled. It can select a project through Electron main and send only typed runtime commands through the preload bridge. The Agent loop and credentials never run in the renderer.

## Runtime ownership

Desktop starts the runtime with dedicated Agent and session directories inside the platform application-data location. CLI uses `~/.suocode` unless `SUOCODE_DATA_DIR` is set. On first use, SuoCode may copy compatible authentication, model, and selected default settings from `~/.pi/agent`; after migration, SuoCode owns its copy and Pi is not a runtime dependency.

Each project session uses Pi's `SessionManager`. The runtime translates Pi message and tool events into stable SuoCode events, reconstructs tool/plan/terminal state when a session is reopened, and refreshes Git and file state after mutations.

## Pi thin fork

Pi is committed under `vendor/pi` through Git subtree. SuoCode builds against that local source so desktop releases are reproducible and debuggable. Product-specific behavior remains outside the fork unless Pi's public SDK cannot provide a required runtime capability.
