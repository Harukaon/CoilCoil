# Pi upstream maintenance

CoilCoil carries a thin fork of Pi under `vendor/pi`.

- Upstream: `https://github.com/earendil-works/pi.git`
- Upstream branch: `main`
- Local remote name: `pi-upstream`
- Import method: Git subtree with squashed upstream history
- Current sync point: upstream `d981de122` ("Release v0.85.1", 2026-09-05),
  the `v0.85.1` tag. The previous one was `8fa7eebd2` (2026-08-25).
- The 2026-09-17 update was applied as `git diff <old> <new> | git apply -3
  --directory=vendor/pi`, not a subtree merge, because the tree had already lost
  its subtree history. Three-way apply carries the patches below across on its
  own and reports the rest as conflicts, which is what we want: only
  `agent-session.ts` conflicted.

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
- `packages/coding-agent/src/index.ts` also re-exports `AuthStorage` and
  `processImage`. CoilCoil's desktop app reads and writes provider credentials
  through Pi's own storage rather than a parallel credential store, and it runs
  pasted or dropped images through Pi's image pipeline so the runtime and the UI
  agree on size limits and formats.
- `packages/coding-agent/src/core/agent-session.ts` emits `session_start` after
  SDK reloads whenever an extension registered that lifecycle handler, even
  when the embedder has no TUI bindings. Extensions such as `pi-mcp-adapter`
  clean their state on `session_shutdown`; without the matching reload start
  event they remain uninitialized in headless AgentSession consumers.
- `packages/coding-agent/src/core/agent-session.ts` exposes
  `refreshModelFromRegistry()`, the public form of Pi's private
  `_refreshCurrentModelFromRegistry`. CoilCoil re-resolves the running session's
  model after `models.json` or an auth refresh changes underneath it, and must
  do so without appending a `model_change` session entry the way `setModel`
  does. Regression test:
  `packages/coding-agent/test/suite/agent-session-model-extension.test.ts`.

- `packages/coding-agent/src/core/agent-session.ts` adds an optional
  `summarizationModel` (and the `effectiveSummarizationModel` getter), used by
  manual compaction, automatic compaction and branch summarization in place of
  the hard-coded `this.model`. Summaries are separate, frequent, and large
  requests; CoilCoil lets the user run them on a cheap model while the
  conversation stays on an expensive one. Everything else about those requests
  is untouched — auth resolution, the embedder's stream function, retries and
  their progress events — which is why this is a property rather than a
  reimplementation of compaction inside an extension. Unset means Pi's own
  behaviour. Regression guard:
  `packages/runtime-core/tests/summarization-model.test.ts` asserts the getter
  still exists, because losing the patch in an upgrade would silently send the
  summaries back to the expensive model with the panel still claiming
  otherwise.
- `packages/coding-agent/src/core/settings-manager.ts` raises Pi's turn-retry
  defaults from 3 attempts / 2000 ms to 8 attempts / 1500 ms and adds a 30 s
  ceiling (`maxDelayMs`). An unstable gateway usually recovers, and giving up
  after three tries left the user resuming a half-finished run by hand; without
  a ceiling the doubling reaches minutes per attempt and reads as a hang.
- `packages/ai/src/utils/retry.ts` adds the wordings gateways use for a dropped
  upstream stream (`upstream_error`, `stream ended prematurely`, `premature
  close`, `ECONNRESET`, …). Pi's list only matched the origin providers' own
  phrasing, so a gateway failure ended the run outright instead of retrying.
- `packages/coding-agent/src/core/agent-session.ts` adds
  `_checkMidTurnCompaction()`, called from the `prepareNextTurnWithContext`
  hook. See "Mid-turn compaction" below for why we keep it over the upstream
  equivalent that landed in 0.85.0.

## Upstream features we deliberately do not take

### Mid-turn compaction (`_compactBeforeNextAssistantResponse`)

