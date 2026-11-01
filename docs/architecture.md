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

Desktop owns exactly one long-lived Runtime operating-system process. That process contains one control runtime plus an in-process map of independently addressable Pi `AgentSession` contexts. Each conversation keeps its own event bus, tools, subagents, streaming state, and persisted session path, while all conversations share the same initialized `ModelRuntime`. Selecting another conversation changes only the renderer's visible `runtimeId`; it does not abort, dispose, or pause the previously selected Agent. Reopening an already loaded conversation returns its current in-memory snapshot instead of creating another process or rebuilding its extensions.

The workflow's runtime bridge saves the final system prompt before the first turn. That session-owned snapshot includes initial memory, Skill metadata and archive instructions, survives reload and resume, and is reused after compaction. Later memory and background resource changes apply to new conversations. Explicit user MCP tool changes still reload after the session becomes idle and may rebuild the tool cache. Prompt and Skill controls remain editable until the first turn; afterward the runtime rejects changes and the inspector is read-only. Normal conversation growth appends messages; compaction and explicit rewind remain the supported ways to change the active history projection.

The session request policy runs the shared workflow cache controller against the final Anthropic payload. Its default policy budgets up to four cache points and leaves one-use summary instructions outside cache writes; caller-owned mixed TTL, scope and automatic policies pass through unchanged. Shared summaries validate both their wire prefix and transport headers before HTTP dispatch. A compact session ledger persists usage, prefix hashes and miss causes without model-visible messages, including cold summary fallbacks. Goal completion keeps a stable schema, late MCP discovery cannot rewrite a started prefix or stall the first turn, and Read deduplication requires a visible identical result and a meaningful size reduction. MCP tool definitions and disclosed schemas persist with the conversation and replay on resume. Global system partitioning and Claude's gated cache-touch protocol are not implemented. See [compaction.md](compaction.md#断点规划与缓存账本) and the [audit](claude-code-cache/suocode-audit.md) for the precise differences and remaining limits.

Workspace opening keeps only session construction and the root file listing on the response path. Git inspection, asynchronous subagent restoration, and session-list refresh run after the first snapshot. The Runtime process also begins model initialization as soon as it starts, before the renderer requests the active workspace.

Subagents run as child Pi `AgentSession`s inside CoilCoil's private Runtime process; they never discover or invoke a `pi` executable from the user's shell `PATH`. Background project-memory workers use CoilCoil's bundled runtime executable. MCP uses CoilCoil's own Agent directory plus standard/project MCP configuration files; secrets are never copied into the repository or installation image.

Project memory remains owned by the bundled `project-memory` Pi extension. Each foreground `agent_settled` only advances a persisted per-project turn counter; when it reaches the configured interval (30 turns by default) the extension starts the isolated bundled memory worker and returns without blocking the conversation UI. The worker summarizes the persisted session into the project-scoped memory directory, keeping `MEMORY.md` as an index over one file per memory under `memories/`. A new conversation captures that index in its initial prompt; later memory edits do not change an existing conversation's system prompt. Individual bodies remain readable on demand. Desktop does not maintain a second memory database or depend on the user's local Pi installation.

Each project session uses Pi's `SessionManager`. The runtime translates Pi message and tool events into stable CoilCoil events, reconstructs tool/plan/terminal state when a session is reopened, and refreshes Git and file state after mutations.

## Concurrent actions and failure contracts

Opening a conversation creates a bounded restoration window in the renderer. Events for that conversation wait until the authoritative snapshot arrives, then only newer revisions replay. A timeout or overflow ends restoration with an explicit error. Navigation epochs prevent late open/create results from selecting a conversation after the user has selected another one. Steering and rejection events invalidate the server snapshot cache.

Runtime commands pin their session against idle eviction until the command finishes. Session and workspace mutations reject busy sessions and hold path locks while closing writers and changing files; shutdown rejects new work and disposes sessions whose initialization finishes late.

A foreground terminal remains owned by the current Agent activity when its initial wait expires and it continues in the background. Aborting that activity stops those terminals and suppresses their pending completion notifications. Explicit background services retain their independent lifetime. Unix process cleanup checks recorded process identity and parent ancestry before signalling; a reused terminal device or PID alone never establishes ownership. Cleanup failures remain visible as failed terminal state.

Missing application-owned MCP files mean first use. Malformed or unreadable existing files are errors and must not become empty configuration before a write. Provider removal requires credential deletion to succeed. File rewind snapshots every affected current file before writing, rejects changed symlink targets, and rolls back partial writes or cancelled navigation; rollback errors propagate with the original failure. These are error contracts, not best-effort success paths.

Extension hook failures reach the runtime diagnostic log and the owning active conversation's error channel, including after extension reload. Late failures from a retired session remain in its diagnostics without appearing in the new session. Failed session initialization preserves its original error and separately logs any cleanup failure with its runtime ID.

### Regression verification, 2026-10-28

