# Pi upstream maintenance

SuoCode carries a thin fork of Pi under `vendor/pi`.

- Upstream: `https://github.com/earendil-works/pi.git`
- Upstream branch: `main`
- Local remote name: `pi-upstream`
- Import method: Git subtree with squashed upstream history

The initial import intentionally contains no SuoCode-specific Pi changes.
Product behavior should remain in SuoCode packages whenever Pi's public SDK or
extension APIs are sufficient. Changes belong in `vendor/pi` only when the
embedded runtime requires a capability that cannot be implemented outside Pi.

## SuoCode thin patches

- `packages/coding-agent/src/index.ts` re-exports Pi's existing HTTP dispatcher
  helper for SDK embedders. The CLI and RPC entry points already invoke this
  helper; SuoCode invokes the same implementation before embedded provider SDKs
  make requests, preserving Pi's proxy, timeout, HTTP/2 and Undici error
  handling instead of maintaining a second network stack.
- `packages/coding-agent/src/core/agent-session.ts` emits `session_start` after
  SDK reloads whenever an extension registered that lifecycle handler, even
  when the embedder has no TUI bindings. Extensions such as `pi-mcp-adapter`
  clean their state on `session_shutdown`; without the matching reload start
  event they remain uninitialized in headless AgentSession consumers.

## Update from upstream

```bash
git fetch pi-upstream main
git subtree pull --prefix=vendor/pi pi-upstream main --squash
```

Before accepting an update, run Pi's own checks as well as the SuoCode runtime
and workflow test suites.
