# CoilCoil CLI

CoilCoil CLI is the terminal surface for the shared CoilCoil runtime. It supports saved sessions, model selection, streaming responses, tool activity, steering, and aborting a run.

From the repository root:

```bash
npm run cli -- /absolute/path/to/project
```

Useful commands inside the CLI are `/new`, `/sessions`, `/open`, `/model`, `/abort`, `/help`, and `/exit`.
Use `npm run cli -- --help` for startup options, including provider, model, API key, and thinking level.

Other agents can use the running Desktop or CLI's configured MCP servers through `coilcoil mcp`:

```bash
npm run --silent cli -- mcp docs
npm run --silent cli -- mcp list --cwd /absolute/path/to/project
npm run --silent cli -- mcp tools <server> --cwd /absolute/path/to/project
npm run --silent cli -- mcp call <server> <tool> --cwd /absolute/path/to/project --args '{"query":"example"}'
```

`mcp docs` prints a short integration guide and `mcp --help` shows the command reference; both work without a running runtime. MCP access commands return JSON and do not start a model or a new chat. `mcp instances` lists running processes; use `--instance <id>` when more than one is running. After building, `node apps/cli/dist/mcp.js ...` is the standalone client and `coilcoil-mcp` is its package executable.

See [MCP runtime access](../../docs/mcp-runtime-access.md) for Desktop's bundled executable, project and session selection, arguments from files, and the local RPC contract.