The final workspace suites pass 1,614 tests with no failures or skips: Desktop 661, CLI 2, diagnostics 10, MCP 105, runtime-core 343, runtime-protocol 14, runtime-server 61, OpenAI Responses WebSocket 7, and workflow 411. `npm run check` and the Desktop production build pass. The full workspace run passed 1,613 tests; one additional terminal startup regression was then added, followed by the complete 411-test workflow suite and the real AgentSession abort integration. Tests use temporary projects, local MCP fixtures and simulated model HTTP responses.

- `node scripts/renderer-session-restore-smoke.mjs` mounts the real App and conversation/composer components. Actual DOM clicks exercise steering, switching away and back, a newer delta arriving before the full snapshot, continued output, and Stop. It reports no page errors or external requests. The reducer suite also checks 200 fixed-seed snapshot/delta interleavings.
- Terminal tests execute real PTYs, exercise cross-process-group descendants, graceful/forced cleanup, reused TTYs and startup cancellation. A real AgentSession abort stops a command that has already returned a background result without issuing another model request.
- Configuration tests inject malformed files and real filesystem permission failures. Goal stop tests verify that a journal write failure still publishes the actual stopped state and reports the write error.
- Runtime tests cover concurrent initialization, eviction, shutdown and session/workspace mutations. Git and rewind tests use temporary repositories, literal special-character filenames, redirected parent symlinks, partial writes and failed rollback.

The verified source was packaged and installed on macOS as `0.1.0-beta.163.local.20261028.3`. The installed app launched successfully, signature and DMG/ZIP integrity checks passed, and packaged MCP background/window and browser-isolation smoke tests passed. All 840 existing files across the primary and legacy session directories retained their SHA-256 hashes. The previous `.2` application and its DMG/ZIP/blockmaps were removed after verification.

## Background monitors and suspended agent loops

Long-running commands use process events to resume the agent. `bash` has a short foreground window (at most one second); an unfinished command stays in its managed terminal and reports completion asynchronously. `terminal await` creates an exit or literal-output subscription and returns immediately with Pi's existing `terminate: true` result. It does not wait for a model-selected duration. The retained `timeoutMs` input is ignored for `await`; hard process lifetimes and Stop cleanup deadlines are separate controls. Pi terminates when all finalized results in a tool batch request termination, so the tools direct the model to call a suspending monitor alone; mixed batches can finish their independent work before settling.

The `monitor` tool can observe an existing terminal or start a watcher command. By default it suspends the model loop; `suspend: false` allows independent work, followed by `monitor wait` when only the background result remains. Watcher stdout produces complete-line events, coalesced over 200ms; stderr is written to its own file. Recurring output is bounded, and an excessively noisy watcher is stopped. A new watcher command has a five-minute default safety lifetime, configurable up to thirty minutes; an existing terminal subscription follows that process and session's lifecycle.

`terminal/monitor.ts` owns subscriptions, event sequencing, bounded results, and wait-any state. `terminal/notify.ts` batches notifications, preserves incremental monitor output while the agent is busy, and consumes already-returned events without a second wake-up. A delivered event releases the waiting state before `sendMessage(..., {triggerTurn: true})` resumes the same session. Events are appended as task data and do not change system prompts or earlier messages.

Goal stops scheduling rounds while a monitor owns the wait. Clearing the wait alone does not schedule another round: a real resumed request must run first, including events delivered as steering into an existing run. Child AgentSessions retain their lifecycle across suspension and complete only after the resumed run settles. Their cancellation closes their own monitors and processes. These controls use the existing Pi extension/event interfaces; the feature does not patch the vendor agent loop.

The runtime projects `backgroundWait` separately from `running`, so idle monitoring does not masquerade as an active model request or queue new user input. Desktop shows the wait, permits a new message, and keeps a cancellation button available. Stop synchronously revokes subscriptions and queued notifications before awaiting owned watcher cleanup. Cancelling a subscription to an existing service leaves that service running; stopping the terminal explicitly stops its process. Session shutdown removes every subscription and cleans managed processes. Failed wake-ups and cleanup failures are surfaced.

