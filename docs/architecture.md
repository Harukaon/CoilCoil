# Runtime architecture

CoilCoil keeps the UI, process transport, Agent runtime, workflow, and Pi source as separate layers.

```text
React renderer
    │ typed Electron IPC
Electron main + sandboxed preload
    │ process IPC
Bundled CoilCoil runtime
    ├── runtime protocol and server
    ├── Pi AgentSession + ModelRuntime
    ├── CoilCoil workflow extensions (tools, policies, subagents)
    ├── bundled MCP extension
    ├── SessionManager persistence
    └── project files, Git changes, plans, and terminal projection
```

## Packages

- `@coilcoil/runtime-protocol` defines commands, responses, events, messages, sessions, plans, changes, terminal runs, and file-tree data.
- `@coilcoil/runtime-core` owns model configuration, Pi session creation, workflow loading, event translation, session persistence, and project inspection.
- `@coilcoil/runtime-server` exposes the core over Node process IPC for Desktop and strict JSONL over stdin/stdout for integrations.
- `@coilcoil/workflow` contains the CoilCoil-specific Pi extensions, including CoilCoil's own subagent extension. The runtime explicitly loads it together with the pinned `pi-mcp-adapter` release; it never reads the package list from the user's Pi settings.

## Desktop isolation

The renderer runs with `contextIsolation`, Chromium sandboxing, and Node integration disabled. It can select a project through Electron main and send only typed runtime commands through the preload bridge. The Agent loop and credentials never run in the renderer.

## Runtime ownership

Desktop starts the runtime with dedicated Agent and session directories inside the platform application-data location. CLI uses `~/.coilcoil` unless `COILCOIL_DATA_DIR` is set. The product does not implicitly read `~/.pi/agent`; credentials and model settings belong to CoilCoil's own data directory. An explicit `COILCOIL_LEGACY_AGENT_DIR` is retained only for controlled development migration and tests.

Desktop owns exactly one long-lived Runtime operating-system process. That process contains one control runtime plus an in-process map of independently addressable Pi `AgentSession` contexts. Each conversation keeps its own event bus, tools, Todo, subagents, streaming state, and persisted session path, while all conversations share the same initialized `ModelRuntime`. Selecting another conversation changes only the renderer's visible `runtimeId`; it does not abort, dispose, or pause the previously selected Agent. Reopening an already loaded conversation returns its current in-memory snapshot instead of creating another process or rebuilding its extensions.

Workspace opening keeps only session construction and the root file listing on the response path. Git inspection, asynchronous subagent restoration, and session-list refresh run after the first snapshot. The Runtime process also begins model initialization as soon as it starts, before the renderer requests the active workspace.

Subagents run as child Pi `AgentSession`s inside CoilCoil's private Runtime process; they never discover or invoke a `pi` executable from the user's shell `PATH`. Background project-memory workers use CoilCoil's bundled runtime executable. MCP uses CoilCoil's own Agent directory plus standard/project MCP configuration files; secrets are never copied into the repository or installation image.

Project memory remains owned by the bundled `project-memory` Pi extension. Once a foreground Agent request emits `agent_settled`, the extension starts the isolated bundled memory worker and returns without blocking the conversation UI. The worker summarizes the persisted session into the project-scoped memory directory. Later requests in the same project receive that memory through `before_agent_start`; Desktop does not maintain a second memory database or depend on the user's local Pi installation.

Each project session uses Pi's `SessionManager`. The runtime translates Pi message and tool events into stable CoilCoil events, reconstructs tool/plan/terminal state when a session is reopened, and refreshes Git and file state after mutations.

## Extension-first product architecture

CoilCoil follows an extension-first rule: when a mature Pi extension already implements a capability, the product bundles and reuses that extension, then adds a GUI control and visualization layer around it. CoilCoil must not build a second competing implementation merely because the original extension exposes a TUI-first experience.

The preferred order is:

1. Bundle a pinned, reviewed Pi extension inside CoilCoil.
2. Use the extension's existing configuration format, runtime behavior, lifecycle, and tool implementation.
3. Project its state and events through a thin typed bridge for the Desktop UI.
4. Provide GUI configuration, status, preview, cancellation, and diagnostics without moving core behavior into the renderer.
5. If a stable headless API is missing, add the smallest possible public API to the extension or maintain a thin patch while proposing the change upstream.
6. Reimplement the capability in CoilCoil only when no suitable extension exists or the extension cannot satisfy product safety and lifecycle requirements.

Examples:

- MCP reuses `pi-mcp-adapter`; CoilCoil only adds configuration and status UI.
- Subagents run in CoilCoil's own extension, which executes child AgentSessions in-process and publishes typed activity events plus an RPC channel for stop/status/resume. Runtime Core consumes that contract; the dedicated Desktop cards, execution details, and controls will be rebuilt against the stable CoilCoil protocol instead of extension-internal types.
- Todo and workflow tools remain Pi extensions; the activity panel visualizes their structured state.

When `pi-mcp-adapter` is reloading, its native `not_initialized` or `init_failed` result is projected as “初始化中” or “暂不可用”. CoilCoil does not mistake that lifecycle state for a new MCP schema and does not fall back to a second protocol implementation.

MCP enable/disable uses the adapter's native `disabled` field and project override writer. Tool, resource, connection, and disabled counts come from the adapter's stable `pi-mcp-adapter/status/v1` event. The Desktop does not infer these states by opening its own MCP connection.

The Desktop logout control invokes the adapter's existing `/mcp logout <server>` command through the same event bridge. CoilCoil does not delete or reinterpret the adapter's credential store itself.

Sensitive MCP environment and header values remain in the adapter-compatible configuration, but the editor renders sensitive keys as masks and preserves the stored value when the mask is left untouched. Adapter diagnostics are recursively redacted in Runtime Core before crossing the Desktop IPC boundary.

This rule also applies to future capabilities: configuration screens, previews, dashboards, and controls are product UI, while the corresponding Agent behavior should remain an extension whenever a suitable extension exists. A Desktop-facing bridge may expose extension events and commands, but it must not duplicate the extension's protocol client, lifecycle manager, credential store, or tool implementation.

Every new Agent-facing requirement must pass an extension-reuse review before implementation begins:

1. Check Pi core and the extensions already bundled by CoilCoil for the capability.
2. Check maintained third-party Pi extensions when the bundled set does not provide it.
3. Record which extension owns execution, configuration, lifecycle, persistence, cancellation, and diagnostics.
4. Design the Desktop work as configuration, visualization, and control surfaces over that owner.
5. Document any missing headless event or command as a thin adapter/fork requirement instead of silently creating a parallel implementation.

This review applies equally to MCP, subagents, Todo, skills, memory, approvals, browser automation, background jobs, and future Agent tools.

Bundled extensions are still part of the CoilCoil runtime distribution. Extension-first does not mean loading packages from the user's local Pi installation.

## Pi thin fork

Pi is committed under `vendor/pi` through Git subtree. CoilCoil builds against that local source so desktop releases are reproducible and debuggable. Product-specific behavior remains outside the fork unless Pi's public SDK cannot provide a required runtime capability.
