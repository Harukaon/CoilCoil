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

Product Terminal sessions are also owned by Electron main. The renderer receives only typed create/write/resize/close events and renders the stream through xterm. PTYs remain alive while the user switches between Agent conversations, projects, and the Terminal workspace; closing a tab is the explicit process-termination action. A bounded main-process buffer restores terminal content after a renderer remount. Full application exit terminates PTYs and does not pretend they can be reattached after restart.

The Terminal workspace reuses the proven xterm/FitAddon design from the user-owned `shelf` project, while replacing its Tauri invocation layer with SuoCode's Electron `node-pty` manager. Claude Code and Codex are launched through the user's login shell. The Pi button resolves the CLI shipped in the SuoCode package, passes SuoCode's private Agent directory, and explicitly loads the same bundled workflow, MCP, Todo, terminal, and subagent extensions as the GUI runtime.

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

When `pi-mcp-adapter` is reloading, its native `not_initialized` or `init_failed` result is projected as “初始化中” or “暂不可用”. SuoCode does not mistake that lifecycle state for a new MCP schema and does not fall back to a second protocol implementation.

MCP enable/disable uses the adapter's native `disabled` field and project override writer. Tool, resource, connection, and disabled counts come from the adapter's stable `pi-mcp-adapter/status/v1` event. The Desktop does not infer these states by opening its own MCP connection.

The Desktop logout control invokes the adapter's existing `/mcp logout <server>` command through the same event bridge. SuoCode does not delete or reinterpret the adapter's credential store itself.

Sensitive MCP environment and header values remain in the adapter-compatible configuration, but the editor renders sensitive keys as masks and preserves the stored value when the mask is left untouched. Adapter diagnostics are recursively redacted in Runtime Core before crossing the Desktop IPC boundary.

This rule also applies to future capabilities: configuration screens, previews, dashboards, and controls are product UI, while the corresponding Agent behavior should remain an extension whenever a suitable extension exists. A Desktop-facing bridge may expose extension events and commands, but it must not duplicate the extension's protocol client, lifecycle manager, credential store, or tool implementation.

Every new Agent-facing requirement must pass an extension-reuse review before implementation begins:

1. Check Pi core and the extensions already bundled by SuoCode for the capability.
2. Check maintained third-party Pi extensions when the bundled set does not provide it.
3. Record which extension owns execution, configuration, lifecycle, persistence, cancellation, and diagnostics.
4. Design the Desktop work as configuration, visualization, and control surfaces over that owner.
5. Document any missing headless event or command as a thin adapter/fork requirement instead of silently creating a parallel implementation.

This review applies equally to MCP, subagents, Todo, skills, memory, approvals, browser automation, background jobs, and future Agent tools.

Bundled extensions are still part of the SuoCode runtime distribution. Extension-first does not mean loading packages from the user's local Pi installation.

## Pi thin fork

Pi is committed under `vendor/pi` through Git subtree. SuoCode builds against that local source so desktop releases are reproducible and debuggable. Product-specific behavior remains outside the fork unless Pi's public SDK cannot provide a required runtime capability.
