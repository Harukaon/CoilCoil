# Pi upstream maintenance

CoilCoil carries a thin fork of Pi under `vendor/pi`.

- Upstream: `https://github.com/earendil-works/pi.git`
- Upstream branch: `main`
- Local remote name: `pi-upstream`
- Import method: Git subtree with squashed upstream history
- Current sync point: upstream `f07218c4d` (`v0.87.1`, 2026-09-22).
  The previous sync point was `16787ad5b` (`v0.87.0`).
- `v0.87.1` reports `claude-cli/2.1.280` on Anthropic OAuth requests,
  allowing models such as Opus 5.5 that reject the `2.1.251` identifier in
  `v0.87.0`.
- The generated Copilot model catalog can gain additional thinking levels over
  time. Its Opus 5.5 test checks for required levels without assuming the live
  catalog contains exactly five.
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

- `packages/coding-agent/src/core/system-prompt.ts` omits Pi's default
  `<docs>` section. It describes the embedded Pi package's SDK, examples, and
  documentation paths, not CoilCoil's own documentation. CoilCoil retains the
  `coilcoil` guide tool and all tool declarations. A full Anthropic OAuth Haiku
  request with 15 tools failed with Pi's `<docs>` section and succeeded when
  only that section was removed. Preserve this omission during Pi updates;
  `packages/coding-agent/test/system-prompt.test.ts` guards it.
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
  defaults from 3 attempts / 2000 ms to 8 attempts / 1500 ms and uses a 30 s
  ceiling (`maxAgentDelayMs` in Pi 0.87). An unstable gateway usually recovers, and giving up
  after three tries left the user resuming a half-finished run by hand; without
  a ceiling the doubling reaches minutes per attempt and reads as a hang.
- `packages/ai/src/utils/retry.ts` adds the wordings gateways use for a dropped
  upstream stream (`upstream_error`, `stream ended prematurely`, `premature
  close`, `ECONNRESET`, …). Pi's list only matched the origin providers' own
  phrasing, so a gateway failure ended the run outright instead of retrying.
- `packages/coding-agent/src/core/agent-session.ts` keeps Pi's canonical
  projection-based mid-turn compaction but adds guards for an already-running
  compaction, aborted/error responses, and model mismatch. See below.

## Upstream features we deliberately do not take

### Mid-turn compaction (`_compactBeforeNextAssistantResponse`)

- In v0.87.0 upstream's canonical session projection includes oversized tool
  results and steering that arrived during compaction. Our older
  `_checkMidTurnCompaction` looked only at assistant usage and failed upstream's
  regression tests for both cases, so it was removed during this sync.
- We retained the guards against overlapping compaction, aborted/error assistant
  messages and a provider/model mismatch inside upstream's projection-based
  method. The projection is built from the persisted branch, which also avoids
  estimating against pre-compaction assistant usage.
- On the next pull, check whether upstream adds these guards and drop the local
  additions if it does.

## Upstream bugs we patch ourselves

These are Pi defects, not CoilCoil behavior. Each one is carried until upstream
fixes it, so **check the upstream status of every entry before accepting a
subtree pull** and drop the patch once the fix lands there.

### Compaction summaries: not patched here any more

- 2026-09-28: the two compaction patches (bounded/chunked summary input, retry of
  length-limited history summaries) were removed. Pi's compaction code is
  upstream again.
- CoilCoil writes the compaction content itself through Pi's
  `session_before_compact` hook: `packages/workflow/extensions/compaction.ts`
  (design: `docs/compaction.md`). Pi still decides when to compact, where to cut
  (`keepRecentTokens`) and persists the result.
- Upstream issues for the same failure: earendil-works/pi#8196 and #8371 (both
  closed as not planned). If upstream ever bounds summary input, nothing here
  needs to change; our extension answers the hook before Pi's own summarizer runs.

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