The implementation was compared with the [Claude Code Monitor reference](https://code.claude.com/docs/en/tools-reference#monitor-tool) and actual Orb Monitor calls; the source evidence is recorded in [claude-monitor-20261031.json](claude-code-cache/evidence/claude-monitor-20261031.json). Claude's monitor lifetime timeout also remains distinct from blocking an agent for a result.

Verification on 2026-10-31: all **1,703 workspace tests** pass with no skips or failures; workspace type/architecture checks and the Desktop production build pass. Real Runtime/AgentSession tests use local simulated model streams and file-triggered watcher processes to verify one request, idle suspension, then exactly one resumed request. The real React App DOM smoke verifies the monitor status, available composer, session switching and idle cancellation, with no external requests or page errors. Waiting status travels through a synchronous `background_wait_updated` event, so it cannot overwrite a newer running/aborting state with a delayed full snapshot. [Verification evidence](claude-code-cache/evidence/monitor-verification-20261031.json) records the logs and scenarios. This verification updates source and build output; it does not replace the installed macOS application.

## Unified browser and workspace memory curation

The agent sees one `browser` tool. `list` returns common operations without a browser connection; `tools` discovers operation descriptions and, when given a name, that operation's input schema; `call` validates the arguments and executes it. Common operations retain the managed page handles and snapshots. Additional built-in browser MCP operations are exposed under `devtools.*` through the same gateway. The agent-facing `mcp` gateway excludes this server, while the external local MCP CLI retains its existing access. Child agents remain unable to control the shared desktop browser.

Each conversation permits eight total browser tabs. Creation reserves capacity synchronously, including concurrent CDP/MCP and UI requests; exceeding the limit returns an error asking the caller to reuse or close an existing page. Ordinary pages are never evicted to make room. When an Agent turn settles, untouched Agent-owned blank pages are cleaned up only after loading ends and a DOM check confirms they have no content. User pages and new navigation remain protected. Reading browser version information does not create a tab.

Application upgrades activate `monitor` in restored main conversations and replace the former individual browser declarations with `browser`. This explicit upgrade changes the next request's tool declarations; it preserves saved conversation messages and the session's system-prompt snapshot. Routine turns continue to use the stable prompt.

Main and child agents write memory candidates into the workspace's `jottings/` directory. These notes are not injected as durable memory. The file-tool policy directs writes away from the long-term index, documents and global memory. A workspace curator reads changed notes and workspace conversation transcripts, selects durable facts, removes duplication and maintains `MEMORY.md` plus its documents. Global memory remains user-managed. Successful batches acknowledge only the input revisions they captured, so notes changed during a run remain pending; failures do not acknowledge inputs. Source notes remain available for review.

Automatic curation is enabled by default while the application is running: it runs at the configured turn threshold or after five minutes of workspace inactivity. Sibling main/child sessions share an idle coordinator, and a workspace file lease permits one curator process at a time. Successful batches drain pending inputs in bounded batches; no new inputs means no model call, and failed work is not retried in a loop. Users can disable automatic curation or run it manually. The memory panel provides a separate notes view and one provider/model configuration shared by all workspace curators; an unset selection explicitly follows the current conversation model.

New workspace memory directories use canonical path identities, keeping same-named folders isolated. Old directories with a verified owner remain in place for saved prompt compatibility. Ambiguous legacy directories remain untouched and are shown with an import notice instead of being assigned to a workspace automatically.

Mounted folders and browser partitions use the same canonical workspace identity, including symlinks and macOS `/var` aliases. The browser retains an existing alias cookie partition when no canonical partition exists, persisting that association. If both already exist, it selects the canonical partition and leaves the other data untouched; it never merges or overwrites login stores.

Named Claude and Codex subscription providers are initialized from the same account definitions for the main runtime, child sessions and headless memory workers. Account credentials stay under their own IDs in the existing auth store. Children initialize their local model catalog before restoring a saved selection and report unavailable models or credentials without switching accounts. Headless workers load the subscription extension before resolving their configured model.

## Operational diagnostics

Main, child and memory agents share metadata-only observers for model requests, responses and tool execution. Records include session/workspace identity, provider/model, elapsed time, provider-reported token/cache/cost usage, tool routing, parameter shapes and fingerprints, output size, and the preceding failed call for the same target. These failure associations support investigating parameter corrections without retaining the arguments. MCP adds backend invocation IDs, connection/reconnection/transport failures and returned-error results. Browser lifecycle, monitor wake/cancel and memory scheduling/completion events use the same diagnostic format.

Tool text token counts are explicitly estimates (`text_chars_div_4`), separate from model-reported usage; an MCP call generally does not report an exact model token charge. Byte measurements count string content and mark bounded traversal. Diagnostic records do not contain full model request bodies, prompts or tool results. Existing conversation JSONL remains the source transcript rather than being duplicated into diagnostic logs. Observers do not change model payloads or saved context.

Diagnostics rotate into gzip at 10 MiB, keep ordinary archives for 7 days and error mirrors for 30 days within a shared 256 MiB budget, and prioritize error history when trimming. Active writes and unfinished compression sources are protected. See [diagnostic retention and configuration](../packages/diagnostics/README.md) for recovery, privacy and size limits.

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
- Workflow tools remain Pi extensions; the activity panel visualizes goals, queued messages, and subagents.

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

This review applies equally to MCP, subagents, skills, memory, approvals, browser automation, background jobs, and future Agent tools.

Bundled extensions are still part of the CoilCoil runtime distribution. Extension-first does not mean loading packages from the user's local Pi installation.

## Pi thin fork

Pi is committed under `vendor/pi` through Git subtree. CoilCoil builds against that local source so desktop releases are reproducible and debuggable. Product-specific behavior remains outside the fork unless Pi's public SDK cannot provide a required runtime capability.
