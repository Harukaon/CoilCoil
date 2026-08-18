# Runtime Core Architecture

`runtime-core` has a hard limit of 600 lines per source file. `npm run check` enforces the limit. A module approaching 500 lines should be split by responsibility before it reaches the limit; formatting or moving code into a catch-all barrel is not an architectural split.

## Public boundary

`src/index.ts` is a small public barrel. It exports only the runtime facade, its options, and the browser MCP configuration helpers. Internal modules import their real dependencies directly.

## Modules

- `runtime-base.ts` owns shared state and lifecycle initialization.
- `runtime-provider-*.ts` contains provider configuration, model settings, and authentication flows.
- `runtime-resources.ts` owns reloadable skills and runtime resources.
- `runtime-inspection-mcp.ts` and `runtime-mcp-config.ts` own runtime MCP state and persisted MCP configuration.
- `runtime-sessions.ts` owns session discovery, creation, opening, and archival operations.
- `runtime-tool-state.ts` projects persisted and live tool, plan, terminal, and subagent state.
- `runtime-session-events.ts` translates Pi session events into runtime protocol events.
- `runtime.ts` is the public orchestration facade for prompting, snapshots, project reads, and disposal.
- `*-helpers.ts`, `runtime-state.ts`, and `runtime-constants.ts` hold domain-specific pure helpers and shared types.

The stateful Pi session has one owner. Runtime layers extend in dependency order, and an earlier layer must not import a later layer. New independent behavior should be extracted into a helper or service instead of expanding the facade.