- Upstream added its own mid-turn compaction check in the same
  `prepareNextTurnWithContext` seam we had patched (the fix for
  earendil-works/pi#6879, which our patch comment cites). On the 2026-09-17
  pull we **removed upstream's method and its call** and kept CoilCoil's
  `_checkMidTurnCompaction`, so the two do not both fire at one threshold.
- The token source is nearly the same: upstream's `estimateContextTokens` also
  starts from the last assistant message's real usage and only estimates
  messages after it at chars/4. The difference is the guards. Ours additionally
  refuses to run when a compaction is already in flight, when the assistant
  message was aborted or errored, when the message came from a different
  provider/model than the session's current one, and — most importantly — when
  the message predates the latest compaction entry, whose usage still describes
  the pre-compaction conversation and would trigger an immediate second pass.
  Upstream's has none of these.
- Compaction is the area of CoilCoil the user has asked us most often to stop
  churning. Preserving the behaviour of the build they are running is worth more
  here than shedding a local patch.
- On the next pull: if upstream grows the same guards, drop our patch and take
  theirs. Otherwise keep removing theirs.

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
- Re-checked against `v0.85.1` (2026-09-17): still unfixed upstream, patch kept.

### Response-only `status` on replayed Responses input

- Added 2026-08-21. Patch: `packages/ai/src/api/openai-responses-shared.ts`
  (the assistant `message` item pushed by `convertResponsesMessages` no longer
  carries `status: "completed"`). Regression test: the final assertion in
  `packages/ai/test/openai-responses-message-id.test.ts`.
- Symptom: OpenAI-compatible gateways reject a replayed history because the
  input item carries a field only a response may have.
- Cause: `status` is required by the official SDK's `ResponseOutputMessage`
  type, so Pi sets it even though these items are request input, not output.
  The patch casts to `ResponseInputItem` instead.
- On the next pull: keep the patch unless upstream starts building these items
  as `ResponseInputItem`.
- Re-checked against `v0.85.1` (2026-09-17): still unfixed upstream, patch kept.

### Duplicate tool call id replayed to Anthropic-shaped endpoints

- Added 2026-09-07. Patch: `packages/ai/src/api/transform-messages.ts`
  (`claimToolCallId` in `transformMessages`). Regression test:
  `packages/ai/test/duplicate-tool-call-id-replay.test.ts`.
- Symptom: the mirror image of the Responses bug above. Providers on
  `openai-completions` restart their tool call ids at `call_0` every turn, and
  an Anthropic-shaped endpoint rejects the replayed history because each
  `tool_use` must have exactly one result.
- Cause: `transformMessages` replayed the stored ids verbatim; only the
  cross-provider *normalization* path rewrote them, so a same-shape replay kept
  the duplicates. The patch renames repeats and routes the following tool
  result to the renamed call through `toolCallIdMap`.
- Re-checked against `v0.85.1` (2026-09-17): still unfixed upstream, patch kept.

## Update from upstream

```bash
git fetch pi-upstream main
git subtree pull --prefix=vendor/pi pi-upstream main --squash
```

Before accepting an update, walk the "Upstream bugs we patch ourselves" list
above and re-check each entry against the incoming tree, then run Pi's own
checks as well as the CoilCoil runtime and workflow test suites.

If the tree is ever refreshed by copying upstream files over `vendor/pi` instead
of by a real subtree merge, **the files upstream deleted stay behind**. The
2026-08-25 sync left 35 of them, including the whole of `packages/storage`,
which upstream had renamed to `packages/session-backends`; a stale copy of a
renamed package is invisible to type-checking and only shows up later as a
confusing duplicate. After any such refresh, compare the file list against the
upstream commit and delete whatever upstream no longer has:

```bash
comm -13 <(git ls-tree -r <upstream-commit> --name-only | sort) \
         <(git ls-files vendor/pi | sed 's|^vendor/pi/||' | sort)
```

Everything it prints should be a documented CoilCoil patch file; the rest is
stale and must go.

## Why `build:pi` cleans first

CoilCoil depends on the vendored Pi packages through `file:` links, so the root
`npm ci` installs their devDependencies a second time into
`vendor/pi/packages/<pkg>/node_modules` even though Pi's own install already
hoisted them to `vendor/pi/node_modules`. Pi type-checks against the nested
copy, and two `@types/node` trees in one program collapse the global fetch
types: `Response` resolves to an empty type and `packages/agent/src/proxy.ts`
fails with "Property 'ok' does not exist on type 'Response'". The 2026-08-25
sync exposed this when upstream moved Pi from `@types/node` 24.12.4 to
22.19.19; before that the two trees happened to agree.

`npm run build:pi` therefore runs `scripts/clean-vendor-pi-nested-deps.mjs`
first, which deletes those nested copies. Pi builds from its own tree and never
needs them. If a Pi build ever fails on global web types again, check whether
`vendor/pi/packages/*/node_modules` came back.
