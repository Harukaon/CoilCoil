# Pi upstream maintenance

CoilCoil carries a thin fork of Pi under `vendor/pi`.

- Upstream: `https://github.com/earendil-works/pi.git`
- Upstream branch: `main`
- Local remote name: `pi-upstream`
- Import method: Git subtree with squashed upstream history

The initial import intentionally contains no CoilCoil-specific Pi changes.
Product behavior should remain in CoilCoil packages whenever Pi's public SDK or
extension APIs are sufficient. Changes belong in `vendor/pi` only when the
embedded runtime requires a capability that cannot be implemented outside Pi.

## CoilCoil thin patches

- `packages/coding-agent/src/index.ts` re-exports Pi's existing HTTP dispatcher
  helper for SDK embedders. The CLI and RPC entry points already invoke this
  helper; CoilCoil invokes the same implementation before embedded provider SDKs
  make requests, preserving Pi's proxy, timeout, HTTP/2 and Undici error
  handling instead of maintaining a second network stack.
- `packages/coding-agent/src/core/agent-session.ts` emits `session_start` after
  SDK reloads whenever an extension registered that lifecycle handler, even
  when the embedder has no TUI bindings. Extensions such as `pi-mcp-adapter`
  clean their state on `session_shutdown`; without the matching reload start
  event they remain uninitialized in headless AgentSession consumers.

## Upstream bugs we patch ourselves

These are Pi defects, not CoilCoil behavior. Each one is carried until upstream
fixes it, so **check the upstream status of every entry before accepting a
subtree pull** and drop the patch once the fix lands there.

### Duplicate `call_id` when replaying a chat-completions history to Responses

- Added 2026-08-20. Patch: `packages/ai/src/api/openai-responses-shared.ts`
  (`claimCallId` / `resolveCallId` in `convertResponsesMessages`). Regression
  test: `packages/ai/test/openai-responses-duplicate-call-id.test.ts`.
- Symptom: `invalid function_call at input[12]: duplicate call_id "call_0"
  already used at input[3]`. Every later turn of the session fails the same way,
  and compaction does not reliably clear it — `firstKeptEntryId` can retain the
  offending turns.
- Cause: providers on `openai-completions` (DeepSeek and friends) number their
  tool calls per response, so each assistant turn hands out `call_0` again.
  `convertResponsesMessages` replayed those ids verbatim, and the Responses API
  validates call id uniqueness across the whole input. CoilCoil hits this on any
  session that switches mid-way from a completions model to a Responses model,
  which the model picker makes a one-click action.
- Upstream status when written: no issue filed, and `main` still had no
  cross-input uniqueness check. Upstream already fixed the neighbours —
  earendil-works/pi#6796 → PR #6854 (same bug in the Responses → completions
  direction) and #5151 (duplicate `msg_*` item ids in this same function) — so
  the patch is shaped to be cherry-picked upstream as-is.
- On the next pull: if `convertResponsesMessages` now keeps call ids unique
  across the input, drop our patch and keep the regression test if it still
  compiles. Otherwise re-apply. If we upstream it, link the issue and PR here.

## Update from upstream

```bash
git fetch pi-upstream main
git subtree pull --prefix=vendor/pi pi-upstream main --squash
```

Before accepting an update, walk the "Upstream bugs we patch ourselves" list
above and re-check each entry against the incoming tree, then run Pi's own
checks as well as the CoilCoil runtime and workflow test suites.
